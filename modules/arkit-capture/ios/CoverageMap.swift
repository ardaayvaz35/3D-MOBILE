import ARKit
import simd

/// Which parts of the room will look right in the tour, tracked live while
/// scanning so the mesh overlay can show it.
///
///   green -- the viewer will render this surface well
///   blue  -- not yet (unseen, or seen but not well enough)
///   gray  -- the LiDAR cannot measure it (glass, mirror, glossy, very dark);
///            more filming will not turn it green, so the user can move on
///
/// Calibrated offline on scan 158a72c2 against the real render error of the
/// published tour (scratchpad `calib_green.py`, `sim_green.py`). The previous
/// rule ("seen from >= 3 of 48 directions") was green on 89% of the surface
/// and its green areas had HIGHER error than the rest, so it said nothing.
///
/// Green needs both of the two things that predicted error:
///   1. LiDAR confidence: mean confidence of the cell's samples >= `greenConfidence`.
///      This was the strongest single predictor (confidence < 1.25 -> error 19.5,
///      >= 1.95 -> 7.7).
///   2. Angle coverage for the VISITOR, not for the phone. The viewer keeps the
///      visitor within `walkRadius` of the scanned path at eye height, looking
///      anywhere. Those spots (a 0.3 m grid, "targets") are where the surface
///      will be looked at from. A surface renders well from a target when some
///      confidence-2 frame saw it within `greenAngleDegrees` of that direction
///      (error grows ~50% beyond 5 deg, doubles beyond 10 deg). Green when at
///      least `greenTargetFraction` of the targets facing the surface are
///      covered.
/// Thresholds 20 deg / 0.35 / 1.8 are the "middle" setting chosen by the user:
/// 27% of cells green on 158a72c2, error in green 7.6 vs 12.5 elsewhere, 28% of
/// the worst tenth still green (the old rule: 89%). The user never has to hold
/// the phone in any particular way; targets are internal.
///
/// Gray: seen from >= 3 azimuth sectors, yet almost no confident depth.
///
/// Space is a sparse 10 cm voxel grid over world points unprojected from each
/// kept frame's LiDAR depth. A mesh vertex reads the best state in the 2x2x2
/// block nearest to it: ARKit's mesh sits a few centimetres off the raw
/// samples and moves as it re-meshes.
final class CoverageMap {
    static let voxelSize: Float = 0.10
    static let minRange: Float = 0.4
    static let maxRange: Float = 3.0
    static let maxGrazingDegrees: Float = 65
    private static let minCosIncidence = cos(maxGrazingDegrees * Float.pi / 180)
    private static let sampleStep = 6

    // Green thresholds ("middle"). Tune here after the real-scan check.
    static let greenAngleDegrees: Float = 20
    static let greenTargetFraction: Float = 0.35
    static let greenConfidence: Float = 1.8
    private static let greenCos = cos(greenAngleDegrees * Float.pi / 180)

    // Gray: mean confidence below this with no confidence-2 view at all.
    static let grayConfidence: Float = 0.2
    static let grayAzimuthSectors = 3

    // Visitor model; must match viewer/src/pc-viewer.js (WALK_RADIUS_M, LEVEL_RADIUS_M).
    static let walkRadius: Float = 0.6
    static let levelRadius: Float = 1.0
    static let targetGrid: Float = 0.3
    static let targetMinDistance: Float = 0.3
    static let targetMaxDistance: Float = 3.0
    /// A new path point is recorded once the camera moved this far.
    private static let pathStep: Float = 0.15
    /// Targets are rebuilt after the path grew by this many points.
    private static let targetRebuildPoints = 2

    // Confidence-2 view directions kept per cell, deduplicated.
    private static let dirDedupCos = cos(Float(3) * Float.pi / 180)
    private static let maxDirs = 64

    private struct Cell {
        var samples: Int32 = 0
        var confSum: Float = 0
        var normalSum = simd_float3(repeating: 0)
        var azimuthMask: UInt16 = 0
        var dirs: [simd_float3] = []
        /// Cached state and the (samples, targetsVersion) it was computed at.
        var state: UInt8 = State.blue
        var stateSamples: Int32 = -1
        var stateVersion: Int = -1
        /// Cached with the state: visitor spots facing this cell, how many of
        /// them a confident frame already serves, and the sum of the positions
        /// of those it does not (the guidance's "missing angles").
        var relevant: Int32 = 0
        var covered: Int32 = 0
        var missingSum = simd_float3(repeating: 0)
    }

    private enum State {
        static let blue: UInt8 = 0
        static let gray: UInt8 = 1
        static let green: UInt8 = 2
    }

    private var cells: [Int64: Cell] = [:]
    private var path: [simd_float3] = []
    private var pathAtRebuild = 0
    private var targets: [simd_float3] = []
    private var targetsVersion = 0
    /// Where each kept frame was taken and which way it looked (horizontal,
    /// unit). "Explore" asks which headings nobody has looked along yet.
    private var looks: [(position: simd_float3, heading: simd_float2)] = []
    private let lock = NSLock()

    func reset() {
        lock.lock()
        cells.removeAll(keepingCapacity: true)
        path.removeAll(keepingCapacity: true)
        targets.removeAll(keepingCapacity: true)
        looks.removeAll(keepingCapacity: true)
        pathAtRebuild = 0
        targetsVersion += 1
        lock.unlock()
    }

    /// Record one kept frame. `intrinsics` are for the full captured image;
    /// they are rescaled onto the depth grid here. `countsAngles` is false for
    /// frames taken outside the height band: their depth still counts, but
    /// their view directions do not, because the tour will not be looked at
    /// from that height.
    func integrate(depthMap: CVPixelBuffer,
                   confidenceMap: CVPixelBuffer?,
                   intrinsics: simd_float3x3,
                   imageResolution: CGSize,
                   cameraTransform: simd_float4x4,
                   countsAngles: Bool = true) {
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

        CVPixelBufferLockBaseAddress(depthMap, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(depthMap, .readOnly) }
        guard let depthBase = CVPixelBufferGetBaseAddress(depthMap) else { return }
        let depthRow = CVPixelBufferGetBytesPerRow(depthMap)

        // Confidence (0/1/2), same grid as depth. Missing -> treated as 0.
        var confBase: UnsafeMutableRawPointer? = nil
        var confRow = 0
        if let cm = confidenceMap,
           CVPixelBufferGetWidth(cm) == w, CVPixelBufferGetHeight(cm) == h {
            CVPixelBufferLockBaseAddress(cm, .readOnly)
            confBase = CVPixelBufferGetBaseAddress(cm)
            confRow = CVPixelBufferGetBytesPerRow(cm)
        }
        defer { if let cm = confidenceMap, confBase != nil { CVPixelBufferUnlockBaseAddress(cm, .readOnly) } }

        struct Sample { let key: Int64; let conf: UInt8; let normal: simd_float3; let dir: simd_float3; let az: Int }
        var samples: [Sample] = []
        samples.reserveCapacity((w / Self.sampleStep + 1) * (h / Self.sampleStep + 1))

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

        let n = 2
        for v in stride(from: Self.sampleStep / 2, to: h, by: Self.sampleStep) {
            for u in stride(from: Self.sampleStep / 2, to: w, by: Self.sampleStep) {
                guard let d = depth(u, v) else { continue }
                guard let dr = depth(u + n, v), let dd = depth(u, v + n),
                      abs(dr - d) < 0.05, abs(dd - d) < 0.05 else { continue }
                let pc = unproject(u, v, d)
                let normalC = simd_cross(unproject(u + n, v, dr) - pc, unproject(u, v + n, dd) - pc)
                let nLen = simd_length(normalC)
                guard nLen > 1e-9 else { continue }
                let ray = pc / simd_length(pc)
                guard abs(simd_dot(normalC / nLen, ray)) >= Self.minCosIncidence else { continue }

                let world = cameraTransform * simd_float4(pc, 1)
                let p = simd_float3(world.x, world.y, world.z)
                guard let c = Self.cell(p) else { continue }

                let toCamera = camera - p
                let len = simd_length(toCamera)
                guard len > 1e-4 else { continue }
                let dir = toCamera / len
                let nw4 = cameraTransform * simd_float4(normalC / nLen, 0)
                var normal = simd_float3(nw4.x, nw4.y, nw4.z)
                if simd_dot(normal, dir) < 0 { normal = -normal }   // facing the camera
                let azimuth = (atan2(dir.x, dir.z) + Float.pi) / (2 * Float.pi)
                let conf = confBase.map { $0.load(fromByteOffset: v * confRow + u, as: UInt8.self) } ?? 0
                samples.append(Sample(key: Self.pack(c.0, c.1, c.2), conf: conf, normal: normal, dir: dir,
                                      az: min(15, max(0, Int(azimuth * 16)))))
            }
        }

        lock.lock()
        defer { lock.unlock() }
        if path.last.map({ simd_distance($0, camera) >= Self.pathStep }) ?? true {
            path.append(camera)
        }
        let forward = -simd_float3(cameraTransform.columns.2.x, cameraTransform.columns.2.y, cameraTransform.columns.2.z)
        let flat = simd_float2(forward.x, forward.z)
        if simd_length(flat) > 1e-3 {
            looks.append((position: camera, heading: simd_normalize(flat)))
        }
        for s in samples {
            var cell = cells[s.key] ?? Cell()
            cell.samples += 1
            cell.confSum += Float(min(s.conf, 2))
            cell.normalSum += s.normal
            cell.azimuthMask |= UInt16(1) << UInt16(s.az)
            if countsAngles, s.conf >= 2, cell.dirs.count < Self.maxDirs,
               !cell.dirs.contains(where: { simd_dot($0, s.dir) >= Self.dirDedupCos }) {
                cell.dirs.append(s.dir)
            }
            cells[s.key] = cell
        }
    }

    /// Per-vertex RGBA (Float32) for one mesh anchor's vertices, read from a
    /// COPY of the vertex buffer: ARKit reuses and overwrites its own.
    func vertexColors(vertexData: Data, offset: Int, stride: Int, count: Int,
                      anchorTransform: simd_float4x4, paintCoverage: Bool = true,
                      doneBoxes: [DoneBox] = []) -> Data {
        var rgba = [Float](repeating: 0, count: count * 4)
        lock.lock()
        if paintCoverage { rebuildTargetsIfNeeded() }
        var lastCell: (Int64, Int64, Int64, Int64, Int64, Int64)? = nil
        var lastState = State.blue
        vertexData.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for i in 0..<count {
                let o = offset + i * stride
                guard o + 12 <= raw.count else { break }
                let local = simd_float4(raw.loadUnaligned(fromByteOffset: o, as: Float.self),
                                        raw.loadUnaligned(fromByteOffset: o + 4, as: Float.self),
                                        raw.loadUnaligned(fromByteOffset: o + 8, as: Float.self),
                                        1)
                let world = anchorTransform * local
                // A finished piece (object mode) is green whatever the
                // coverage says, and shows even with coverage painting off
                // (then every other vertex stays fully transparent).
                if doneBoxes.contains(where: { $0.contains(world) }) {
                    let g = Self.doneGreen
                    rgba[i * 4] = g.0
                    rgba[i * 4 + 1] = g.1
                    rgba[i * 4 + 2] = g.2
                    rgba[i * 4 + 3] = g.3
                    continue
                }
                guard paintCoverage else { continue }
                var state = State.blue
                if let cell = Self.cell(simd_float3(world.x, world.y, world.z)) {
                    if let last = lastCell, last == cell {
                        state = lastState
                    } else {
                        state = stateNear(cell)
                        lastCell = cell
                        lastState = state
                    }
                }
                let c = Self.color(state)
                rgba[i * 4] = c.0
                rgba[i * 4 + 1] = c.1
                rgba[i * 4 + 2] = c.2
                rgba[i * 4 + 3] = c.3
            }
        }
        lock.unlock()
        return rgba.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    /// Best state in the 2x2x2 voxel block nearest to a point: green beats
    /// gray beats blue. Caller holds `lock`.
    private func stateNear(_ c: (Int64, Int64, Int64, Int64, Int64, Int64)) -> UInt8 {
        var best = State.blue
        for a in 0..<2 {
            let x = a == 0 ? c.0 : c.3
            for b in 0..<2 {
                let y = b == 0 ? c.1 : c.4
                for d in 0..<2 {
                    let z = d == 0 ? c.2 : c.5
                    let s = state(of: Self.pack(x, y, z))
                    if s == State.green { return s }
                    best = max(best, s)
                }
            }
        }
        return best
    }

    /// State of one cell, cached until it gets new samples or the targets
    /// change. Caller holds `lock`.
    private func state(of key: Int64) -> UInt8 {
        guard var cell = cells[key] else { return State.blue }
        if cell.stateSamples == cell.samples && cell.stateVersion == targetsVersion { return cell.state }
        evaluate(&cell, key: key)
        cell.stateSamples = cell.samples
        cell.stateVersion = targetsVersion
        cells[key] = cell
        return cell.state
    }

    /// Fills `state`, `relevant`, `covered`, `missingSum`.
    private func evaluate(_ cell: inout Cell, key: Int64) {
        cell.relevant = 0
        cell.covered = 0
        cell.missingSum = simd_float3(repeating: 0)
        guard cell.samples > 0 else { cell.state = State.blue; return }
        let meanConf = cell.confSum / Float(cell.samples)
        if cell.dirs.isEmpty && cell.azimuthMask.nonzeroBitCount >= Self.grayAzimuthSectors
            && meanConf < Self.grayConfidence {
            cell.state = State.gray
            return
        }

        let center = Self.center(key)
        let nLen = simd_length(cell.normalSum)
        let normal = nLen > 1e-6 ? cell.normalSum / nLen : simd_float3(0, 0, 0)
        var relevant: Int32 = 0
        var covered: Int32 = 0
        var missingSum = simd_float3(repeating: 0)
        for t in targets {
            let wv = t - center
            let dist = simd_length(wv)
            guard dist > Self.targetMinDistance, dist < Self.targetMaxDistance,
                  simd_dot(wv, normal) > 0.1 * dist else { continue }
            relevant += 1
            let wd = wv / dist
            if cell.dirs.contains(where: { simd_dot($0, wd) >= Self.greenCos }) {
                covered += 1
            } else {
                missingSum += t
            }
        }
        cell.relevant = relevant
        cell.covered = covered
        cell.missingSum = missingSum
        if cell.dirs.isEmpty || meanConf < Self.greenConfidence {
            cell.state = State.blue
        } else if relevant == 0 {
            // No visitor spot faces this surface: nobody will look at it closely.
            cell.state = State.green
        } else {
            cell.state = Float(covered) >= Self.greenTargetFraction * Float(relevant) ? State.green : State.blue
        }
    }

    // MARK: - Guidance (the live target arrow)

    struct GuidePick {
        /// World point the phone should look at; nil when nothing is left to
        /// film from where the user stands.
        var point: simd_float3?
        var explore = false
        /// Missing angles the point would complete (explore: `exploreScore`).
        var score: Float = 0
        /// Same measure toward the caller's current target, for hysteresis.
        var currentScore: Float = 0
        /// The current target's heading has been looked along from here.
        var currentExplored = false
        /// Share of (surface, visitor spot) pairs already served, 0..1.
        var progress: Float = 0
        var pairsTotal = 0
        /// Mean position of the visitor spots whose missing angles cannot be
        /// filmed from here: where to walk next.
        var walkTo: simd_float3?
        /// Any heading near here that nobody has looked along yet.
        var exploreLeft = false
    }

    static let guideYawBins = 36
    static let guidePitchBins = 3
    static let exploreScore: Float = 1_000_000
    /// Pitch bands (deg): below -15 down, above +15 up, level between.
    private static let guidePitchEdge: Float = 15
    /// Candidate view half width in 10-degree yaw bins: about the portrait
    /// camera's horizontal half field of view.
    private static let guideYawHalf = 2
    /// A heading counts as looked at when a kept frame within this radius
    /// looked within `exploreDegrees` of it.
    private static let exploreRadius: Float = 1.0
    private static let exploreCos = cos(Float(20) * Float.pi / 180)
    private static let exploreDistance: Float = 1.5

    /// Yaw bin and pitch band of a world direction, as one index
    /// (pitch * guideYawBins + yaw).
    static func guideBin(of d: simd_float3) -> Int {
        let yaw = atan2(d.x, d.z)
        let y = min(guideYawBins - 1, max(0, Int((yaw + Float.pi) / (2 * Float.pi) * Float(guideYawBins))))
        let pitch = asin(max(-1, min(1, d.y))) * 180 / Float.pi
        let p = pitch < -guidePitchEdge ? 0 : (pitch > guidePitchEdge ? 2 : 1)
        return p * guideYawBins + y
    }

    /// The next thing to film from `camera`. Explore first (a heading nobody
    /// looked along near here), else the view that completes the most missing
    /// visitor angles. Bins in `avoid` are skipped (just filmed, did not help).
    func pickTarget(camera: simd_float3, forward: simd_float3,
                    current: simd_float3?, avoid: Set<Int>) -> GuidePick {
        lock.lock()
        defer { lock.unlock() }
        rebuildTargetsIfNeeded()

        let nBins = Self.guideYawBins * Self.guidePitchBins
        var gain = [Float](repeating: 0, count: nBins)
        var gainPos = [simd_float3](repeating: simd_float3(repeating: 0), count: nBins)
        var relevantAll = 0
        var coveredAll = 0
        var walkSum = simd_float3(repeating: 0)
        var walkCount: Float = 0

        for key in Array(cells.keys) {
            _ = state(of: key)
            guard let cell = cells[key], cell.relevant > 0 else { continue }
            relevantAll += Int(cell.relevant)
            coveredAll += Int(cell.covered)
            let missing = cell.relevant - cell.covered
            guard missing > 0 else { continue }

            let center = Self.center(key)
            let toCam = camera - center
            let camDist = simd_length(toCam)
            let nLen = simd_length(cell.normalSum)
            var cellGain: Float = 0
            if camDist > Self.minRange, camDist < Self.maxRange, nLen > 1e-6,
               simd_dot(toCam, cell.normalSum / nLen) > 0.1 * camDist {
                let camDir = toCam / camDist
                for t in targets {
                    let wv = t - center
                    let dist = simd_length(wv)
                    guard dist > Self.targetMinDistance, dist < Self.targetMaxDistance else { continue }
                    let wd = wv / dist
                    // Filming from here serves this visitor spot ...
                    guard simd_dot(camDir, wd) >= Self.greenCos,
                          simd_dot(wv, cell.normalSum / nLen) > 0.1 * dist else { continue }
                    // ... and nothing served it yet.
                    if !cell.dirs.contains(where: { simd_dot($0, wd) >= Self.greenCos }) { cellGain += 1 }
                }
            }
            if cellGain > 0 {
                let b = Self.guideBin(of: -toCam / camDist)
                gain[b] += cellGain
                gainPos[b] += center * cellGain
            }
            let rest = Float(missing) - cellGain
            if rest > 0 {
                walkSum += cell.missingSum * (rest / Float(missing))
                walkCount += rest
            }
        }

        func window(_ k: Int) -> (Float, simd_float3) {
            let p = k / Self.guideYawBins, y = k % Self.guideYawBins
            var s: Float = 0
            var pos = simd_float3(repeating: 0)
            for dy in -Self.guideYawHalf...Self.guideYawHalf {
                let j = p * Self.guideYawBins + (y + dy + Self.guideYawBins) % Self.guideYawBins
                s += gain[j]
                pos += gainPos[j]
            }
            return (s, pos)
        }

        var pick = GuidePick()
        pick.pairsTotal = relevantAll
        pick.progress = relevantAll > 0 ? Float(coveredAll) / Float(relevantAll) : 0
        if walkCount > 0 { pick.walkTo = walkSum / walkCount }

        // Explore: level headings nobody looked along near here.
        let here = simd_float2(camera.x, camera.z)
        let nearLooks = looks.filter {
            simd_distance(simd_float2($0.position.x, $0.position.z), here) <= Self.exploreRadius
        }
        func explored(_ h: simd_float2) -> Bool {
            nearLooks.contains(where: { simd_dot($0.heading, h) >= Self.exploreCos })
        }
        var fwd = simd_float2(forward.x, forward.z)
        fwd = simd_length(fwd) > 1e-3 ? simd_normalize(fwd) : simd_float2(0, 1)
        var exploreHeading: simd_float2? = nil
        var exploreTurn = Float.infinity
        for y in 0..<Self.guideYawBins {
            if avoid.contains(Self.guideYawBins + y) { continue }
            let a = (Float(y) + 0.5) / Float(Self.guideYawBins) * 2 * Float.pi - Float.pi
            let h = simd_float2(sin(a), cos(a))
            if explored(h) { continue }
            let turn = acos(max(-1, min(1, simd_dot(h, fwd))))
            if turn < exploreTurn {
                exploreTurn = turn
                exploreHeading = h
            }
        }
        pick.exploreLeft = exploreHeading != nil

        if let c = current {
            let d = c - camera
            if simd_length(d) > 1e-3 {
                pick.currentScore = window(Self.guideBin(of: simd_normalize(d))).0
                let flat = simd_float2(d.x, d.z)
                pick.currentExplored = simd_length(flat) > 1e-3 && explored(simd_normalize(flat))
            }
        }

        if let h = exploreHeading {
            pick.point = camera + simd_float3(h.x, 0, h.y) * Self.exploreDistance
            pick.explore = true
            pick.score = Self.exploreScore
            return pick
        }
        var bestScore: Float = 0
        var bestPoint: simd_float3? = nil
        for k in 0..<nBins where !avoid.contains(k) {
            let (s, pos) = window(k)
            if s > bestScore {
                bestScore = s
                bestPoint = pos / s
            }
        }
        pick.point = bestPoint
        pick.score = bestScore
        return pick
    }

    /// Visitor spots: a `targetGrid` grid within `walkRadius` (horizontally)
    /// of the path, at the median camera height within `levelRadius`, like
    /// the viewer's eye height. Caller holds `lock`.
    private func rebuildTargetsIfNeeded() {
        guard path.count - pathAtRebuild >= Self.targetRebuildPoints || (targets.isEmpty && !path.isEmpty) else { return }
        pathAtRebuild = path.count
        targetsVersion += 1
        targets.removeAll(keepingCapacity: true)
        let g = Self.targetGrid
        var seen = Set<Int64>()
        let reach = Int((Self.walkRadius / g).rounded(.up))
        for p in path {
            let gx = Int64((p.x / g).rounded()), gz = Int64((p.z / g).rounded())
            for dx in -reach...reach {
                for dz in -reach...reach {
                    let kx = gx + Int64(dx), kz = gz + Int64(dz)
                    let key = Self.pack(kx, 0, kz)
                    if seen.contains(key) { continue }
                    let tx = Float(kx) * g, tz = Float(kz) * g
                    var near = false
                    var heights: [Float] = []
                    for q in path {
                        let d = simd_length(simd_float2(q.x - tx, q.z - tz))
                        if d <= Self.walkRadius { near = true }
                        if d <= Self.levelRadius { heights.append(q.y) }
                    }
                    guard near else { continue }
                    seen.insert(key)
                    heights.sort()
                    targets.append(simd_float3(tx, heights[heights.count / 2], tz))
                }
            }
        }
    }

    /// Drawn as one half-transparent layer (see ArkitPreviewView), so the
    /// alpha here is what keeps the camera image visible underneath.
    /// #4ade80, same alpha as the covered colour above.
    static let doneGreen: (Float, Float, Float, Float) = (0.29, 0.87, 0.50, 0.55)

    private static func color(_ state: UInt8) -> (Float, Float, Float, Float) {
        switch state {
        case State.green: return (0.15, 0.90, 0.35, 0.55)
        case State.gray: return (0.60, 0.60, 0.60, 0.55)
        default: return (0.25, 0.45, 1.00, 0.55)
        }
    }

    private static func center(_ key: Int64) -> simd_float3 {
        func unpack(_ v: Int64) -> Float {
            let s = v & 0x1FFFFF
            return Float(s >= 0x100000 ? s - 0x200000 : s)
        }
        return (simd_float3(unpack(key >> 42), unpack(key >> 21), unpack(key)) + 0.5) * voxelSize
    }

    /// The voxel holding `p` (first three) and, per axis, the neighbouring
    /// voxel on the side `p` is closer to (last three).
    private static func cell(_ p: simd_float3) -> (Int64, Int64, Int64, Int64, Int64, Int64)? {
        guard p.x.isFinite, p.y.isFinite, p.z.isFinite,
              abs(p.x) < 100_000, abs(p.y) < 100_000, abs(p.z) < 100_000 else { return nil }
        let gx = p.x / voxelSize, gy = p.y / voxelSize, gz = p.z / voxelSize
        let fx = gx.rounded(.down), fy = gy.rounded(.down), fz = gz.rounded(.down)
        let ix = Int64(fx), iy = Int64(fy), iz = Int64(fz)
        return (ix, iy, iz,
                gx - fx < 0.5 ? ix - 1 : ix + 1,
                gy - fy < 0.5 ? iy - 1 : iy + 1,
                gz - fz < 0.5 ? iz - 1 : iz + 1)
    }

    /// 21 bits per axis: unique within +/-100 km of the session origin.
    private static func pack(_ x: Int64, _ y: Int64, _ z: Int64) -> Int64 {
        ((x & 0x1FFFFF) << 42) | ((y & 0x1FFFFF) << 21) | (z & 0x1FFFFF)
    }
}

/// A scanned piece's box (object mode), for painting its mesh green. Same
/// oriented-box test as ObjectFinder.meshCheck, grown 5 cm.
struct DoneBox {
    let inverse: simd_float4x4
    let half: simd_float3

    /// JSON as setObjectBoxes sends it: center, size, yaw_deg (x axis -> (cos, 0, -sin)).
    init?(json: [String: Any]) {
        guard let c = (json["center"] as? [NSNumber])?.map({ Float(truncating: $0) }), c.count == 3,
              let s = (json["size"] as? [NSNumber])?.map({ Float(truncating: $0) }), s.count == 3 else { return nil }
        let yaw = Float(truncating: (json["yaw_deg"] as? NSNumber) ?? 0) * Float.pi / 180
        let cs = cos(yaw)
        let sn = sin(yaw)
        let t = simd_float4x4(columns: (
            simd_float4(cs, 0, -sn, 0),
            simd_float4(0, 1, 0, 0),
            simd_float4(sn, 0, cs, 0),
            simd_float4(c[0], c[1], c[2], 1)))
        inverse = t.inverse
        half = simd_float3(s[0], s[1], s[2]) / 2 + simd_float3(repeating: 0.05)
    }

    func contains(_ world: simd_float4) -> Bool {
        let l = inverse * world
        return abs(l.x) <= half.x && abs(l.y) <= half.y && abs(l.z) <= half.z
    }
}
