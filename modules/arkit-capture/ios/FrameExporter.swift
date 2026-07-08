import Foundation
import simd

/// Exports captured frames to a compressed tar.gz archive with a metadata.json
/// that matches the 3D scanner backend's expected schema (client_type: ios_lidar).
class FrameExporter {

    func export(frames: [CaptureManager.FrameData], to url: URL) throws {
        let workDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("export_\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)

        var frameMetas: [[String: Any]] = []

        for frame in frames {
            let rgbFile = URL(fileURLWithPath: frame.rgbPath)
            let rgbDest = workDir.appendingPathComponent(rgbFile.lastPathComponent)
            try? FileManager.default.copyItem(atPath: frame.rgbPath, toPath: rgbDest.path)

            let depthFile = URL(fileURLWithPath: frame.depthPath)
            let depthDest = workDir.appendingPathComponent(depthFile.lastPathComponent)
            try? FileManager.default.copyItem(atPath: frame.depthPath, toPath: depthDest.path)

            let confFile = URL(fileURLWithPath: frame.confidencePath)
            let confDest = workDir.appendingPathComponent(confFile.lastPathComponent)
            try? FileManager.default.copyItem(atPath: frame.confidencePath, toPath: confDest.path)

            let intrinsics = frame.intrinsics
            frameMetas.append([
                "frame_id": frame.index,
                "timestamp_ns": Int(frame.timestamp * 1_000_000_000),
                "image_path": rgbFile.lastPathComponent,
                "depth_path": depthFile.lastPathComponent,
                "confidence_path": confFile.lastPathComponent,
                "camera_intrinsics": [
                    intrinsics[0, 0], intrinsics[1, 1],
                    intrinsics[2, 0], intrinsics[2, 1],
                ],
                "camera_transform": matrix4x4ToArray(frame.transform),
                "image_width": 1920,
                "image_height": 1440,
            ])
        }

        let metadata: [String: Any] = [
            "frames": frameMetas,
            "client_type": "ios_lidar",
            "metadata": [
                "device_model": deviceModel(),
                "has_lidar": true,
                "total_frames": frames.count,
                "duration_seconds": round((frames.last?.timestamp ?? 0) - (frames.first?.timestamp ?? 0)),
            ],
        ]

        let metaJSON = workDir.appendingPathComponent("metadata.json")
        let jsonData = try JSONSerialization.data(withJSONObject: metadata, options: .prettyPrinted)
        try jsonData.write(to: metaJSON)

        try createTarGz(from: workDir, to: url.path)
        try? FileManager.default.removeItem(at: workDir)
    }

    private func createTarGz(from dir: URL, to archivePath: String) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        task.arguments = ["-czf", archivePath, "-C", dir.path, "."]
        try task.run()
        task.waitUntilExit()
        if task.terminationStatus != 0 {
            throw NSError(domain: "FrameExporter", code: Int(task.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: "tar exited with status \(task.terminationStatus)"
            ])
        }
    }

    private func deviceModel() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        return mirror.children.reduce("") { id, element in
            guard let value = element.value as? Int8, value != 0 else { return id }
            return id + String(UnicodeScalar(UInt8(value)))
        }
    }

    private func matrix4x4ToArray(_ m: simd_float4x4) -> [[Float]] {
        return [
            [m[0, 0], m[0, 1], m[0, 2], m[0, 3]],
            [m[1, 0], m[1, 1], m[1, 2], m[1, 3]],
            [m[2, 0], m[2, 1], m[2, 2], m[2, 3]],
            [m[3, 0], m[3, 1], m[3, 2], m[3, 3]],
        ]
    }
}
