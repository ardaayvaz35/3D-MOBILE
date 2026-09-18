import ARKit
import AVFoundation
import CoreImage

/// Window pass: single, deliberate photos of the view through a window,
/// instead of the continuous LiDAR recording.
///
/// The room scan locks exposure to the interior, so every window in it is
/// blown out -- the view is 50-100x brighter than the room. Here the user
/// taps the outside to meter on it, and each press takes three shots at
/// -1.5 / 0 / +1.5 EV so the server can fuse them. Every shot keeps its
/// ARKit pose: the view is treated as infinitely far away, so only the
/// camera's rotation matters and gravity (ARKit's +y) fixes pitch and roll.
///
/// Output: a zip holding the JPEGs and shots.json (camera-to-world in ARKit's
/// world, intrinsics at the saved resolution, exposure per shot).
final class WindowShotSession {
    struct Shot {
        let group: Int
        let evBias: Float
        let file: String
        let transform: simd_float4x4
        let intrinsics: simd_float3x3
        let width: Int
        let height: Int
        let exposureDuration: Double
        let iso: Float
        let highRes: Bool
        let timestamp: TimeInterval
    }

    static let evSteps: [Float] = [-1.5, 0, 1.5]
    private static let jpegQuality: Double = 0.92

    private let host = ArkitSessionHost.shared
    private let dir: URL
    private let ciContext = CIContext()
    private var shots: [Shot] = []
    private var groups = 0

    init() {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("window_pass_\(UUID().uuidString.prefix(8))")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        host.setWindowMode(true)
    }

    var groupCount: Int { groups }

    /// One press: three exposures, each saved with the pose it was taken at.
    /// Runs on a background queue; `completion` gets the group count or an error.
    func captureGroup(completion: @escaping (Result<Int, Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let group = self.groups
            var taken = 0
            var lastError: Error?
            let base = self.host.currentExposure()
            for ev in Self.evSteps {
                self.host.applyExposure(base: base, evBias: ev)
                // Let a few frames at the new exposure through before taking one.
                Thread.sleep(forTimeInterval: 0.25)
                switch self.captureOne(group: group, ev: ev) {
                case .success: taken += 1
                case .failure(let e): lastError = e
                }
            }
            self.host.resumeAutoExposure()
            if taken == 0 {
                completion(.failure(lastError ?? NSError(domain: "WindowShot", code: 1)))
                return
            }
            self.groups += 1
            completion(.success(self.groups))
        }
    }

    private func captureOne(group: Int, ev: Float) -> Result<Void, Error> {
        let sem = DispatchSemaphore(value: 0)
        var result: Result<Void, Error> = .failure(NSError(domain: "WindowShot", code: 2))
        let save: (ARFrame, Bool) -> Void = { frame, highRes in
            result = self.write(frame: frame, group: group, ev: ev, highRes: highRes)
        }
        if #available(iOS 16.0, *), host.windowHighResAvailable {
            host.session.captureHighResolutionFrame { frame, error in
                if let frame = frame {
                    save(frame, true)
                } else if let cur = self.host.session.currentFrame {
                    save(cur, false)
                } else if let error = error {
                    result = .failure(error)
                }
                sem.signal()
            }
            sem.wait()
        } else if let cur = host.session.currentFrame {
            save(cur, false)
        }
        return result
    }

    private func write(frame: ARFrame, group: Int, ev: Float, highRes: Bool) -> Result<Void, Error> {
        let image = CIImage(cvPixelBuffer: frame.capturedImage)
        let name = String(format: "shot_%03d_ev%+.1f.jpg", group, ev)
        guard let jpeg = ciContext.jpegRepresentation(
            of: image,
            colorSpace: image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): Self.jpegQuality]
        ) else {
            return .failure(NSError(domain: "WindowShot", code: 3))
        }
        do {
            try jpeg.write(to: dir.appendingPathComponent(name))
        } catch {
            return .failure(error)
        }
        shots.append(Shot(
            group: group, evBias: ev, file: name,
            transform: frame.camera.transform,
            intrinsics: frame.camera.intrinsics,
            width: Int(image.extent.width), height: Int(image.extent.height),
            exposureDuration: frame.camera.exposureDuration,
            iso: host.currentISO(),
            highRes: highRes, timestamp: frame.timestamp))
        return .success(())
    }

    /// Writes shots.json, zips the folder, and hands back the zip's path.
    func finish() throws -> (path: String, shots: Int, groups: Int) {
        host.setWindowMode(false)
        let metas: [[String: Any]] = shots.map { s in
            let m = s.transform
            let k = s.intrinsics
            return [
                "group": s.group,
                "ev_bias": s.evBias,
                "image_path": s.file,
                // Camera-to-world in ARKit's world (y up, camera looks down -z),
                // laid out exactly like metadata.json of a LiDAR scan: one inner
                // array per simd column, translation in the last.
                "camera_transform": (0..<4).map { c in (0..<4).map { r in m[c][r] } },
                "camera_intrinsics": [k[0][0], k[1][1], k[2][0], k[2][1]],
                "image_width": s.width,
                "image_height": s.height,
                "exposure_duration": s.exposureDuration,
                "iso": s.iso,
                "high_res": s.highRes,
                "timestamp_ns": Int(s.timestamp * 1_000_000_000),
            ]
        }
        let meta: [String: Any] = [
            "client_type": "ios_window_pass",
            "version": 1,
            "ev_steps": Self.evSteps,
            "groups": groups,
            "shots": metas,
        ]
        let json = try JSONSerialization.data(withJSONObject: meta, options: .prettyPrinted)
        try json.write(to: dir.appendingPathComponent("shots.json"))

        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent("window_\(UUID().uuidString.prefix(8)).zip")
        let coordinator = NSFileCoordinator()
        var coordError: NSError?
        var innerError: Error?
        coordinator.coordinate(readingItemAt: dir, options: [.forUploading], error: &coordError) { zipped in
            do {
                try FileManager.default.copyItem(at: zipped, to: dest)
            } catch {
                innerError = error
            }
        }
        if let e = coordError { throw e }
        if let e = innerError { throw e }
        try? FileManager.default.removeItem(at: dir)
        return (dest.path, shots.count, groups)
    }

    func cancel() {
        host.setWindowMode(false)
        try? FileManager.default.removeItem(at: dir)
    }
}
