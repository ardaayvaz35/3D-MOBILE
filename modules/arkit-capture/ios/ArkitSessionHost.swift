import ARKit
import AVFoundation

/// Single shared ARSession owned by the live preview view, so the camera
/// feed actually renders on screen. ARKit only allows one active capture
/// session at a time, so CaptureManager no longer creates its own session --
/// it attaches as a frame sink here instead.
final class ArkitSessionHost: NSObject, ARSessionDelegate {
    static let shared = ArkitSessionHost()

    let session = ARSession()
    /// Live coverage of the current recording; drawn by ArkitPreviewView.
    let coverage = CoverageMap()
    /// True while a recording is running, i.e. while the overlay should show
    /// coverage colours instead of the plain scanning mesh.
    var coverageActive = false
    var onFrame: ((ARFrame) -> Void)?
    var onTrackingStateChange: ((ARCamera.TrackingState) -> Void)?
    private(set) var isRunning = false

    private override init() {
        super.init()
        session.delegate = self
    }

    /// Number of live preview views. The session is shared, so it must outlive
    /// any single view -- React Native can build the replacement view before
    /// tearing down the old one, and pausing on that teardown would kill a
    /// session that was just handed to the new view.
    private var viewCount = 0

    func start() {
        viewCount += 1
        guard !isRunning else { return }
        guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else { return }
        session.run(makeConfiguration())
        isRunning = true
    }

    private func makeConfiguration() -> ARWorldTrackingConfiguration {
        let config = ARWorldTrackingConfiguration()
        windowHighResAvailable = false
        if windowMode {
            // Window pass: photos only. No mesh or depth (the view is far past
            // LiDAR range and the phone stays cooler), and the video format that
            // allows full-sensor stills where the OS offers one.
            if #available(iOS 16.0, *),
               let format = ARWorldTrackingConfiguration.recommendedVideoFormatForHighResolutionFrameCapturing {
                config.videoFormat = format
                windowHighResAvailable = true
            }
            return config
        }
        // Classified mesh: window/door faces drive the live openings list and
        // are exported as opening hints (openings_hint.json). Same
        // reconstruction, one extra byte per face.
        config.sceneReconstruction =
            ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification)
            ? .meshWithClassification : .mesh
        // One depth stream, not two. Both used to be requested, but only the
        // smoothed map is saved; producing the raw one as well was pure load
        // on a phone that already runs mesh reconstruction and the camera.
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
            config.frameSemantics = [.smoothedSceneDepth]
        } else {
            config.frameSemantics = [.sceneDepth]
        }
        return config
    }

    /// Every video format world tracking offers on this phone, and which
    /// physical camera each one uses. Measurement only (0.5x question): if a
    /// row's device is the ultra wide camera, ARKit can track on 0.5x. Nothing
    /// here changes the running configuration.
    static func videoFormatReport() -> [[String: Any]] {
        ARWorldTrackingConfiguration.supportedVideoFormats.map { (format) -> [String: Any] in
            var row: [String: Any] = [
                "width": Int(format.imageResolution.width),
                "height": Int(format.imageResolution.height),
                "fps": format.framesPerSecond,
            ]
            if #available(iOS 16.0, *) {
                row["device"] = format.captureDeviceType.rawValue
                row["position"] = format.captureDevicePosition.rawValue
                row["highResRecommended"] = format.isRecommendedForHighResolutionFrameCapturing
            }
            print("[capture] video format \(row)")
            return row
        }
    }

    /// True while the window pass owns the session (see WindowShotSession).
    private(set) var windowMode = false
    /// The running configuration can take full-sensor stills.
    private(set) var windowHighResAvailable = false

    /// Switches the live session between the LiDAR scan configuration and the
    /// window pass one. Re-running without reset options keeps tracking, so the
    /// preview does not jump.
    func setWindowMode(_ on: Bool) {
        let apply = {
            guard self.windowMode != on else { return }
            self.windowMode = on
            if !on { self.unlockExposureAndWhiteBalance() }
            if self.isRunning { self.session.run(self.makeConfiguration()) }
        }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.sync(execute: apply) }
    }

    /// Balances `start()`. The session only actually stops once the last
    /// preview view is gone.
    ///
    /// This was the missing half: `pause()` existed but nothing ever called
    /// it, so after a scan the phone kept running LiDAR, mesh reconstruction
    /// and the camera at full rate until the app was force-quit. It got hot
    /// enough to be the first thing a user complained about.
    func stop() {
        viewCount = max(0, viewCount - 1)
        guard viewCount == 0 else { return }
        pause()
    }

    func pause() {
        guard isRunning else { return }
        // Every path that ends a session goes through here, so a lock taken
        // for a recording can never outlive it into the next live preview.
        unlockExposureAndWhiteBalance()
        session.pause()
        isRunning = false
        onFrame = nil
    }

    /// Holds exposure and white balance at their current values. No longer
    /// used for recordings (see `CameraSettings`); kept for passes that need a
    /// fixed exposure. Returns false where the OS or camera cannot lock.
    @discardableResult
    func lockExposureAndWhiteBalance() -> Bool {
        guard #available(iOS 16.0, *) else { return false }
        guard let device = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera
        else { return false }
        do {
            try device.lockForConfiguration()
        } catch {
            return false
        }
        defer { device.unlockForConfiguration() }
        let canLockExposure = device.isExposureModeSupported(.locked)
        let canLockWhiteBalance = device.isWhiteBalanceModeSupported(.locked)
        if canLockExposure { device.exposureMode = .locked }
        if canLockWhiteBalance { device.whiteBalanceMode = .locked }
        return canLockExposure && canLockWhiteBalance
    }

    /// Back to continuous auto, so the live preview adapts normally between
    /// scans. Safe to call when nothing is locked.
    func unlockExposureAndWhiteBalance() {
        guard #available(iOS 16.0, *) else { return }
        guard let device = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera
        else { return }
        do {
            try device.lockForConfiguration()
        } catch {
            return
        }
        defer { device.unlockForConfiguration() }
        if device.isExposureModeSupported(.continuousAutoExposure) {
            device.exposureMode = .continuousAutoExposure
        }
        if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
            device.whiteBalanceMode = .continuousAutoWhiteBalance
        }
    }

    // MARK: Camera settings per frame

    /// What the camera used for one frame. Recordings run on continuous auto
    /// exposure and white balance (a house mixes dark bedrooms and sunlit
    /// living rooms; one lock cannot serve both), so every kept frame carries
    /// its own values and the server brings all frames to one scale before
    /// training. Before this, a recording locked at Start: the 2026-10-02
    /// scan locked while a pink wallpaper filled the screen, auto white
    /// balance had called the pink grey, and every frame came out cyan.
    struct CameraSettings {
        let duration: Double
        let iso: Float
        let gains: AVCaptureDevice.WhiteBalanceGains
        /// Colour temperature (K) and tint the gains correspond to.
        let temperature: Float
        let tint: Float

        var asJSON: [String: Any] {
            [
                "exposure_duration": duration,
                "iso": iso,
                "wb_gains": [gains.redGain, gains.greenGain, gains.blueGain],
                "wb_temperature_k": temperature,
                "wb_tint": tint,
            ]
        }
    }

    /// Reads without `lockForConfiguration`: these are plain property reads,
    /// cheap enough for every kept frame.
    func readCameraSettings() -> CameraSettings? {
        guard #available(iOS 16.0, *),
              let d = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera
        else { return nil }
        let g = d.deviceWhiteBalanceGains
        // temperatureAndTintValues throws an exception for gains outside
        // 1...max; the device's own gains are always inside, but clamp anyway.
        let m = d.maxWhiteBalanceGain
        let safe = AVCaptureDevice.WhiteBalanceGains(
            redGain: min(max(g.redGain, 1), m),
            greenGain: min(max(g.greenGain, 1), m),
            blueGain: min(max(g.blueGain, 1), m))
        let tt = d.temperatureAndTintValues(for: safe)
        return CameraSettings(duration: d.exposureDuration.seconds, iso: d.iso, gains: g,
                              temperature: tt.temperature, tint: tt.tint)
    }

    /// Continuous auto exposure and white balance metered on the centre: the
    /// recording mode, and the way back after a vista bracket or a tap that
    /// moved the metering point.
    func beginMetering() {
        withDevice { d in
            if d.isExposurePointOfInterestSupported { d.exposurePointOfInterest = CGPoint(x: 0.5, y: 0.5) }
            if d.isExposureModeSupported(.continuousAutoExposure) { d.exposureMode = .continuousAutoExposure }
            if d.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                d.whiteBalanceMode = .continuousAutoWhiteBalance
            }
            d.setExposureTargetBias(0, completionHandler: nil)
        }
    }

    // MARK: Live openings (spec §4)

    /// Class codes shared with src/capture/openings.ts (not ARKit's raw values).
    static let clsWindow: Float = 1, clsDoor: Float = 2, clsFloor: Float = 3

    /// Window, door and floor face centres of the classified mesh, world
    /// space, flat [x, y, z, cls, ...]. Floor is thinned (every 8th face):
    /// it only gives the floor height. At most `maxPoints` points.
    func classifiedPoints(maxPoints: Int = 4000) -> [Float] {
        var out: [Float] = []
        var floorSeen = 0
        let window = UInt8(ARMeshClassification.window.rawValue)
        let door = UInt8(ARMeshClassification.door.rawValue)
        let floor = UInt8(ARMeshClassification.floor.rawValue)
        for anchor in currentMeshAnchors() {
            let g = anchor.geometry
            guard let cls = g.classification else { continue }
            let faces = g.faces
            let vtx = g.vertices
            let vbase = vtx.buffer.contents()
            let fbase = faces.buffer.contents()
            let cbase = cls.buffer.contents()
            func vertex(_ i: Int) -> simd_float3 {
                let p = vbase.advanced(by: vtx.offset + i * vtx.stride)
                    .assumingMemoryBound(to: (Float, Float, Float).self).pointee
                return simd_float3(p.0, p.1, p.2)
            }
            for f in 0..<faces.count {
                if out.count >= maxPoints * 4 { return out }
                let c = cbase.advanced(by: cls.offset + f * cls.stride)
                    .assumingMemoryBound(to: UInt8.self).pointee
                let code: Float
                if c == window {
                    code = Self.clsWindow
                } else if c == door {
                    code = Self.clsDoor
                } else if c == floor {
                    floorSeen += 1
                    guard floorSeen % 8 == 0 else { continue }
                    code = Self.clsFloor
                } else {
                    continue
                }
                let ip = fbase.advanced(by: f * faces.indexCountPerPrimitive * faces.bytesPerIndex)
                    .assumingMemoryBound(to: UInt32.self)
                let local = (vertex(Int(ip[0])) + vertex(Int(ip[1])) + vertex(Int(ip[2]))) / 3
                let w = anchor.transform * simd_float4(local, 1)
                out.append(contentsOf: [w.x, w.y, w.z, code])
            }
        }
        return out
    }

    /// Luma (0..255) of the current camera image at each world point, -1 when
    /// the point is behind the camera or outside the image. Flat [x, y, z, ...].
    func sampleLuma(_ flat: [Double]) -> [Int] {
        let none = Array(repeating: -1, count: flat.count / 3)
        guard let frame = session.currentFrame else { return none }
        let buf = frame.capturedImage
        CVPixelBufferLockBaseAddress(buf, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }
        guard CVPixelBufferGetPlaneCount(buf) >= 1,
              let base = CVPixelBufferGetBaseAddressOfPlane(buf, 0)
        else { return none }
        let w = CVPixelBufferGetWidthOfPlane(buf, 0)
        let h = CVPixelBufferGetHeightOfPlane(buf, 0)
        let row = CVPixelBufferGetBytesPerRowOfPlane(buf, 0)
        let luma = base.assumingMemoryBound(to: UInt8.self)
        let cam = frame.camera
        let toCam = cam.transform.inverse
        let size = cam.imageResolution
        var out: [Int] = []
        out.reserveCapacity(flat.count / 3)
        var i = 0
        while i + 2 < flat.count {
            let p = simd_float3(Float(flat[i]), Float(flat[i + 1]), Float(flat[i + 2]))
            i += 3
            // The camera looks down its own -Z: z >= 0 is behind it.
            if (toCam * simd_float4(p, 1)).z >= 0 { out.append(-1); continue }
            let s = cam.projectPoint(p, orientation: .landscapeRight, viewportSize: size)
            let px = Int(s.x * CGFloat(w) / size.width)
            let py = Int(s.y * CGFloat(h) / size.height)
            guard px >= 0, py >= 0, px < w, py < h else { out.append(-1); continue }
            out.append(Int(luma[py * row + px]))
        }
        return out
    }

    /// World point under a tap on the portrait preview (x, y in 0..1 of a view
    /// of `viewW` x `viewH` points), or nil. Estimated planes of any
    /// orientation: the tap is on a window frame.
    func raycast(x: Double, y: Double, viewW: Double, viewH: Double) -> [Float]? {
        guard let frame = session.currentFrame, viewW > 0, viewH > 0 else { return nil }
        let toImage = frame.displayTransform(for: .portrait,
                                             viewportSize: CGSize(width: viewW, height: viewH)).inverted()
        let p = CGPoint(x: x, y: y).applying(toImage)
        let q = frame.raycastQuery(from: p, allowing: .estimatedPlane, alignment: .any)
        guard let hit = session.raycast(q).first else { return nil }
        let t = hit.worldTransform.columns.3
        return [t.x, t.y, t.z]
    }

    // MARK: Window pass exposure

    struct ExposureState {
        let duration: CMTime
        let iso: Float
    }

    private func withDevice(_ body: (AVCaptureDevice) -> Void) {
        guard #available(iOS 16.0, *),
              let device = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera
        else { return }
        do {
            try device.lockForConfiguration()
        } catch {
            return
        }
        defer { device.unlockForConfiguration() }
        body(device)
    }

    /// Meters on the tapped point and keeps adapting there. `x`, `y` are 0..1
    /// in the portrait preview; the sensor is landscape (home side right), so
    /// the point is rotated into the device's own coordinates.
    func setExposurePoint(x: Double, y: Double) {
        withDevice { device in
            let p = CGPoint(x: min(max(y, 0), 1), y: min(max(1 - x, 0), 1))
            if device.isExposurePointOfInterestSupported {
                device.exposurePointOfInterest = p
            }
            if device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposureMode = .continuousAutoExposure
            }
            device.setExposureTargetBias(0, completionHandler: nil)
        }
    }

    func currentExposure() -> ExposureState? {
        var state: ExposureState?
        withDevice { device in
            state = ExposureState(duration: device.exposureDuration, iso: device.iso)
        }
        return state
    }

    func currentISO() -> Float {
        var iso: Float = 0
        withDevice { iso = $0.iso }
        return iso
    }

    /// Sets `base` shifted by `evBias` stops: longer or shorter shutter first,
    /// ISO only past the shutter's limits. White balance is held for the
    /// bracket so the three shots differ in brightness alone.
    func applyExposure(base: ExposureState?, evBias: Float) {
        withDevice { device in
            if device.isWhiteBalanceModeSupported(.locked) {
                device.whiteBalanceMode = .locked
            }
            guard let base = base, device.isExposureModeSupported(.custom) else {
                device.setExposureTargetBias(evBias, completionHandler: nil)
                return
            }
            let format = device.activeFormat
            var seconds = base.duration.seconds * pow(2.0, Double(evBias))
            var iso = base.iso
            let maxS = format.maxExposureDuration.seconds
            let minS = format.minExposureDuration.seconds
            if seconds > maxS {
                iso *= Float(seconds / maxS)
                seconds = maxS
            } else if seconds < minS {
                iso *= Float(seconds / minS)
                seconds = minS
            }
            iso = min(max(iso, format.minISO), format.maxISO)
            device.setExposureModeCustom(
                duration: CMTime(seconds: seconds, preferredTimescale: 1_000_000_000),
                iso: iso, completionHandler: nil)
        }
    }

    /// Back to metering on the tapped point after a bracket.
    func resumeAutoExposure() {
        withDevice { device in
            if device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposureMode = .continuousAutoExposure
            }
            if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                device.whiteBalanceMode = .continuousAutoWhiteBalance
            }
        }
    }

    /// All LiDAR-reconstructed mesh anchors currently tracked by the session.
    /// This is the same geometry drawn as the on-screen blue overlay -- ARKit
    /// has already fused every depth frame into these meshes, so exporting them
    /// gives us a clean world-space point cloud with no COLMAP/parallax needed.
    func currentMeshAnchors() -> [ARMeshAnchor] {
        return (session.currentFrame?.anchors ?? []).compactMap { $0 as? ARMeshAnchor }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        onFrame?(frame)
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        onTrackingStateChange?(camera.trackingState)
    }
}
