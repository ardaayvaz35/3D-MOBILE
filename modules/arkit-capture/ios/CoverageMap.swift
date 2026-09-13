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
///   blue   -- meshed by ARKit but no GOOD view of it yet
///   orange -- one good view
///   yellow -- two good views
///   green  -- `goodDirections` or more good views
///
/// "Good" is decided per depth sample, with the same criteria the server
/// applies when it decides what to train on, so green here means the server
/// will actually have usable data there:
///   * the frame itself passed the motion-blur gate (only kept frames arrive);
///   * LiDAR confidence at least medium (the server masks below that);
///   * range `minRange`..`maxRange`: too far is too coarse, too close is a hand;
///   * not a grazing view: the ray must hit the surface within
///     `maxGrazingDegrees` of its normal, estimated from neighbouring depth
///     samples. Grazing views are where the glossy-wardrobe streaks came from.
///
/// ARKit's mesh covers a wall the moment the phone sweeps past it, however
/// fast; that used to read as "scanned". The mesh now stays blue until the
/// data behind it is good, which is the whole point.
///
/// Space is a sparse 10 cm voxel grid over world points unprojected from each
/// kept frame's LiDAR depth. Per voxel a 48-bit mask records the directions it
/// was seen from: 16 azimuth sectors (22.5 deg) x 3 elevation bands of the
/// vector from the surface back to the camera. Three sectors, i.e. about 45
/// degrees of parallax, is enough for the optimiser to pin the surface; the
/// earlier 45-degree sectors made green need a 90-degree walk around every
/// point, which nobody managed for a ceiling.
final class CoverageMap {
    static let voxelSize: Float = 0.10
    static let minRange: Float = 0.3
    /// Beyond this, LiDAR depth is too sparse and noisy to count as "seen".
    static let maxRange: Float = 3.0
    static let goodDirections = 3
    static let maxGrazingDegrees: Float = 65
    private static let minCosIncidence = cos(maxGrazingDegrees * Float.pi / 180)
    /// Every Nth depth pixel. At 2 m this is one sample per ~6 cm, finer than
    /// a voxel, for ~1.4k points a frame.
    private static let sampleStep = 6

    private var cells: [Int64: UInt64] = [:]
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

        var updates: [(Int64, UInt64)] = []
        updates.reserveCapacity((w / Self.sampleStep + 1) * (h / Self.sampleStep + 1))

        // Depth at (u, v), or nil when missing / out of range.
        func depth(_ u: Int, _ v: Int) -> Float? {
            guard u >= 0, v >= 0, u < w, v < h else { return nil }
            let d = depthBase.loadUnaligned(fromByteOffset: v * depthRow + u * 4, as: Float32.self)
            guard d.isFinite, d > Self.minRange, d < Self.maxRange else { return nil }
            return d
        }
        // Pinhole in image coordinates (u right, v down), into ARKit's camera
        // frame (+X right, +Y up, -Z forward).
        func unproject(_ u: Int, _ v: Int, _ d: Float) -> simd_float3 {
            simd_float3((Float(u) - cx) * d / fx, -(Float(v) - cy) * d / fy, -d)
        }

        // Normal from a small neighbourhood, in camera space; nil across a
        // depth edge, where a normal means nothing.
        let n = 2
        for v in stride(from: Self.sampleStep / 2, to: h, by: Self.sampleStep) {
            for u in stride(from: Self.sampleStep / 2, to: w, by: Self.sampleStep) {
                guard let d = depth(u, v) else { continue }
                if let cb = confBase,
                   cb.loadUnaligned(fromByteOffset: v * confRow + u, as: UInt8.self) < 1 {
                    continue
                }
                guard let dr = depth(u + n, v), let dd = depth(u, v + n),
                      abs(dr - d) < 0.05, abs(dd - d) < 0.05 else { continue }
                let pc = unproject(u, v, d)
                let normal = simd_cross(unproject(u + n, v, dr) - pc, unproject(u, v + n, dd) - pc)
                let nLen = simd_length(normal)
                guard nLen > 1e-9 else { continue }
                // Incidence: angle between the view ray and the surface normal.
                let ray = pc / simd_length(pc)
                guard abs(simd_dot(normal / nLen, ray)) >= Self.minCosIncidence else { continue }

                let world = cameraTransform * simd_float4(pc, 1)
                let p = simd_float3(world.x, world.y, world.z)
                guard let key = Self.key(p) else { continue }

                let toCamera = camera - p
                let len = simd_length(toCamera)
                guard len > 1e-4 else { continue }
                let dir = toCamera / len
                let azimuth = (atan2(dir.x, dir.z) + Float.pi) / (2 * Float.pi)
                let azBin = min(15, max(0, Int(azimuth * 16)))
                let elBin = dir.y < -0.35 ? 0 : (dir.y > 0.35 ? 2 : 1)
                updates.append((key, UInt64(1) << UInt64(elBin * 16 + azBin)))
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

    /// Drawn as a filled, half-transparent surface (see ArkitPreviewView), so
    /// the alpha here is what keeps the camera image visible underneath.
    private static func color(forDirections n: Int) -> (Float, Float, Float, Float) {
        if n >= goodDirections { return (0.20, 0.90, 0.40, 0.50) }
        if n == 2 { return (1.00, 0.90, 0.15, 0.50) }
        if n == 1 { return (1.00, 0.50, 0.10, 0.50) }
        return (0.30, 0.50, 1.00, 0.50)
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
