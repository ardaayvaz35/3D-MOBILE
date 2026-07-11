import Foundation
import simd

/// Exports captured frames to a compressed tar.gz archive with a metadata.json
/// that matches the 3D scanner backend's expected schema (client_type: ios_lidar).
class FrameExporter {

    func export(frames: [CaptureManager.FrameData],
                meshVertices: [simd_float3] = [],
                to url: URL) throws {
        let workDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("export_\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)

        // Write the fused LiDAR mesh as a binary PLY point cloud (the splat
        // init seed). Empty string in metadata if the scan produced no mesh.
        var meshName = ""
        if !meshVertices.isEmpty {
            meshName = "mesh.ply"
            try writeBinaryPLY(vertices: meshVertices,
                               to: workDir.appendingPathComponent(meshName))
        }

        var frameMetas: [[String: Any]] = []

        for frame in frames {
            let rgbFile = URL(fileURLWithPath: frame.rgbPath)
            let rgbDest = workDir.appendingPathComponent(rgbFile.lastPathComponent)
            try? FileManager.default.copyItem(atPath: frame.rgbPath, toPath: rgbDest.path)

            // Depth/confidence are no longer persisted (COLMAP path uses RGB
            // only); copy + reference them only if present.
            var depthName = ""
            if !frame.depthPath.isEmpty {
                let depthFile = URL(fileURLWithPath: frame.depthPath)
                depthName = depthFile.lastPathComponent
                try? FileManager.default.copyItem(atPath: frame.depthPath,
                                                  toPath: workDir.appendingPathComponent(depthName).path)
            }

            var confName = ""
            if !frame.confidencePath.isEmpty {
                let confFile = URL(fileURLWithPath: frame.confidencePath)
                confName = confFile.lastPathComponent
                try? FileManager.default.copyItem(atPath: frame.confidencePath,
                                                  toPath: workDir.appendingPathComponent(confName).path)
            }

            let intrinsics = frame.intrinsics
            frameMetas.append([
                "frame_id": frame.index,
                "timestamp_ns": Int(frame.timestamp * 1_000_000_000),
                "image_path": rgbFile.lastPathComponent,
                "depth_path": depthName,
                "confidence_path": confName,
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
            "mesh_path": meshName,
            "metadata": [
                "device_model": deviceModel(),
                "has_lidar": true,
                "total_frames": frames.count,
                "mesh_vertex_count": meshVertices.count,
                "duration_seconds": round((frames.last?.timestamp ?? 0) - (frames.first?.timestamp ?? 0)),
            ],
        ]

        let metaJSON = workDir.appendingPathComponent("metadata.json")
        let jsonData = try JSONSerialization.data(withJSONObject: metadata, options: .prettyPrinted)
        try jsonData.write(to: metaJSON)

        try createZip(from: workDir, to: url)
        try? FileManager.default.removeItem(at: workDir)
    }

    /// Zip a directory on iOS. `Process`/`/usr/bin/tar` do NOT exist on iOS
    /// (macOS-only), so we use NSFileCoordinator's `.forUploading` option,
    /// which produces a .zip of the coordinated directory. The resulting zip
    /// wraps the contents in a top-level folder (the workDir's name); the
    /// backend's extraction resolves that single wrapper folder automatically.
    private func createZip(from dir: URL, to dest: URL) throws {
        let coordinator = NSFileCoordinator()
        var coordError: NSError?
        var innerError: Error?
        coordinator.coordinate(readingItemAt: dir, options: [.forUploading], error: &coordError) { (zippedURL) in
            do {
                if FileManager.default.fileExists(atPath: dest.path) {
                    try FileManager.default.removeItem(at: dest)
                }
                try FileManager.default.copyItem(at: zippedURL, to: dest)
            } catch {
                innerError = error
            }
        }
        if let e = coordError { throw e }
        if let e = innerError { throw e }
    }

    /// Write a binary little-endian PLY point cloud (x,y,z float32 +
    /// r,g,b uint8). ARMeshAnchor carries no vertex colour, so we seed a
    /// neutral grey -- splatfacto learns real colour from the RGB frames
    /// during training; the init colour only affects the very first iters.
    private func writeBinaryPLY(vertices: [simd_float3], to url: URL) throws {
        var header = "ply\n"
        header += "format binary_little_endian 1.0\n"
        header += "element vertex \(vertices.count)\n"
        header += "property float x\nproperty float y\nproperty float z\n"
        header += "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        header += "end_header\n"

        var data = Data(header.utf8)
        data.reserveCapacity(data.count + vertices.count * 15)
        let grey: [UInt8] = [180, 180, 180]
        for v in vertices {
            var x = v.x, y = v.y, z = v.z
            withUnsafeBytes(of: &x) { data.append(contentsOf: $0) }
            withUnsafeBytes(of: &y) { data.append(contentsOf: $0) }
            withUnsafeBytes(of: &z) { data.append(contentsOf: $0) }
            data.append(contentsOf: grey)
        }
        try data.write(to: url)
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
