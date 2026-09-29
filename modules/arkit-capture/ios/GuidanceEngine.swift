import ARKit
import UIKit
import simd

/// Guided capture: one live target to look at, and a height lock.
///
/// Design: docs/superpowers/specs/2026-09-30-yonlendirmeli-cekim-design.md.
/// Why: on scan 158a72c2 only 24% of the directions a tour visitor looks
/// along were filmed within 8 deg, error grows ~50% beyond 5 deg, and the phone
/// wandered over a 62 cm height band. The user cannot see missing angles; the
/// ledger (CoverageMap) can, so it picks where to look and an arrow says so.
///
///   * Target: CoverageMap.pickTarget, re-run every `pickInterval` on a
///     background queue. Explore (a heading nobody looked along near here)
///     beats improve (the view that serves the most missing visitor angles).
///     An improve target only changes when a new one is `switchFactor` better.
///   * Aligned: the camera looks within `alignDegrees` of the target and the
///     height is in the band. Held for `alignHold`, the target is done; its
///     bin is skipped here for `avoidSeconds`, so a surface the LiDAR cannot
///     read confidently does not hold the arrow forever.
///   * Height: locked at the first frame of the recording. Outside
///     +/-`bandMeters` for `bandDelay` the phone pulses; back within
///     `bandReturnMeters` it stops at once. The gap stops it flickering at the
///     edge. 7 cm is ~2.7 deg of view error at 1.5 m, under the 3 deg photo
///     warps handle; 10 cm would be 5.7 deg at 1 m.
///   * Haptics are for height only. Target alignment is shown, not felt.
final class GuidanceEngine {
    static let bandMeters: Float = 0.07
    static let bandReturnMeters: Float = 0.05
    static let bandDelay: TimeInterval = 0.3
    static let alignDegrees: Float = 10
    static let alignHold: TimeInterval = 1.0
    static let pickInterval: TimeInterval = 0.5
    static let hotPickInterval: TimeInterval = 2.0
    static let emitInterval: TimeInterval = 0.1
    static let switchFactor: Float = 1.3
    /// Fewer missing angles than this is not worth an arrow.
    static let minGain: Float = 5
    /// "Every place is scanned" once this share of visitor angles is served,
    /// nothing is left to explore here and the scan ran `doneAfter`. First
    /// guesses; tuned on the first real guided scan.
    static let doneProgress: Float = 0.8
    static let doneAfter: TimeInterval = 60
    static let avoidSeconds: TimeInterval = 20
    static let avoidRadius: Float = 0.5

    private let coverage: CoverageMap
    private let haptics = HeightHaptics()
    private let emit: ([String: Any]) -> Void
    private let pickQueue = DispatchQueue(label: "arkit-capture.guidance", qos: .utility)

    // ARKit delegate thread only.
    private(set) var lockedHeight: Float?
    private var startTime: TimeInterval?
    private var outsideSince: TimeInterval?
    private var buzzing = false
    private var lastEmit: TimeInterval = 0
    private var lastPickRequest: TimeInterval = -1_000
    private var alignedSince: TimeInterval?
    private var alignedGeneration = -1

    // Shared with pickQueue, under `lock`.
    private let lock = NSLock()
    private var target: simd_float3?
    private var targetExplore = false
    private var targetGeneration = 0
    private var pickInFlight = false
    private var progress: Float = 0
    private var walkTo: simd_float3?
    private var exploreLeft = true
    private var avoided: [(bin: Int, position: simd_float3, until: TimeInterval)] = []

    init(coverage: CoverageMap, emit: @escaping ([String: Any]) -> Void) {
        self.coverage = coverage
        self.emit = emit
    }

    /// True when a camera at height `y` is inside the band (for the ledger:
    /// frames outside it do not count as good angles).
    func isInBand(_ y: Float) -> Bool {
        guard let h = lockedHeight else { return true }
        return abs(y - h) <= Self.bandMeters
    }

    func shutdown() {
        haptics.shutdown()
    }

    /// Every ARKit frame while recording.
    func update(pose: simd_float4x4, time: TimeInterval, hot: Bool,
                focal: Float, imageResolution: CGSize) {
        let position = simd_float3(pose.columns.3.x, pose.columns.3.y, pose.columns.3.z)
        let forward = -simd_float3(pose.columns.2.x, pose.columns.2.y, pose.columns.2.z)
        if lockedHeight == nil {
            lockedHeight = position.y
            startTime = time
        }
        let deviation = position.y - (lockedHeight ?? position.y)
        let inBand = abs(deviation) <= Self.bandMeters

        let wasBuzzing = buzzing
        if !inBand {
            if outsideSince == nil { outsideSince = time }
            if let since = outsideSince, time - since >= Self.bandDelay { buzzing = true }
        } else {
            outsideSince = nil
            if abs(deviation) <= Self.bandReturnMeters { buzzing = false }
        }
        if buzzing != wasBuzzing {
            haptics.set(active: buzzing, deviation: abs(deviation))
        }

        let interval = hot ? Self.hotPickInterval : Self.pickInterval
        if time - lastPickRequest >= interval {
            lastPickRequest = time
            requestPick(position: position, forward: forward, time: time)
        }

        lock.lock()
        let t = target
        let explore = targetExplore
        let generation = targetGeneration
        let progressNow = progress
        let walk = walkTo
        let leftToExplore = exploreLeft
        lock.unlock()

        var aligned = false
        var hold: Double = 0
        var toTarget: simd_float3? = nil
        if let t = t, simd_length(t - position) > 1e-3 {
            let dir = simd_normalize(t - position)
            toTarget = dir
            let angle = acos(max(-1, min(1, simd_dot(dir, forward)))) * 180 / Float.pi
            aligned = angle <= Self.alignDegrees && inBand
            if aligned {
                if alignedSince == nil || alignedGeneration != generation {
                    alignedSince = time
                    alignedGeneration = generation
                }
                hold = min(1, (time - (alignedSince ?? time)) / Self.alignHold)
                if time - (alignedSince ?? time) >= Self.alignHold {
                    complete(generation: generation, direction: dir, position: position, time: time)
                    alignedSince = nil
                    lastPickRequest = -1_000
                }
            } else {
                alignedSince = nil
            }
        } else {
            alignedSince = nil
        }

        guard time - lastEmit >= Self.emitInterval else { return }
        lastEmit = time
        if buzzing { haptics.set(active: true, deviation: abs(deviation)) }

        let done = progressNow >= Self.doneProgress && !leftToExplore
            && time - (startTime ?? time) >= Self.doneAfter
        let mode: String
        if toTarget != nil {
            mode = explore ? "explore" : "improve"
        } else if walk != nil {
            mode = "walk"
        } else {
            mode = "wait"
        }
        var payload: [String: Any] = [
            "mode": mode,
            "aligned": aligned,
            "hold": hold,
            "progress": Double(progressNow),
            "done": done,
            "heightDeviation": Double(deviation),
            "inBand": inBand,
            "buzzing": buzzing,
            "focal": Double(focal),
            "imageWidth": Double(imageResolution.width),
            "imageHeight": Double(imageResolution.height),
        ]
        // Directions in portrait screen terms. ARKit's camera frame is the
        // landscape sensor: +X runs from the front camera toward the bottom of
        // the phone, +Y to the portrait right, -Z forward.
        let rotation = simd_float3x3(
            simd_float3(pose.columns.0.x, pose.columns.0.y, pose.columns.0.z),
            simd_float3(pose.columns.1.x, pose.columns.1.y, pose.columns.1.z),
            simd_float3(pose.columns.2.x, pose.columns.2.y, pose.columns.2.z))
        func screen(_ world: simd_float3) -> [String: Double] {
            let c = rotation.transpose * world
            return ["right": Double(c.y), "up": Double(-c.x), "forward": Double(-c.z)]
        }
        if let d = toTarget {
            payload["target"] = screen(d)
        }
        if mode == "walk", let w = walk {
            let flat = simd_float3(w.x - position.x, 0, w.z - position.z)
            if simd_length(flat) > 0.2 {
                payload["walk"] = screen(simd_normalize(flat))
                payload["walkMeters"] = Double(simd_length(flat))
            }
        }
        emit(payload)
    }

    private func complete(generation: Int, direction: simd_float3, position: simd_float3, time: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        guard generation == targetGeneration else { return }
        avoided.append((bin: CoverageMap.guideBin(of: direction), position: position,
                        until: time + Self.avoidSeconds))
        target = nil
        targetExplore = false
        targetGeneration += 1
    }

    private func requestPick(position: simd_float3, forward: simd_float3, time: TimeInterval) {
        lock.lock()
        if pickInFlight {
            lock.unlock()
            return
        }
        pickInFlight = true
        let current = target
        let generation = targetGeneration
        avoided.removeAll { $0.until < time }
        let avoid = Set(avoided.filter { simd_distance($0.position, position) <= Self.avoidRadius }.map { $0.bin })
        lock.unlock()

        pickQueue.async { [weak self] in
            guard let self = self else { return }
            let pick = self.coverage.pickTarget(camera: position, forward: forward,
                                                current: current, avoid: avoid)
            self.lock.lock()
            defer { self.lock.unlock() }
            self.pickInFlight = false
            self.progress = pick.progress
            self.walkTo = pick.walkTo
            self.exploreLeft = pick.exploreLeft

            var keep = false
            if generation == self.targetGeneration, self.target != nil {
                if self.targetExplore {
                    keep = !pick.currentExplored
                } else if !pick.explore {
                    keep = pick.currentScore >= Self.minGain
                        && pick.score < pick.currentScore * Self.switchFactor
                }
            }
            if keep { return }
            if let p = pick.point, pick.explore || pick.score >= Self.minGain {
                self.target = p
                self.targetExplore = pick.explore
            } else {
                self.target = nil
                self.targetExplore = false
            }
            self.targetGeneration += 1
        }
    }
}

/// Rhythmic pulses while the phone is outside the height band; faster the
/// further out. Stops at once when told, and on its own whenever the app
/// leaves the foreground (resign active covers the lock screen and the app
/// switcher), so the phone never keeps buzzing in a pocket.
final class HeightHaptics {
    /// Medium impact at 0.6: felt through a hand without being harsh. First
    /// guess, tuned in the user's hand on the first real scan.
    static let intensity: CGFloat = 0.6
    static let slowInterval: TimeInterval = 0.35
    static let fastInterval: TimeInterval = 0.12

    private var generator: UIImpactFeedbackGenerator?
    private var timer: Timer?
    private var active = false
    private var interval: TimeInterval = slowInterval
    private var lastPulse: TimeInterval = 0
    private var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.stopNow()
            })
        }
    }

    deinit {
        for o in observers { NotificationCenter.default.removeObserver(o) }
    }

    /// Any thread.
    func set(active: Bool, deviation: Float) {
        DispatchQueue.main.async { [weak self] in
            self?.apply(active: active, deviation: deviation)
        }
    }

    /// Any thread. Stops for good (end of recording).
    func shutdown() {
        let stop = {
            self.stopNow()
            for o in self.observers { NotificationCenter.default.removeObserver(o) }
            self.observers.removeAll()
        }
        if Thread.isMainThread { stop() } else { DispatchQueue.main.async(execute: stop) }
    }

    private func apply(active on: Bool, deviation: Float) {
        // 0.35 s between pulses at the band edge, down to 0.12 s at ~22 cm off.
        let over = Double(max(0, deviation - GuidanceEngine.bandMeters))
        interval = max(Self.fastInterval, Self.slowInterval - over * 1.5)
        guard on, UIApplication.shared.applicationState == .active else {
            stopNow()
            return
        }
        guard !active else { return }
        active = true
        let g = UIImpactFeedbackGenerator(style: .medium)
        g.prepare()
        generator = g
        lastPulse = 0
        timer = Timer.scheduledTimer(withTimeInterval: 0.04, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    private func tick() {
        guard active, let g = generator else { return }
        let now = CACurrentMediaTime()
        guard now - lastPulse >= interval else { return }
        lastPulse = now
        g.impactOccurred(intensity: Self.intensity)
        g.prepare()
    }

    private func stopNow() {
        active = false
        timer?.invalidate()
        timer = nil
        generator = nil
    }
}
