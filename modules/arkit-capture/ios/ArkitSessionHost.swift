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
        config.sceneReconstruction = .mesh
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

    /// Holds exposure and white balance fixed for the length of a recording.
    ///
    /// Left on auto, the camera re-exposed as the phone swept past the window:
    /// on a real 241-frame scan one physical wall point varied 11.9% in
    /// brightness (median; 27% peak-to-peak) across the frames that saw it.
    /// Gaussian splatting assumes a point has one colour, so it resolved the
    /// contradiction by smearing gaussians until each view's average matched
    /// -- the streaky "wet paint" walls. Locked, every frame shares one
    /// exposure and the server's bilateral grid only absorbs what remains.
    ///
    /// Taken at the moment recording starts, so starting while pointed at a
    /// normally lit part of the room matters. Returns false where the OS or
    /// camera cannot lock (before iOS 16); recording proceeds unlocked.
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
