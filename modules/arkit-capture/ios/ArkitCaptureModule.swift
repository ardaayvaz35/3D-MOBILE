import ExpoModulesCore
import ARKit

public class ArkitCaptureModule: Module {
  private var captureManager: CaptureManager?
  private var windowSession: WindowShotSession?

  public func definition() -> ModuleDefinition {
    Name("ArkitCapture")

    Events("onFrameCaptured", "onTrackingStateChanged", "onGuidance", "onPose", "onObjects")

    Function("isLidarSupported") { () -> Bool in
      ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        && ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }

    // Measurement for the 0.5x question; see ArkitSessionHost.videoFormatReport.
    Function("getVideoFormats") { () -> [String: Any] in
      ["formats": ArkitSessionHost.videoFormatReport()]
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
        }, onGuidance: { payload in
          self.sendEvent("onGuidance", payload)
        }, onPose: { payload in
          self.sendEvent("onPose", payload)
        }, onObjects: { payload in
          self.sendEvent("onObjects", payload)
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

    // Exposure segments, live openings and the vista pass, inside a running
    // recording (spec 2026-09-30-pencere-manzara-design.md §4).
    AsyncFunction("beginSegment") { (outdoor: Bool, promise: Promise) in
      guard let m = self.captureManager else {
        promise.reject("NO_SESSION", "Recording was not started"); return
      }
      DispatchQueue.main.async { m.beginSegment(outdoor: outdoor) { id in promise.resolve(id) } }
    }

    // Object mode (spec 2026-10-02-uygulama-mimarisi.md §3.3-3.6).
    Function("setCaptureMode") { (mode: String, objectId: String?) -> Void in
      self.captureManager?.setCaptureMode(mode, objectId: objectId)
    }

    Function("setObjectBoxes") { (json: String) -> Void in
      guard let data = json.data(using: .utf8),
            let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
      self.captureManager?.setObjectBoxes(arr)
    }

    // Finished pieces: boxes (same JSON as setObjectBoxes) whose mesh turns green.
    Function("setDoneObjectBoxes") { (json: String) -> Void in
      guard let data = json.data(using: .utf8),
            let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
      ArkitSessionHost.shared.setDoneBoxes(arr.compactMap { DoneBox(json: $0) })
    }

    // Dome shell around the current piece (ArkitPreviewView.rebuildDome); "" removes it.
    Function("setDome") { (json: String) -> Void in
      ArkitSessionHost.shared.setDome(json.isEmpty ? nil : json)
    }

    AsyncFunction("classifiedPoints") { (promise: Promise) in
      DispatchQueue.global(qos: .utility).async {
        promise.resolve(ArkitSessionHost.shared.classifiedPoints().map { Double($0) })
      }
    }

    Function("sampleLuma") { (points: [Double]) -> [Int] in
      ArkitSessionHost.shared.sampleLuma(points)
    }

    Function("raycast") { (x: Double, y: Double, viewW: Double, viewH: Double) -> [Double]? in
      ArkitSessionHost.shared.raycast(x: x, y: y, viewW: viewW, viewH: viewH)?.map { Double($0) }
    }

    Function("setOpeningsHint") { (json: String) -> Void in
      guard let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
      self.captureManager?.setOpeningsHint(obj)
    }

    Function("startVista") { (role: String) -> String in
      guard let m = self.captureManager else { return "" }
      return m.startVista(role: role)
    }

    AsyncFunction("captureVistaShot") { (promise: Promise) in
      guard let m = self.captureManager else {
        promise.reject("NO_SESSION", "Recording was not started"); return
      }
      m.captureVistaShot { result in
        switch result {
        case .success(let (n, normal)): promise.resolve(["shotCount": n, "trackingNormal": normal])
        case .failure(let e): promise.reject("CAPTURE_FAILED", e.localizedDescription)
        }
      }
    }

    AsyncFunction("endVista") { (openingIds: [String], promise: Promise) in
      guard let m = self.captureManager else { promise.resolve(0); return }
      DispatchQueue.main.async {
        do {
          promise.resolve(try m.endVista(openingIds: openingIds))
        } catch {
          promise.reject("VISTA_FAILED", error.localizedDescription)
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
