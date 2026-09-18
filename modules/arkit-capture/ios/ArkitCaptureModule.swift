import ExpoModulesCore
import ARKit

public class ArkitCaptureModule: Module {
  private var captureManager: CaptureManager?
  private var windowSession: WindowShotSession?

  public func definition() -> ModuleDefinition {
    Name("ArkitCapture")

    Events("onFrameCaptured", "onTrackingStateChanged")

    Function("isLidarSupported") { () -> Bool in
      ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        && ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }

    Function("startRecording") { () -> Void in
      if self.captureManager == nil {
        self.captureManager = CaptureManager(onFrame: { count, angleCoverage, bytesUsed, limitReached, tooFast, thermalState in
          self.sendEvent("onFrameCaptured", [
            "frameCount": count,
            "angleCoverage": angleCoverage,
            "bytesUsed": bytesUsed,
            "storageLimitReached": limitReached,
            "movingTooFast": tooFast,
            "thermalState": thermalState,
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

    // Window pass: single bracketed photos of the view (see WindowShotSession).
    Function("beginWindowScan") { () -> Void in
      self.windowSession?.cancel()
      self.windowSession = WindowShotSession()
    }

    Function("setExposurePoint") { (x: Double, y: Double) -> Void in
      ArkitSessionHost.shared.setExposurePoint(x: x, y: y)
    }

    AsyncFunction("captureWindowShot") { (promise: Promise) in
      guard let window = self.windowSession else {
        promise.reject("NO_WINDOW_SCAN", "Window scan was not started")
        return
      }
      window.captureGroup { result in
        switch result {
        case .success(let groups): promise.resolve(["shotCount": groups])
        case .failure(let error): promise.reject("CAPTURE_FAILED", error.localizedDescription)
        }
      }
    }

    AsyncFunction("finishWindowScan") { (promise: Promise) in
      guard let window = self.windowSession else {
        promise.reject("NO_WINDOW_SCAN", "Window scan was not started")
        return
      }
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let result = try window.finish()
          self.windowSession = nil
          promise.resolve([
            "archivePath": result.path,
            "photoCount": result.shots,
            "shotCount": result.groups,
          ])
        } catch {
          promise.reject("EXPORT_FAILED", error.localizedDescription)
        }
      }
    }

    Function("cancelWindowScan") { () -> Void in
      self.windowSession?.cancel()
      self.windowSession = nil
    }

    // Live camera + AR preview -- so scanning is no longer blind. Owns the
    // shared ARSession (see ArkitSessionHost); CaptureManager attaches to it
    // as a frame sink when recording starts.
    View(ArkitPreviewView.self) { }
  }
}
