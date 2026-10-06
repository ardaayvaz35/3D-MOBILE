import ARKit
import Foundation
#if canImport(RoomPlan)
import RoomPlan
#endif

/// Finds the main furniture by itself (spec 2026-10-02-uygulama-mimarisi.md
/// §3.3): Apple RoomPlan, run on OUR ARSession (iOS 17+
/// `RoomCaptureSession(arSession:)`), so its boxes and our frames share one
/// world and the whole scan stays one uninterrupted session (§2).
///
/// Unverified when written (no Mac to try it on), so guarded at run time:
///  * Depth health: RoomPlan runs its own configuration on the session. If
///    LiDAR depth frames stop arriving for `depthGraceSeconds`, RoomPlan is
///    stopped without pausing the session and our configuration is re-run;
///    the scan goes on as a room-only scan.
///  * World match: a box is only offered when the LiDAR mesh actually has
///    points inside it (`meshCheck`); a box from another coordinate frame
///    would hold none. The worker repeats this check against its seed cloud.
/// Everything it learns is reported in metadata (`object_finder`).
final class ObjectFinder: NSObject {
    static let depthGraceSeconds: TimeInterval = 2.0
    /// No mesh anchor added or refined for this long while RoomPlan runs =
    /// scene reconstruction is off. ARKit refines visible anchors every few
    /// frames, so a few seconds of silence is not normal.
    static let meshGraceSeconds: TimeInterval = 4.0
    static let emitInterval: TimeInterval = 1.0
    /// Mesh vertices a box (grown by 5 cm) must hold to count as real.
    static let minMeshPoints = 30

    private let emit: ([String: Any]) -> Void
    private(set) var status = "off"
    private(set) var failure: String?
    private var startedAt: TimeInterval = 0
    private var lastEmit: TimeInterval = 0
    private var lastDepth: TimeInterval = 0
    private var rejected = Set<String>()
    private var latest: [[String: Any]] = []
    private var walls: [[String: Any]] = []
    private var session: AnyObject?
    /// The LiDAR mesh was still there while RoomPlan ran (scene reconstruction on).
    private var meshSeen = false
    /// The last CapturedRoom as JSON (Codable), written into the archive as
    /// roomplan.json: this segment's walls/doors/objects before any merge (spec §8.2).
    private(set) var roomJSON: Data?

    init(emit: @escaping ([String: Any]) -> Void) {
        self.emit = emit
    }

    var facts: [String: Any] {
        var f: [String: Any] = ["status": status, "objects": latest.count, "rejected_off_mesh": rejected.count,
                                "mesh_while_running": meshSeen]
        if let r = failure { f["failure"] = r }
        return f
    }

    /// Main thread. Safe to call where RoomPlan is unavailable.
    func start() {
        #if canImport(RoomPlan)
        guard #available(iOS 17.0, *) else { status = "unavailable (iOS < 17)"; send(); return }
        guard RoomCaptureSession.isSupported else { status = "unsupported device"; send(); return }
        let s = RoomCaptureSession(arSession: ArkitSessionHost.shared.session)
        s.delegate = self
        s.run(configuration: RoomCaptureSession.Configuration())
        session = s
        status = "running"
        startedAt = CACurrentMediaTime()
        lastDepth = startedAt
        // RoomPlan may take the session's delegate, now or a moment later.
        ArkitSessionHost.shared.reclaimDelegate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { ArkitSessionHost.shared.reclaimDelegate() }
        // Frames can stop altogether (then frameTick never runs): watch by clock too.
        health = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.checkHealth() }
        send()
        #else
        status = "unavailable (no RoomPlan)"
        send()
        #endif
    }

    /// Main thread. Ends RoomPlan but keeps the ARSession running.
    func stop() {
        health?.invalidate()
        health = nil
        ArkitSessionHost.shared.releaseChainedDelegate()
        #if canImport(RoomPlan)
        if #available(iOS 17.0, *), let s = session as? RoomCaptureSession {
            s.stop(pauseARSession: false)
        }
        #endif
        // Whatever RoomPlan ran on the session, ours comes back (no reset:
        // tracking and the world origin carry on).
        if session != nil { ArkitSessionHost.shared.rerunConfiguration() }
        session = nil
        if status == "running" { status = "stopped" }
    }

    /// Every ARKit frame while recording.
    func frameTick(hasDepth: Bool, time: TimeInterval) {
        if hasDepth { lastDepth = CACurrentMediaTime() }
    }

    private var health: Timer?

    /// Main thread, every 0.5 s while RoomPlan runs.
    private func checkHealth() {
        guard status == "running" else { return }
        let now = CACurrentMediaTime()
        if now - lastDepth > Self.depthGraceSeconds && now - startedAt > Self.depthGraceSeconds {
            fail("no depth frames for \(Self.depthGraceSeconds) s while RoomPlan ran")
            return
        }
        let mesh = ArkitSessionHost.shared.lastMeshUpdate
        if now - max(mesh, startedAt) > Self.meshGraceSeconds {
            fail("mesh stopped: no mesh anchor update for \(Self.meshGraceSeconds) s while RoomPlan ran")
        }
    }

    private func fail(_ reason: String) {
        failure = reason
        stop()  // also gives the session back its LiDAR configuration
        status = "failed"
        print("[objects] RoomPlan off: \(reason)")
        send()
    }

    private func send() {
        emit(["status": status, "failure": failure ?? "", "objects": latest, "walls": walls])
    }

    #if canImport(RoomPlan)
    @available(iOS 16.0, *)
    fileprivate func update(_ room: CapturedRoom) {
        let now = CACurrentMediaTime()
        guard now - lastEmit >= Self.emitInterval else { return }
        lastEmit = now
        roomJSON = try? JSONEncoder().encode(room)
        let mesh = ArkitSessionHost.shared.currentMeshAnchors()
        // RoomPlan's own configuration may switch scene reconstruction off;
        // with no mesh at all the check cannot run, and that is recorded.
        meshSeen = !mesh.isEmpty
        var out: [[String: Any]] = []
        for o in room.objects {
            let id = String(o.identifier.uuidString.prefix(8)).lowercased()
            let t = o.transform
            let size = o.dimensions
            if !mesh.isEmpty && !Self.meshCheck(transform: t, size: size, anchors: mesh) {
                rejected.insert(id)
                continue
            }
            rejected.remove(id)
            // Box local x axis in world = column 0; yaw about +Y, same sign
            // as worker/object_lock.py _yaw(): x axis -> (cos, 0, -sin).
            let yaw = atan2(-t.columns.0.z, t.columns.0.x) * 180 / .pi
            out.append([
                "id": id,
                "category": Self.categoryName(o.category),
                "center": [t.columns.3.x, t.columns.3.y, t.columns.3.z].map { Double($0) },
                "size": [size.x, size.y, size.z].map { Double($0) },
                "yaw_deg": Double(yaw),
            ])
        }
        latest = out
        walls = room.walls.map { w in
            let t = w.transform
            return [
                "center": [t.columns.3.x, t.columns.3.y, t.columns.3.z].map { Double($0) },
                "width": Double(w.dimensions.x),
                "yaw_deg": Double(atan2(-t.columns.0.z, t.columns.0.x) * 180 / .pi),
            ]
        }
        send()
    }

    @available(iOS 16.0, *)
    static func categoryName(_ c: CapturedRoom.Object.Category) -> String {
        switch c {
        case .storage: return "storage"
        case .bed: return "bed"
        case .table: return "table"
        case .sofa: return "sofa"
        case .chair: return "chair"
        case .refrigerator: return "refrigerator"
        case .television: return "television"
        case .fireplace: return "fireplace"
        case .washerDryer: return "washerDryer"
        case .stove: return "stove"
        case .oven: return "oven"
        case .dishwasher: return "dishwasher"
        case .sink: return "sink"
        case .toilet: return "toilet"
        case .bathtub: return "bathtub"
        case .stairs: return "stairs"
        @unknown default: return "other"
        }
    }
    #endif

    /// Does the LiDAR mesh have points inside this box (grown by 5 cm)?
    static func meshCheck(transform t: simd_float4x4, size: simd_float3, anchors: [ARMeshAnchor]) -> Bool {
        let inv = t.inverse
        let half = size / 2 + simd_float3(repeating: 0.05)
        var hits = 0
        for a in anchors {
            let v = a.geometry.vertices
            let base = v.buffer.contents()
            // Every 4th vertex is plenty for a yes/no.
            var i = 0
            while i < v.count {
                let p = base.advanced(by: v.offset + i * v.stride)
                    .assumingMemoryBound(to: (Float, Float, Float).self).pointee
                let w = a.transform * simd_float4(p.0, p.1, p.2, 1)
                let l = inv * w
                if abs(l.x) <= half.x && abs(l.y) <= half.y && abs(l.z) <= half.z {
                    hits += 1
                    if hits >= minMeshPoints { return true }
                }
                i += 4
            }
        }
        return false
    }
}

#if canImport(RoomPlan)
// RoomPlan exists from iOS 16; only the shared-session init needs 17 (start()).
@available(iOS 16.0, *)
extension ObjectFinder: RoomCaptureSessionDelegate {
    func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        DispatchQueue.main.async { self.update(room) }
    }

    func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
        guard let error = error else { return }
        DispatchQueue.main.async { if self.status == "running" { self.fail("RoomPlan ended: \(error.localizedDescription)") } }
    }
}
#endif
