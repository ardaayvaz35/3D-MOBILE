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

    func start() {
        guard !isRunning else { return }
        guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else { return }
        let config = ARWorldTrackingConfiguration()
        config.sceneReconstruction = .mesh
        config.frameSemantics = [.sceneDepth, .smoothedSceneDepth]
        session.run(config)
        isRunning = true
    }

    func pause() {
        session.pause()
        isRunning = false
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        onFrame?(frame)
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        onTrackingStateChange?(camera.trackingState)
    }
}
