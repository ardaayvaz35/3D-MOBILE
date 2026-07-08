import ExpoModulesCore
import ARKit

public class ArkitCaptureModule: Module {
  private var captureManager: CaptureManager?

  public func definition() -> ModuleDefinition {
    Name("ArkitCapture")

    Events("onFrameCaptured", "onTrackingStateChanged")

    Function("isLidarSupported") { () -> Bool in
      ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        && ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }

    Function("startRecording") { () -> Void in
      if self.captureManager == nil {
        self.captureManager = CaptureManager(onFrame: { count, angleCoverage in
          self.sendEvent("onFrameCaptured", [
            "frameCount": count,
            "angleCoverage": angleCoverage,
          ])
        })
      }
      self.captureManager?.startRecording()
    }

    AsyncFunction("stopRecording") { (promise: Promise) in
      guard let manager = self.captureManager else {
        promise.reject("NO_SESSION", "Recording was not started")
        return
      }
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let result = try manager.stopRecordingAndExport()
          manager.teardown()
          self.captureManager = nil
          promise.resolve([
            "archivePath": result.archivePath,
            "frameCount": result.frameCount,
            "durationSeconds": result.durationSeconds,
          ])
        } catch {
          promise.reject("EXPORT_FAILED", error.localizedDescription)
        }
      }
    }

    // Live camera + AR preview -- so scanning is no longer blind. Owns the
    // shared ARSession (see ArkitSessionHost); CaptureManager attaches to it
    // as a frame sink when recording starts.
    View(ArkitPreviewView.self) { }
  }
}
