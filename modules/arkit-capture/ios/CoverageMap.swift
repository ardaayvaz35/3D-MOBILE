import ARKit
import simd

/// Which parts of the room have been seen well enough, tracked live while
/// scanning so the mesh overlay can show it (Polycam-style heat map).
///
/// A tour can only render a surface well if the kept frames saw it from
/// several directions. Seen from one direction, the optimiser is free to put
/// the surface anywhere along that view ray, which is exactly the streaks and
/// holes a visitor notices from everywhere else. The user cannot judge this
/// by eye while scanning; the colours make it visible:
///
///   red    -- meshed by ARKit but in no kept frame
///   yellow -- kept frames saw it from only one or two directions
///   green  -- seen from `goodDirections` or more
///
/// Space is a sparse 10 cm voxel grid over world points unprojected from each
/// kept frame's LiDAR depth. Per voxel a 24-bit mask records the directions it
/// was seen from: 8 azimuth sectors x 3 elevation bands of the vector from the
/// surface back to the camera.
final class CoverageMap {
    static let voxelSize: Float = 0.10
    /// Beyond this, LiDAR depth is too sparse and noisy to count as "seen".
    static let maxRange: Float = 4.0
    static let goodDirections = 3
    /// Every Nth depth pixel. At 2 m this is one sample per ~6 cm, finer than
    /// a voxel, for ~1.4k points a frame.
    private static let sampleStep = 6

    private var cells: [Int64: UInt32] = [:]
    private let lock = NSLock()

    func reset() {
        lock.lock()
        cells.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    /// Record one kept frame. `intrinsics` are for the full captured image;
    /// they are rescaled onto the depth grid here.
    func integrate(depthMap: CVPixelBuffer,
                   confidenceMap: CVPixelBuffer?,
                   intrinsics: simd_float3x3,
                   imageResolution: CGSize,
                   cameraTransform: simd_float4x4) {
        let w = CVPixelBufferGetWidth(depthMap)
        let h = CVPixelBufferGetHeight(depthMap)
        guard w > 0, h > 0, imageResolution.width > 0, imageResolution.height > 0,
              CVPixelBufferGetPixelFormatType(depthMap) == kCVPixelFormatType_DepthFloat32
        else { return }

        let sx = Float(w) / Float(imageResolution.width)
        let sy = Float(h) / Float(imageResolution.height)
        let fx = intrinsics[0][0] * sx
        let fy = intrinsics[1][1] * sy
        let cx = intrinsics[2][0] * sx
        let cy = intrinsics[2][1] * sy
        let camera = simd_float3(cameraTransform.columns.3.x,
                                 cameraTransform.columns.3.y,
                                 cameraTransform.columns.3.z)

        var conf: CVPixelBuffer? = nil
        if let c = confidenceMap, CVPixelBufferGetWidth(c) == w, CVPixelBufferGetHeight(c) == h {
            conf = c
        }

        CVPixelBufferLockBaseAddress(depthMap, .readOnly)
        if let c = conf { CVPixelBufferLockBaseAddress(c, .readOnly) }
        defer {
            CVPixelBufferUnlockBaseAddress(depthMap, .readOnly)
            if let c = conf { CVPixelBufferUnlockBaseAddress(c, .readOnly) }
        }
        guard let depthBase = CVPixelBufferGetBaseAddress(depthMap) else { return }
        let depthRow = CVPixelBufferGetBytesPerRow(depthMap)
        let confBase = conf.flatMap { CVPixelBufferGetBaseAddress($0) }
        let confRow = conf.map { CVPixelBufferGetBytesPerRow($0) } ?? 0

        var updates: [(Int64, UInt32)] = []
        updates.reserveCapacity((w / Self.sampleStep + 1) * (h / Self.sampleStep + 1))

        for v in stride(from: Self.sampleStep / 2, to: h, by: Self.sampleStep) {
            for u in stride(from: Self.sampleStep / 2, to: w, by: Self.sampleStep) {
                let d = depthBase.loadUnaligned(fromByteOffset: v * depthRow + u * 4, as: Float32.self)
                guard d.isFinite, d > 0.2, d < Self.maxRange else { continue }
                if let cb = confBase,
                   cb.loadUnaligned(fromByteOffset: v * confRow + u, as: UInt8.self) < 1 {
                    continue
                }
                // Pinhole in image coordinates (u right, v down), into ARKit's
                // camera frame (+X right, +Y up, -Z forward).
                let x = (Float(u) - cx) * d / fx
                let y = -(Float(v) - cy) * d / fy
                let world = cameraTransform * simd_float4(x, y, -d, 1)
                let p = simd_float3(world.x, world.y, world.z)
                guard let key = Self.key(p) else { continue }

                let toCamera = camera - p
                let len = simd_length(toCamera)
                guard len > 1e-4 else { continue }
                let dir = toCamera / len
                let azimuth = (atan2(dir.x, dir.z) + Float.pi) / (2 * Float.pi)
                let azBin = min(7, max(0, Int(azimuth * 8)))
                let elBin = dir.y < -0.35 ? 0 : (dir.y > 0.35 ? 2 : 1)
                updates.append((key, UInt32(1) << UInt32(elBin * 8 + azBin)))
            }
        }

        lock.lock()
        for (key, bit) in updates {
            cells[key, default: 0] |= bit
        }
        lock.unlock()
    }

    /// Per-vertex RGBA (Float32) for one mesh anchor's vertices, read from a
    /// COPY of the vertex buffer: ARKit reuses and overwrites its own.
    func vertexColors(vertexData: Data, offset: Int, stride: Int, count: Int,
                      anchorTransform: simd_float4x4) -> Data {
        var rgba = [Float](repeating: 0, count: count * 4)
        lock.lock()
        vertexData.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for i in 0..<count {
                let o = offset + i * stride
                guard o + 12 <= raw.count else { break }
                let local = simd_float4(raw.loadUnaligned(fromByteOffset: o, as: Float.self),
                                        raw.loadUnaligned(fromByteOffset: o + 4, as: Float.self),
                                        raw.loadUnaligned(fromByteOffset: o + 8, as: Float.self),
                                        1)
                let world = anchorTransform * local
                var seen = 0
                if let key = Self.key(simd_float3(world.x, world.y, world.z)) {
                    seen = cells[key]?.nonzeroBitCount ?? 0
                }
                let c = Self.color(forDirections: seen)
                rgba[i * 4] = c.0
                rgba[i * 4 + 1] = c.1
                rgba[i * 4 + 2] = c.2
                rgba[i * 4 + 3] = c.3
            }
        }
        lock.unlock()
        return rgba.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    private static func color(forDirections n: Int) -> (Float, Float, Float, Float) {
        if n >= goodDirections { return (0.30, 0.90, 0.45, 0.85) }
        if n > 0 { return (1.00, 0.80, 0.20, 0.85) }
        return (1.00, 0.30, 0.30, 0.85)
    }

    /// 21 bits per axis: unique within +/-100 km of the session origin.
    private static func key(_ p: simd_float3) -> Int64? {
        guard p.x.isFinite, p.y.isFinite, p.z.isFinite else { return nil }
        let ix = Int64((p.x / voxelSize).rounded(.down)) & 0x1FFFFF
        let iy = Int64((p.y / voxelSize).rounded(.down)) & 0x1FFFFF
        let iz = Int64((p.z / voxelSize).rounded(.down)) & 0x1FFFFF
        return (ix << 42) | (iy << 21) | iz
    }
}
