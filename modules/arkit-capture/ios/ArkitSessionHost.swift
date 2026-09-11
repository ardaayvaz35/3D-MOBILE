import ARKit

/// Single shared ARSession owned by the live preview view, so the camera
/// feed actually renders on screen. ARKit only allows one active capture
/// session at a time, so CaptureManager no longer creates its own session --
/// it attaches as a frame sink here instead.
final class ArkitSessionHost: NSObject, ARSessionDelegate {
    static let shared = ArkitSessionHost()

    let session = ARSession()
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
        let config = ARWorldTrackingConfiguration()
        config.sceneReconstruction = .mesh
        config.frameSemantics = [.sceneDepth, .smoothedSceneDepth]
        session.run(config)
        isRunning = true
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
        session.pause()
        isRunning = false
        onFrame = nil
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
