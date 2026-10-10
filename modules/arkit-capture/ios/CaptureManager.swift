import ARKit
import AVFoundation
import CoreVideo
import simd

/// ARKit LiDAR capture. Attaches to the shared ArkitSessionHost (owned by
/// the live preview view) as a frame sink -- it no longer owns its own
/// ARSession. Captures per frame:
///   - RGB frame (JPEG)
///   - Scene depth (raw little-endian UInt16, millimeters, no header)
///   - Confidence map (raw UInt8, 0=low 1=medium 2=high, no header)
///   - Camera pose (world-space 4x4)
///   - Camera intrinsics (fx, fy, cx, cy)
///
/// Also tracks a coarse "angle coverage" heuristic: buckets the camera's
/// heading (yaw) into 12 sectors around a full circle and reports what
/// fraction have been visited. This is NOT true surface-coverage detection
/// (that needs the ARKit mesh + occlusion analysis) -- it's a cheap proxy
/// that still catches the single most common bad-scan pattern: standing
/// still and only panning, or only covering one side of the object.
struct ExposureInfo {
    let control: String       // "fast" (FastExposure) or "auto" (iOS)
    let errorEV: Float
    let clip: Float
    let toneMapping: String   // "on" / "off" / "unsupported"
}

class CaptureManager {

    struct FrameData {
        let index: Int
        let timestamp: TimeInterval
        let rgbPath: String
        let depthPath: String
        let confidencePath: String
        let intrinsics: simd_float3x3
        let transform: simd_float4x4
        // JPEG'in gercek boyutlari. Kare kucultuldugunde intrinsics de ayni
        // oranda olceklenir; metadata'ya sabit deger yazmak COLMAP'i yaniltir.
        let imageWidth: Int
        let imageHeight: Int
        // Derinlik izgarasinin boyutlari (LiDAR cihazlarda 256x192). Ham
        // tampon basliksiz yazildigi icin sunucu bunlar olmadan veriyi
        // yeniden sekillendiremez; sabit varsaymak da cihaz degisince bozar.
        let depthWidth: Int
        let depthHeight: Int
        // Exposure the frame was actually taken at. Recordings run on auto
        // exposure, so these change between frames and the server uses them
        // to bring every frame to one brightness and colour scale.
        let exposureDuration: Double
        let exposureOffset: Float
        /// ISO, white-balance gains and their colour temperature; nil when the
        /// device could not be read (before iOS 16).
        let camera: ArkitSessionHost.CameraSettings?
        /// Who drove the exposure and how far off the metering was when the
        /// frame was kept, the share of clipped pixels, and the tone curve mode.
        let exposureInfo: ExposureInfo
        /// ARKit's own light estimate for the frame (lumens ~1000 = neutral,
        /// Kelvin), independent of the camera's white balance.
        let lightIntensity: Double?
        let lightTemperature: Double?
        // ProcessInfo.ThermalState raw value (0 nominal .. 3 critical) when the
        // frame was taken, and how long saving it took. Recorded so the next
        // "the phone got hot" report is a measurement, not a guess.
        let thermalState: Int
        let processMs: Double
        /// Bytes written for this frame (JPEG + depth + confidence), so a
        /// sharper replacement can give them back to the budget.
        let bytes: Int
        /// Exposure segment the frame was taken in (0 = room, spec §4).
        let segment: Int
        /// Object whose walk-around this frame belongs to; nil = room frame.
        let objectId: String?
        /// True when exposure and white balance were locked for this frame
        /// (object mode); false = continuous auto.
        let exposureLocked: Bool
    }

    struct ExportResult {
        let archivePath: String
        let frameCount: Int
        let durationSeconds: Double
    }

    private static let angleSectorCount = 12

    // Frame SELECTION, not a frame rate. A blind ~3 fps throttle spent the
    // whole byte budget in 2.6 minutes -- and spent most of it on frames that
    // teach the reconstruction nothing: standing still produces near-identical
    // views, and whipping the phone around produces motion-blurred ones. A
    // measured scan showed the cost of that: 86 frames over 28 s along a
    // camera path only 1.65 m long, visibly blurred, covering 3.03 m of a
    // 5.73 m room. 3DGS wants angular coverage and sharp frames, so select on
    // exactly those two things and the same budget reaches around a whole room.
    //
    // Cadence. ARKit delivers 60 fps; a splat wants the same surface in many
    // frames from slightly different places, not 60 near-identical copies.
    // Measured on the two real scans: 0.5 s spacing (241 frames / 160 s)
    // trained tolerably; the previous gates thinned the next scan to 1.5 s
    // spacing (281 frames over 592 s and 75 m of path, one frame per 27 cm)
    // and every surface seen in only 2-3 frames exploded into spikes. The
    // fix is to SELECT a sharp frame every window, never to skip a window:
    // at 4 fps a 5-minute room is ~1200 frames.
    private static let frameInterval: TimeInterval = 0.25
    // Heat. iOS reports .serious before it starts throttling the SoC and
    // .critical just before it would kill a hot app. At .serious the cadence
    // halves; at .critical no more frames are taken and the screen tells the
    // user to finish. A phone that got "hot as fire" on half a room was running
    // at full rate the whole time.
    private static let hotFrameInterval: TimeInterval = 0.5
    // Novelty (guided capture, the user's rule): a frame is not kept when an
    // already kept one stands within 5 cm horizontally (inside the same
    // height band) and looks within 3 deg of it -- photo warps are near
    // perfect up to ~3 deg, so it adds nothing. If the new one is clearly
    // sharper it takes the old one's place instead. The earlier rule only
    // compared with the LAST kept frame (2 cm / 2 deg), so walking back over
    // the same spot filled the budget with copies. On 158a72c2 dropping at
    // 3 cm / 5 deg lost 1.3% of the information; 3 deg is stricter.
    private static let dedupMeters: Float = 0.05
    private static let dedupHeightMeters: Float = 0.07
    private static let dedupRadians: Float = 3.0 * .pi / 180.0
    /// Replace only when the new frame's smear is below this share of the old.
    private static let sharperFactor: Float = 0.7
    private struct KeptPose {
        let index: Int
        var transform: simd_float4x4
        var smear: Float
    }
    private var keptPoses: [KeptPose] = []
    /// 5 cm x-z grid cell -> slots in `keptPoses`.
    private var keptGrid: [Int64: [Int]] = [:]
    private var replacedSharper = 0
    private var framesInBand = 0
    // Blur. The smear in pixels is (angular speed + linear speed / distance)
    // x exposure x focal length, all known at the frame instant. 12 px of a
    // 1920 px frame at a 1/60 s exposure allows ~28 deg/s of panning, about
    // what a careful walk does. The old 6 px (14 deg/s) rejected most of a
    // normal scan; on the reference scan (median 20 deg/s) only 1 of 241
    // frames was actually smeared, so the physics threshold was simply set
    // too tight. Inside a window we wait for a sharp frame instead of
    // dropping the window; if none arrives for `starvedAfter` seconds the
    // threshold is relaxed so the gap cannot grow past that.
    private static let maxSmearPixels: Float = 12.0
    private static let starvedAfter: TimeInterval = 1.0
    private static let starvedSmearFactor: Float = 3.0
    // Scene distance assumed for the linear-speed term. Indoors the camera is
    // 1-3 m from what it films; 1.5 m errs on the strict side.
    private static let nominalDepthMeters: Float = 1.5
    // Absolute ceiling regardless of exposure: past this ARKit's own pose
    // tracking degrades, whatever the pixels look like.
    private static let maxAngularSpeed: Float = 1.2  // rad/s
    // After this many consecutive blur rejections (~60 Hz), tell the user.
    private static let tooFastAfterSkips = 30
    private var lastCaptureTime: TimeInterval = 0
    private var previousTransform: simd_float4x4?
    private var previousTimestamp: TimeInterval = 0
    private var blurStreak = 0
    private(set) var skippedBlurred = 0
    private(set) var skippedRedundant = 0
    private(set) var skippedBusy = 0
    /// Frames not kept because the exposure was still settling (FastExposure).
    private(set) var skippedExposure = 0
    /// What drove the exposure this recording ("fast" / "auto") and the tone
    /// curve mode, read when the recording started (stop() resets them).
    private var exposureControlUsed = "auto"
    private var toneMappingUsed = "off"
    private var maxThermalState = 0

    // Saving a frame (JPEG encode of a 1920x1440 image, depth and confidence
    // files, coverage update) used to run inside the ARSession delegate, i.e.
    // on the MAIN thread, four times a second. That froze the UI and made
    // ARKit wait for its frames back -- the lag and much of the heat. Saving
    // now runs on this serial queue, one frame at a time: if the previous
    // frame is still being written, the new one is skipped instead of queued,
    // so a phone that slows down under heat takes fewer frames rather than
    // piling up memory.
    private let workQueue = DispatchQueue(label: "arkit-capture.frames", qos: .userInitiated)
    // Guards everything the work queue and the delegate thread both touch:
    // frames, frameCount, imageBytesUsed, budgetReached, workInFlight.
    private let stateLock = NSLock()
    private var workInFlight = false
    private var nextIndex = 0

    // Arsiv Cloudflare R2'ye yuklendigi icin nesne basina pratik bir sinir yok
    // (tek PUT ile 5 GB). Onceki 34 MB butcesi Supabase'in 50 MB nesne
    // sinirindan geliyordu ve kareleri 1280 piksele, %60 JPEG kalitesine
    // dusurmeyi zorunlu kiliyordu -- splat kalitesini asil sinirlayan sey buydu.
    //
    // Artik ARKit'in verdigi cozunurlugu (1920x1440) oldugu gibi, gorsel olarak
    // kayipsiz sayilabilecek bir kalitede gonderiyoruz. Butce yine var, ama
    // artik depolama sinirini degil yukleme suresini ve telefon isinmasini
    // sinirliyor: ~700 KB/kare ile 400+ kareye yetiyor, ki olculen en uzun
    // tarama 186 kare kullandi.
    private static let imageByteBudget = 1200 * 1024 * 1024
    private static let jpegQuality: Double = 0.85
    private static let targetLongEdge: CGFloat = 1920
    private var imageBytesUsed = 0
    private var budgetReached = false

    // CIContext kurulumu pahali. Her karede yenisini yaratmak tarama sirasinda
    // gozle gorulur takilmaya yol aciyordu.
    private lazy var ciContext = CIContext()

    /// (frameCount, angleCoveragePct 0..1, kullanilanBayt, butceDoldu, cokHizli, isiDurumu 0..3)
    private let onFrame: (Int, Double, Int, Bool, Bool, Int) -> Void
    private let onGuidance: ([String: Any]) -> Void
    private var guidance: GuidanceEngine?
    private(set) var isRecording = false
    private var frameCount = 0
    private var frames: [FrameData] = []
    private var recordingStart: Date?
    private var visitedSectors = Set<Int>()

    // Segments (spec §4): 0 is the room. Exposure is continuous auto for the
    // whole recording, so a segment is only a label (indoor / outdoor) plus
    // the camera settings at the moment it began; every frame carries its
    // own settings anyway.
    private var segments: [[String: Any]] = []
    private var currentSegment = 0
    /// Frames are not kept while a vista pass runs (its brackets set a custom
    /// exposure) or while auto exposure settles back afterwards.
    private var framesPaused = false
    private var vista: WindowShotSession?
    private var vistaInfo: [String: Any] = [:]
    private var vistas: [[String: Any]] = []
    private var vistaCount = 0
    private var controlCount = 0
    private var lastPoseEmit: TimeInterval = 0
    /// Live openings as the screen last saw them (openings_hint.json body).
    private var openingsHint: [String: Any]?
    private let onPose: ([String: Any]) -> Void

    // Object mode (spec 2026-10-02-uygulama-mimarisi.md §3.3-3.6). The mode
    // machine lives in JS (src/capture/objectMode.ts); native only tags frames,
    // frees the height and pauses frames on the black transition screens.
    // Main thread.
    private var captureMode = "room"
    private var objectId: String?
    /// Exposure and white balance are locked while in object mode (one piece's
    /// frames then share one exposure; auto varied up to 4.5x while walking
    /// around a dresser). `exposureLocked` = the lock fully took;
    /// `exposureLockTried` = we touched the device, so leaving must restore auto.
    /// `exposureEpoch` invalidates delayed lock / settle blocks after a mode flip.
    private var exposureLocked = false
    private var exposureLockTried = false
    private var exposureEpoch = 0
    /// CACurrentMediaTime of the last return to auto metering (lock or vista).
    private var lastMeteringAt: CFTimeInterval = 0
    /// Boxes the user scanned, ARKit world, as objects.json wants them.
    private var objectBoxes: [[String: Any]] = []
    /// metadata.json `house` block (spec 2026-10-05 §4.2), set by JS while recording.
    private var houseInfo: [String: Any]?
    private var finder: ObjectFinder?
    private let onObjects: ([String: Any]) -> Void

    init(onFrame: @escaping (Int, Double, Int, Bool, Bool, Int) -> Void,
         onGuidance: @escaping ([String: Any]) -> Void,
         onPose: @escaping ([String: Any]) -> Void,
         onObjects: @escaping ([String: Any]) -> Void) {
        self.onFrame = onFrame
        self.onGuidance = onGuidance
        self.onPose = onPose
        self.onObjects = onObjects
    }

    /// Clears lock state and cancels delayed blocks. Hops to the main thread,
    /// where every other reader and writer of this state lives.
    private func resetExposureLock(arm: Bool, wait: Bool) {
        let reset = {
            self.exposureEpoch += 1
            self.exposureLocked = false
            self.exposureLockTried = false
            // Set with the reset at start, cleared at stop: always on main.
            if arm {
                ArkitSessionHost.shared.onRerun = { [weak self] in self?.exposureMayHaveReset() }
            } else {
                ArkitSessionHost.shared.onRerun = nil
            }
        }
        if Thread.isMainThread { reset() }
        else if wait { DispatchQueue.main.sync(execute: reset) }
        else { DispatchQueue.main.async(execute: reset) }
    }

    /// ARKit re-ran its configuration mid-recording (RoomPlan gave the session
    /// back). Whether that drops the camera's locked exposure is not known, so
    /// the lock is re-applied while one is meant to be held.
    private func exposureMayHaveReset() {
        guard isRecording, exposureLockTried, captureMode != "room", vista == nil else { return }
        // Until the lock is back, frames are neither kept nor tagged as locked.
        // (The re-lock freezes the current auto values; re-applying the first
        // lock's exact values would need custom-exposure calls in the host.)
        exposureLocked = false
        framesPaused = true
        let epoch = exposureEpoch
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self, self.isRecording, self.exposureEpoch == epoch,
                  self.exposureLockTried, self.captureMode != "room", self.vista == nil else { return }
            self.exposureLocked = ArkitSessionHost.shared.lockExposureAndWhiteBalance()
            self.framesPaused = false
        }
    }

    /// Main thread. Waits for auto exposure to settle, then freezes it, so the
    /// lock never grabs a frame full of one wall colour.
    private func beginExposureLock() {
        guard !exposureLockTried else { return }  // already locked (paused -> object)
        exposureEpoch += 1
        let epoch = exposureEpoch
        // Frames wait for the lock so every object frame is locked. Whoever
        // bumps the epoch (end of lock, vista, stop) owns clearing this pause.
        framesPaused = true
        // At least 0.5 s, and never before auto has had its settle time since
        // the last return to auto metering.
        let sinceMetering = CACurrentMediaTime() - lastMeteringAt
        let delay = max(0.5, Self.autoSettleSeconds - sinceMetering)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.isRecording, self.exposureEpoch == epoch,
                  self.captureMode == "object", self.vista == nil else { return }
            self.exposureLockTried = true
            self.exposureLocked = ArkitSessionHost.shared.lockExposureAndWhiteBalance()
            self.framesPaused = false
        }
    }

    /// Main thread. Back to continuous centre-metered auto, frames not kept
    /// while it re-settles (same gate as after a vista pass).
    private func endExposureLock() {
        exposureEpoch += 1
        let epoch = exposureEpoch
        if exposureLockTried {
            exposureLockTried = false
            exposureLocked = false
            ArkitSessionHost.shared.beginMetering()
            lastMeteringAt = CACurrentMediaTime()
        }
        // Also when the lock never happened: a pending lock block paused frames.
        framesPaused = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.autoSettleSeconds) { [weak self] in
            guard let self = self, self.exposureEpoch == epoch, self.vista == nil else { return }
            self.framesPaused = false
        }
    }

    /// "room" | "object" | "paused" (black transition screen: the session
    /// keeps tracking, frames are not kept).
    func setCaptureMode(_ mode: String, objectId: String?) {
        let apply = {
            let was = self.captureMode
            self.captureMode = mode
            self.objectId = mode == "object" ? objectId : nil
            self.guidance?.heightFree = mode != "room"
            if self.isRecording && mode != was {
                if mode == "object" {
                    // The object lock freezes the exposure; the fast exposure steps aside
                    // (tone mapping stays, one curve for the whole scan).
                    FastExposure.shared.pauseControl()
                    self.beginExposureLock()
                } else if mode == "room" {
                    self.endExposureLock()
                    if self.vista == nil { FastExposure.shared.start() }
                }
                // "paused" keeps the lock until room mode resumes.
            }
        }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    }

    func setHouseInfo(_ info: [String: Any]) {
        let apply = { self.houseInfo = info }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    }

    /// The boxes of the objects scanned in object mode (JS sends the final list).
    func setObjectBoxes(_ boxes: [[String: Any]]) {
        let apply = { self.objectBoxes = boxes }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    }

    /// Yukleme butcesinin ne kadari kullanildi (0..1).
    var byteBudgetFraction: Double {
        stateLock.lock(); defer { stateLock.unlock() }
        return min(1.0, Double(imageBytesUsed) / Double(Self.imageByteBudget))
    }

    func startRecording() {
        stateLock.lock()
        frames.removeAll()
        frameCount = 0
        imageBytesUsed = 0
        budgetReached = false
        workInFlight = false
        replacedSharper = 0
        framesInBand = 0
        stateLock.unlock()
        lastCaptureTime = 0
        nextIndex = 0
        skippedBusy = 0
        skippedExposure = 0
        maxThermalState = 0
        visitedSectors.removeAll()
        keptPoses.removeAll()
        keptGrid.removeAll()
        previousTransform = nil
        previousTimestamp = 0
        skippedBlurred = 0
        skippedRedundant = 0
        blurStreak = 0
        // The capture directory is reused across scans and the archive is now
        // zipped straight from it, so anything a previous scan left behind
        // would be shipped inside this one. Start from an empty directory.
        try? FileManager.default.removeItem(at: tempDir)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        // Continuous auto white balance, metered on the centre, and our own
        // fast exposure on top: each room is exposed for its own light within
        // a few camera frames. See CameraSettings and FastExposure.
        ArkitSessionHost.shared.beginMetering()
        FastExposure.shared.start()
        exposureControlUsed = FastExposure.shared.lastControl
        toneMappingUsed = FastExposure.shared.toneMapping
        segments.removeAll()
        vistas.removeAll()
        vista = nil
        vistaCount = 0
        controlCount = 0
        framesPaused = false
        // Async: this runs on the JS thread; blocking on main could deadlock.
        resetExposureLock(arm: true, wait: false)
        currentSegment = 0
        openingsHint = nil
        ArkitSessionHost.shared.coverage.reset()
        ArkitSessionHost.shared.coverageActive = true
        guidance?.shutdown()
        guidance = GuidanceEngine(coverage: ArkitSessionHost.shared.coverage, emit: onGuidance)
        captureMode = "room"
        objectId = nil
        objectBoxes = []
        houseInfo = nil
        let finder = ObjectFinder(emit: onObjects)
        self.finder = finder
        DispatchQueue.main.async { finder.start() }
        isRecording = true
        recordingStart = Date()
        ArkitSessionHost.shared.onFrame = { [weak self] frame in
            self?.handle(frame: frame)
        }
    }

    func stopRecordingAndExport() throws -> ExportResult {
        if vista != nil { _ = try? endVista(openingIds: []) }
        isRecording = false
        FastExposure.shared.stop()
        // Let the frame being written finish, so it is in the archive and its
        // files are not zipped half-written.
        workQueue.sync {}
        stateLock.lock()
        // By index: a sharper replacement was appended at the end.
        let savedFrames = frames.sorted { $0.index < $1.index }
        let bytesUsed = imageBytesUsed
        let replaced = replacedSharper
        let inBandCount = framesInBand
        stateLock.unlock()
        resetExposureLock(arm: false, wait: true)
        ArkitSessionHost.shared.unlockExposureAndWhiteBalance()
        ArkitSessionHost.shared.coverageActive = false
        let finderFacts: [String: Any]
        var roomJSON: Data? = nil
        if let f = finder {
            if Thread.isMainThread { f.stop() } else { DispatchQueue.main.sync { f.stop() } }
            finderFacts = f.facts
            roomJSON = f.roomJSON
        } else {
            finderFacts = ["status": "off"]
        }
        finder = nil
        let boxes = objectBoxes
        guidance?.shutdown()
        let lockedHeight = guidance?.lockedHeight
        guidance = nil

        // Grab the fused LiDAR mesh BEFORE clearing the frame sink / tearing
        // down: these ARMeshAnchors are ARKit's realtime reconstruction (the
        // blue overlay). Their vertices are the geometry seed the server uses
        // to init the gaussian splat -- no COLMAP, works on blank walls.
        let meshVertices = Self.extractWorldVertices(
            from: ArkitSessionHost.shared.currentMeshAnchors()
        )

        let openingFaces = Self.extractOpeningFaces(from: ArkitSessionHost.shared.currentMeshAnchors())

        ArkitSessionHost.shared.onFrame = nil

        // Put the camera, LiDAR and mesh fusion down BEFORE the heaviest step
        // in the whole app. Export zips tens of megabytes across hundreds of
        // files, and leaving a full-rate ARWorldTrackingConfiguration running
        // underneath it competes for memory and heat on a phone that is
        // already warm from the scan -- a 2.6-minute scan then died here with
        // no error the user could see, which is exactly what an iOS
        // termination looks like from the JS side.
        //
        // `pause()`, not `stop()`: stop() is reference-counted against live
        // preview views and decrementing it here would corrupt that count.
        // Pausing directly is idempotent, and the view's own teardown still
        // balances its start() later.
        ArkitSessionHost.shared.pause()

        let start = recordingStart ?? Date()
        let duration = Date().timeIntervalSince(start)

        let exportURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("scan_\(UUID().uuidString.prefix(8)).zip")

        print("[capture] exporting \(savedFrames.count) frames "
              + "(\(bytesUsed / 1_048_576) MB; skipped \(skippedBlurred) blurred, "
              + "\(skippedRedundant) redundant, \(skippedBusy) busy, "
              + "\(skippedExposure) exposure settling; "
              + "\(replaced) replaced by sharper; "
              + "max thermal state \(maxThermalState))")

        var stats: [String: Any] = [
            "skipped_blurred": skippedBlurred,
            "skipped_redundant": skippedRedundant,
            "skipped_busy": skippedBusy,
            "skipped_exposure_settling": skippedExposure,
            "exposure_control": exposureControlUsed,
            "tone_mapping": toneMappingUsed,
            "replaced_sharper": replaced,
            "thermal_state_max": maxThermalState,
            "guided": true,
            "height_band_m": Double(GuidanceEngine.bandMeters),
            "frames_in_height_band": inBandCount,
        ]
        if let h = lockedHeight { stats["locked_height_m"] = Double(h) }
        stats["object_finder"] = finderFacts

        // objects.json (worker/object_lock.py): the boxes scanned in object
        // mode and the frames of their walk-arounds. Only boxes that got frames.
        var objectsDoc: [String: Any]? = nil
        let objectFrames = savedFrames.filter { $0.objectId != nil }
        let scannedIds = Set(objectFrames.compactMap { $0.objectId })
        let keptBoxes = boxes.filter { scannedIds.contains(($0["id"] as? String) ?? "") }
        if !keptBoxes.isEmpty {
            let keptIds = Set(keptBoxes.compactMap { $0["id"] as? String })
            objectsDoc = [
                "objects": keptBoxes,
                "object_frames": objectFrames.filter { keptIds.contains($0.objectId ?? "") }.map { $0.index },
                "eval_frames": [Int](),
            ]
        }

        // Written on the main thread by setHouseInfo; read there too.
        let house: [String: Any]? = Thread.isMainThread ? houseInfo : DispatchQueue.main.sync { self.houseInfo }
        let exporter = FrameExporter()
        try exporter.export(frames: savedFrames, meshVertices: meshVertices,
                            captureDir: tempDir, to: exportURL,
                            captureStats: stats,
                            segments: segments, vistas: vistas,
                            openingsHint: openingsHint,
                            objects: objectsDoc,
                            openingFaces: openingFaces,
                            faceClasses: [
                                String(ARMeshClassification.window.rawValue): "window",
                                String(ARMeshClassification.door.rawValue): "door",
                            ],
                            house: house,
                            roomPlanJSON: roomJSON)

        return ExportResult(
            archivePath: exportURL.path,
            frameCount: savedFrames.count,
            durationSeconds: duration
        )
    }

    func teardown() {
        if let f = finder {
            if Thread.isMainThread { f.stop() } else { DispatchQueue.main.sync { f.stop() } }
            finder = nil
        }
        ArkitSessionHost.shared.onFrame = nil
        FastExposure.shared.stop()
        guidance?.shutdown()
        guidance = nil
    }

    // MARK: - Exposure segments (spec §4)

    private func recordRoomSegmentIfNeeded() {
        guard segments.isEmpty else { return }
        segments = [Self.segmentEntry(id: 0, outdoor: false, ArkitSessionHost.shared.readCameraSettings())]
    }

    private static func segmentEntry(id: Int, outdoor: Bool,
                                     _ e: ArkitSessionHost.CameraSettings?) -> [String: Any] {
        var entry: [String: Any] = ["id": id, "kind": outdoor ? "outdoor" : "indoor", "exposure": "auto"]
        if let e = e { entry.merge(e.asJSON) { _, new in new } }
        return entry
    }

    /// Camera pose ~10 times a second for the whole recording: the screen
    /// draws the openings, notices walking through a door and steers the
    /// vista pass with it.
    private func emitPose(_ frame: ARFrame) {
        guard frame.timestamp - lastPoseEmit >= 0.1 else { return }
        lastPoseEmit = frame.timestamp
        let m = frame.camera.transform
        var normal = false
        if case .normal = frame.camera.trackingState { normal = true }
        onPose([
            "transform": (0..<4).flatMap { c in (0..<4).map { r in Double(m[c][r]) } },
            "focal": Double(frame.camera.intrinsics[0][0]),
            "imageWidth": Double(frame.camera.imageResolution.width),
            "imageHeight": Double(frame.camera.imageResolution.height),
            "trackingNormal": normal,
            "segment": currentSegment,
            "paused": framesPaused || captureMode == "paused",
            "mode": captureMode,
        ])
    }

    /// Starts a new segment: only a label (indoor / outdoor) and the settings
    /// at this moment. Auto exposure follows the light by itself, so frames
    /// keep flowing; nothing is paused or locked.
    func beginSegment(outdoor: Bool, completion: @escaping (Int) -> Void) {
        recordRoomSegmentIfNeeded()
        let id = segments.count
        segments.append(Self.segmentEntry(id: id, outdoor: outdoor, ArkitSessionHost.shared.readCameraSettings()))
        currentSegment = id
        completion(id)
    }

    /// The screen's live openings list, written as openings_hint.json.
    func setOpeningsHint(_ hint: [String: Any]) {
        openingsHint = hint
    }

    // MARK: - Vista pass (spec §4)

    func startVista(role: String) -> String {
        if vista != nil { _ = try? endVista(openingIds: []) }
        let id: String
        if role == "control" {
            controlCount += 1
            id = "c\(controlCount)"
        } else {
            vistaCount += 1
            id = "v\(vistaCount)"
        }
        // The vista brackets take the camera off our lock: stop tagging frames
        // as locked and cancel a pending lock (endVista re-arms it). The vista
        // pass meters on a tapped point and brackets with its own custom
        // exposure; the fast exposure must not fight it.
        // Sync Function on the JS thread: state that main-thread blocks and
        // frame handling read changes on main (the id and `vista` below stay
        // synchronous, JS needs the id now).
        DispatchQueue.main.async {
            self.framesPaused = true
            self.exposureEpoch += 1
            self.exposureLocked = false
            self.exposureLockTried = false
            FastExposure.shared.stop()
            ArkitSessionHost.shared.beginMetering()
        }
        let dir = tempDir.appendingPathComponent("vistas").appendingPathComponent(id)
        vista = WindowShotSession(into: dir, vistaId: id, role: role)
        vistaInfo = ["id": id, "role": role, "path": "vistas/\(id)/shots.json", "segment": currentSegment]
        return id
    }

    /// One target: three exposures. Resolves the group count and whether all
    /// three had normal tracking (if not, the screen asks for the target again).
    func captureVistaShot(completion: @escaping (Result<(Int, Bool), Error>) -> Void) {
        guard let v = vista else {
            completion(.failure(NSError(domain: "Vista", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Manzara modu açık değil"])))
            return
        }
        v.captureGroup { result in
            completion(result.map { ($0, v.lastGroupTrackingNormal) })
        }
    }

    /// Writes shots.json, returns to centre-metered auto exposure (the vista
    /// pass meters on a tapped outdoor point and brackets with a custom
    /// exposure), and resumes frames once auto has had a moment to settle.
    func endVista(openingIds: [String]) throws -> Int {
        guard let v = vista else { return 0 }
        vista = nil
        let groups = try v.finishInPlace(openingIds: openingIds)
        var info = vistaInfo
        info["groups"] = groups
        info["opening_ids"] = openingIds
        if groups > 0 { vistas.append(info) }
        ArkitSessionHost.shared.beginMetering()
        DispatchQueue.main.async {
            guard self.isRecording else { return }
            self.lastMeteringAt = CACurrentMediaTime()
            if self.captureMode == "object" {
                // Object mode keeps its fixed lock, not the fast exposure.
                // The lock block owns clearing the pause (and its delay covers settling).
                self.beginExposureLock()
                return
            }
            FastExposure.shared.start()
            self.exposureEpoch += 1
            let epoch = self.exposureEpoch
            DispatchQueue.main.asyncAfter(deadline: .now() + CaptureManager.autoSettleSeconds) {
                guard self.exposureEpoch == epoch, self.vista == nil else { return }
                self.framesPaused = false
            }
        }
        return groups
    }

    /// Time auto exposure and white balance get to settle after a custom
    /// exposure before frames count again.
    private static let autoSettleSeconds = 0.8

    private func handle(frame: ARFrame) {
        guard isRecording else { return }
        recordRoomSegmentIfNeeded()
        finder?.frameTick(hasDepth: (frame.smoothedSceneDepth ?? frame.sceneDepth) != nil, time: frame.timestamp)
        emitPose(frame)
        if framesPaused || captureMode == "paused" { return }

        // Require an active LiDAR depth frame: it is the cheapest available
        // proof that tracking is healthy this instant, and it is data we keep
        // (seed cloud and depth supervision on the server). Only the smoothed
        // map is requested from ARKit; it flickers far less between frames.
        guard let depthFrame = frame.smoothedSceneDepth ?? frame.sceneDepth else {
            return
        }

        let pose = frame.camera.transform

        // Angular speed from consecutive poses, for the blur test below. Always
        // update it, even on frames we go on to skip, or the rate would be
        // measured across a gap and read as fast motion.
        var angularSpeed: Float = 0
        var linearSpeed: Float = 0
        if let prev = previousTransform, frame.timestamp > previousTimestamp {
            let dt = Float(frame.timestamp - previousTimestamp)
            if dt > 0 {
                angularSpeed = Self.angleBetween(prev, pose) / dt
                linearSpeed = simd_distance(Self.translation(prev), Self.translation(pose)) / dt
            }
        }
        previousTransform = pose
        previousTimestamp = frame.timestamp

        let thermal = ProcessInfo.processInfo.thermalState.rawValue
        maxThermalState = max(maxThermalState, thermal)
        guidance?.update(pose: pose, time: frame.timestamp,
                         hot: thermal >= ProcessInfo.ThermalState.serious.rawValue,
                         focal: frame.camera.intrinsics[0][0],
                         imageResolution: frame.camera.imageResolution)
        let (savedCount, bytesUsed, budgetFull) = snapshot()

        if thermal >= ProcessInfo.ThermalState.critical.rawValue {
            registerAngleCoverage(transform: pose)
            onFrame(savedCount, angleCoveragePct, bytesUsed, budgetFull, false, thermal)
            return
        }
        let interval = thermal >= ProcessInfo.ThermalState.serious.rawValue
            ? Self.hotFrameInterval : Self.frameInterval

        let sinceKept = frame.timestamp - lastCaptureTime
        if sinceKept < interval {
            registerAngleCoverage(transform: pose)
            return
        }

        // Exposure gate: a frame taken while the exposure is still moving to
        // the new light is blown out or murky (34 of 93 blown room frames on
        // the 2026-10-07 window scan). The fast exposure settles in a few
        // camera frames, so the next keepable frame is a moment away.
        if FastExposure.shared.isSettling(at: frame.timestamp) {
            skippedExposure += 1
            registerAngleCoverage(transform: pose)
            return
        }

        // Butce dolduysa yeni kare biriktirme, ama aci takibi ve olaylar aksin
        // ki kullanici taramayi bitirmesi gerektigini ekranda gorsun.
        if budgetFull {
            registerAngleCoverage(transform: pose)
            onFrame(savedCount, angleCoveragePct, bytesUsed, true, false, thermal)
            return
        }

        // Blur gate: a smeared frame actively hurts -- the optimiser fits the
        // smear. Skipping costs nothing because the user is still moving and a
        // sharp frame of the same view arrives a moment later. The streak
        // drives the on-screen "slow down".
        let exposure = Float(frame.camera.exposureDuration)
        let focalPx = frame.camera.intrinsics[0][0]
        let smearPx = (angularSpeed + linearSpeed / Self.nominalDepthMeters) * exposure * focalPx
        let smearLimit = sinceKept > Self.starvedAfter
            ? Self.maxSmearPixels * Self.starvedSmearFactor : Self.maxSmearPixels
        if smearPx > smearLimit || angularSpeed > Self.maxAngularSpeed {
            skippedBlurred += 1
            blurStreak += 1
            registerAngleCoverage(transform: pose)
            if blurStreak >= Self.tooFastAfterSkips {
                onFrame(savedCount, angleCoveragePct, bytesUsed, false, true, thermal)
            }
            return
        }
        blurStreak = 0

        // Novelty gate: against EVERY kept frame (see `dedupMeters`). Holding
        // still consumes nothing; a clearly sharper copy replaces the old one.
        var replaceSlot: Int? = nil
        if let slot = duplicateSlot(of: pose) {
            if smearPx < keptPoses[slot].smear * Self.sharperFactor {
                replaceSlot = slot
            } else {
                skippedRedundant += 1
                registerAngleCoverage(transform: pose)
                // Holding still after a fast sweep must clear the warning.
                onFrame(savedCount, angleCoveragePct, bytesUsed, false, false, thermal)
                return
            }
        }

        // One frame on the work queue at a time; see `workQueue`.
        guard tryBeginWork() else {
            skippedBusy += 1
            registerAngleCoverage(transform: pose)
            return
        }

        let index: Int
        if let slot = replaceSlot {
            index = keptPoses[slot].index
            keptPoses[slot].transform = pose
            keptPoses[slot].smear = smearPx
            addToGrid(slot: slot, pose: pose)
        } else {
            index = nextIndex
            nextIndex += 1
            keptPoses.append(KeptPose(index: index, transform: pose, smear: smearPx))
            addToGrid(slot: keptPoses.count - 1, pose: pose)
        }
        let inBand = guidance?.isInBand(pose.columns.3.y) ?? true
        lastCaptureTime = frame.timestamp
        registerAngleCoverage(transform: pose)
        let coverageNow = angleCoveragePct

        // Only values and pixel buffers cross to the work queue, never the
        // ARFrame itself: ARKit recycles frames and starts dropping them when
        // the app holds on to them.
        let pixelBuffer = frame.capturedImage
        let depthMap = depthFrame.depthMap
        let confidenceMap = depthFrame.confidenceMap
        let intrinsics = frame.camera.intrinsics
        let imageResolution = frame.camera.imageResolution
        let timestamp = frame.timestamp
        let exposureDuration = frame.camera.exposureDuration
        let exposureOffset = frame.camera.exposureOffset
        // Read now, while the frame is current: auto exposure keeps moving.
        let camera = ArkitSessionHost.shared.readCameraSettings()
        let fe = FastExposure.shared
        let exposureInfo = ExposureInfo(control: fe.lastControl, errorEV: fe.lastErrorEV,
                                        clip: fe.lastClip, toneMapping: fe.toneMapping)
        let light = frame.lightEstimate
        let lightIntensity = light.map { Double($0.ambientIntensity) }
        let lightTemperature = light.map { Double($0.ambientColorTemperature) }

        let segmentNow = currentSegment
        let objectNow = captureMode == "object" ? objectId : nil
        let lockedNow = exposureLocked && captureMode == "object"
        workQueue.async { [weak self] in
            guard let self = self else { return }
            defer { self.endWork() }
            self.writeFrame(index: index, pixelBuffer: pixelBuffer, depthMap: depthMap,
                            confidenceMap: confidenceMap, fullIntrinsics: intrinsics,
                            imageResolution: imageResolution, pose: pose,
                            timestamp: timestamp, exposureDuration: exposureDuration,
                            exposureOffset: exposureOffset, camera: camera,
                            exposureInfo: exposureInfo,
                            lightIntensity: lightIntensity, lightTemperature: lightTemperature,
                            thermalState: thermal,
                            coverage: coverageNow, inBand: inBand, segment: segmentNow,
                            objectId: objectNow, exposureLocked: lockedNow)
        }
    }

    /// Slot of a kept frame this pose would duplicate, if any.
    private func duplicateSlot(of pose: simd_float4x4) -> Int? {
        let p = Self.translation(pose)
        let (gx, gz) = Self.gridCell(p)
        for dx in -1...1 {
            for dz in -1...1 {
                for slot in keptGrid[Self.gridKey(gx + Int64(dx), gz + Int64(dz))] ?? [] {
                    let kept = keptPoses[slot]
                    let q = Self.translation(kept.transform)
                    let flat = simd_length(simd_float2(p.x - q.x, p.z - q.z))
                    if flat <= Self.dedupMeters, abs(p.y - q.y) <= Self.dedupHeightMeters,
                       Self.angleBetween(kept.transform, pose) <= Self.dedupRadians {
                        return slot
                    }
                }
            }
        }
        return nil
    }

    /// A replaced slot is added under its new cell too; the stale entry is
    /// harmless because the check reads the slot's current pose.
    private func addToGrid(slot: Int, pose: simd_float4x4) {
        let (gx, gz) = Self.gridCell(Self.translation(pose))
        keptGrid[Self.gridKey(gx, gz), default: []].append(slot)
    }

    private static func gridCell(_ p: simd_float3) -> (Int64, Int64) {
        (Int64((p.x / dedupMeters).rounded(.down)), Int64((p.z / dedupMeters).rounded(.down)))
    }

    private static func gridKey(_ x: Int64, _ z: Int64) -> Int64 {
        ((x & 0xFFFFFFFF) << 32) | (z & 0xFFFFFFFF)
    }

    /// Runs on `workQueue`. Encodes and writes one frame, then reports it.
    private func writeFrame(index: Int, pixelBuffer: CVPixelBuffer, depthMap: CVPixelBuffer,
                            confidenceMap: CVPixelBuffer?, fullIntrinsics: simd_float3x3,
                            imageResolution: CGSize, pose: simd_float4x4,
                            timestamp: TimeInterval, exposureDuration: Double,
                            exposureOffset: Float, camera: ArkitSessionHost.CameraSettings?,
                            exposureInfo: ExposureInfo,
                            lightIntensity: Double?, lightTemperature: Double?,
                            thermalState: Int, coverage: Double,
                            inBand: Bool, segment: Int, objectId: String?,
                            exposureLocked: Bool) {
        let started = CACurrentMediaTime()
        let rgbImage = CIImage(cvPixelBuffer: pixelBuffer)

        // Uzun kenari hedefe indir. targetLongEdge ARKit'in kendi cozunurlugu
        // (1920) oldugu icin bu pratikte kopya gecmiyor.
        let extent = rgbImage.extent
        let longEdge = max(extent.width, extent.height)
        let scale = longEdge > Self.targetLongEdge ? Self.targetLongEdge / longEdge : 1.0
        let outImage = scale < 1.0
            ? rgbImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            : rgbImage
        let outWidth = Int(outImage.extent.width.rounded())
        let outHeight = Int(outImage.extent.height.rounded())

        guard let jpeg = ciContext.jpegRepresentation(
            of: outImage,
            colorSpace: outImage.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): Self.jpegQuality]
        ) else {
            return
        }

        stateLock.lock()
        let overBudget = imageBytesUsed + jpeg.count > Self.imageByteBudget
        if overBudget { budgetReached = true }
        let countBefore = frameCount
        let bytesBefore = imageBytesUsed
        stateLock.unlock()
        if overBudget {
            onFrame(countBefore, coverage, bytesBefore, true, false, thermalState)
            return
        }

        let rgbName = "frame_\(String(format: "%06d", index)).jpg"
        let rgbPath = tempDir.appendingPathComponent(rgbName).path
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        do {
            try jpeg.write(to: URL(fileURLWithPath: rgbPath))
        } catch {
            return
        }
        var bytesWritten = jpeg.count

        // Goruntu kuculunce ic parametreler de ayni oranda kuculmeli, yoksa
        // poz ile goruntu birbirini tutmaz ve rekonstruksiyon bozulur.
        var intrinsics = fullIntrinsics
        if scale < 1.0 {
            let s = Float(scale)
            intrinsics[0, 0] *= s
            intrinsics[1, 1] *= s
            intrinsics[2, 0] *= s
            intrinsics[2, 1] *= s
        }

        // Depth and confidence, written next to the JPEG under the same index
        // so the export step can pair them up by name. A file is only claimed
        // in the metadata if it landed at its expected size: a half-written
        // buffer must not be advertised, or the worker reshapes garbage.
        var depthPath = ""
        var confidencePath = ""
        let depthWidth = CVPixelBufferGetWidth(depthMap)
        let depthHeight = CVPixelBufferGetHeight(depthMap)
        let dPath = tempDir.appendingPathComponent(
            "depth_\(String(format: "%06d", index)).bin").path
        saveDepth16(depthMap, to: dPath)
        if let size = try? FileManager.default.attributesOfItem(atPath: dPath)[.size] as? Int,
           size == depthWidth * depthHeight * 2 {
            depthPath = dPath
            bytesWritten += size
        }
        if let conf = confidenceMap {
            let cPath = tempDir.appendingPathComponent(
                "conf_\(String(format: "%06d", index)).bin").path
            saveConfidence(conf, to: cPath)
            if let size = try? FileManager.default.attributesOfItem(atPath: cPath)[.size] as? Int,
               size == CVPixelBufferGetWidth(conf) * CVPixelBufferGetHeight(conf) {
                confidencePath = cPath
                bytesWritten += size
            }
        }

        // Only KEPT frames count: coverage means "the server will have this".
        ArkitSessionHost.shared.coverage.integrate(
            depthMap: depthMap,
            confidenceMap: confidenceMap,
            intrinsics: fullIntrinsics,
            imageResolution: imageResolution,
            cameraTransform: pose,
            countsAngles: inBand
        )

        let processMs = (CACurrentMediaTime() - started) * 1000
        stateLock.lock()
        imageBytesUsed += bytesWritten
        // A sharper replacement overwrote the old frame's files (same index):
        // give back its bytes and take its place in the list.
        if let old = frames.firstIndex(where: { $0.index == index }) {
            imageBytesUsed -= frames[old].bytes
            frames.remove(at: old)
            replacedSharper += 1
        } else {
            frameCount += 1
            if inBand { framesInBand += 1 }
        }
        frames.append(FrameData(
            index: index,
            timestamp: timestamp,
            rgbPath: rgbPath,
            depthPath: depthPath,
            confidencePath: confidencePath,
            intrinsics: intrinsics,
            transform: pose,
            imageWidth: outWidth,
            imageHeight: outHeight,
            depthWidth: depthWidth,
            depthHeight: depthHeight,
            exposureDuration: exposureDuration,
            exposureOffset: exposureOffset,
            camera: camera,
            exposureInfo: exposureInfo,
            lightIntensity: lightIntensity,
            lightTemperature: lightTemperature,
            thermalState: thermalState,
            processMs: processMs,
            bytes: bytesWritten,
            segment: segment,
            objectId: objectId,
            exposureLocked: exposureLocked
        ))
        let countNow = frameCount
        let bytesNow = imageBytesUsed
        stateLock.unlock()

        onFrame(countNow, coverage, bytesNow, false, false, thermalState)
    }

    private func tryBeginWork() -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        if workInFlight { return false }
        workInFlight = true
        return true
    }

    private func endWork() {
        stateLock.lock()
        workInFlight = false
        stateLock.unlock()
    }

    /// (saved frames, bytes used, budget full), read consistently.
    private func snapshot() -> (Int, Int, Bool) {
        stateLock.lock(); defer { stateLock.unlock() }
        return (frameCount, imageBytesUsed, budgetReached)
    }

    private var angleCoveragePct: Double {
        Double(visitedSectors.count) / Double(Self.angleSectorCount)
    }

    /// Bucket the camera's world-space heading into a sector of a full circle.
    /// World-space position from a camera-to-world matrix (column 3).
    private static func translation(_ m: simd_float4x4) -> simd_float3 {
        simd_float3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
    }

    /// Absolute rotation angle between two poses, in radians (0...pi).
    ///
    /// From the trace of the relative rotation rather than via quaternions:
    /// for R = Ra^T * Rb, trace(R) = 1 + 2*cos(angle). Both poses are rigid
    /// ARKit transforms, so Ra^T is its inverse and no normalisation is
    /// needed; clamping only guards float drift pushing acos out of domain.
    private static func angleBetween(_ a: simd_float4x4, _ b: simd_float4x4) -> Float {
        let r = rotationPart(a).transpose * rotationPart(b)
        let trace = r[0].x + r[1].y + r[2].z
        return acos(max(-1.0, min(1.0, (trace - 1.0) / 2.0)))
    }

    private static func rotationPart(_ m: simd_float4x4) -> simd_float3x3 {
        simd_float3x3(
            simd_float3(m.columns.0.x, m.columns.0.y, m.columns.0.z),
            simd_float3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
            simd_float3(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        )
    }

    private func registerAngleCoverage(transform: simd_float4x4) {
        // Camera looks down its own local -Z axis; column 2 is the camera's
        // Z axis in world space, so -column2 is forward.
        let forward = -simd_float3(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
        let yaw = atan2(Double(forward.x), Double(forward.z))
        let normalized = (yaw + .pi) / (2 * .pi)  // 0..1
        let sector = min(Self.angleSectorCount - 1, max(0, Int(normalized * Double(Self.angleSectorCount))))
        visitedSectors.insert(sector)
    }

    private var tempDir: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("arkit_scan")
    }

    // MARK: - Mesh extraction

    /// Window and door faces of the classified mesh, world space:
    /// [cx, cy, cz, nx, ny, nz, area_m2, class], class = ARMeshClassification
    /// raw value (the export writes the window/door numbers next to the data).
    /// For measuring how well ARKit finds glass (spec §8).
    static func extractOpeningFaces(from anchors: [ARMeshAnchor]) -> [[Float]] {
        var out: [[Float]] = []
        let window = UInt8(ARMeshClassification.window.rawValue)
        let door = UInt8(ARMeshClassification.door.rawValue)
        for anchor in anchors {
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
                let w = anchor.transform * simd_float4(p.0, p.1, p.2, 1)
                return simd_float3(w.x, w.y, w.z)
            }
            for f in 0..<faces.count {
                let c = cbase.advanced(by: cls.offset + f * cls.stride)
                    .assumingMemoryBound(to: UInt8.self).pointee
                guard c == window || c == door else { continue }
                let ip = fbase.advanced(by: f * faces.indexCountPerPrimitive * faces.bytesPerIndex)
                    .assumingMemoryBound(to: UInt32.self)
                let a = vertex(Int(ip[0])), b = vertex(Int(ip[1])), d = vertex(Int(ip[2]))
                let n = simd_cross(b - a, d - a)
                let area = simd_length(n) / 2
                guard area > 0 else { continue }
                let nn = simd_normalize(n)
                let cen = (a + b + d) / 3
                out.append([cen.x, cen.y, cen.z, nn.x, nn.y, nn.z, area, Float(c)])
            }
        }
        return out
    }

    /// Flatten every ARMeshAnchor's vertices into a single world-space point
    /// list. Each anchor stores vertices in its own local frame; multiply by
    /// `anchor.transform` to lift them into the shared ARKit world frame (the
    /// same frame the camera poses live in), so points and cameras stay
    /// consistent for the splat trainer.
    static func extractWorldVertices(from anchors: [ARMeshAnchor]) -> [simd_float3] {
        var out: [simd_float3] = []
        for anchor in anchors {
            let geometry = anchor.geometry
            let vertices = geometry.vertices
            let count = vertices.count
            guard count > 0 else { continue }
            let base = vertices.buffer.contents()
            let stride = vertices.stride
            let offset = vertices.offset
            out.reserveCapacity(out.count + count)
            for i in 0..<count {
                let ptr = base.advanced(by: offset + i * stride)
                    .assumingMemoryBound(to: (Float, Float, Float).self)
                let v = ptr.pointee
                let world = anchor.transform * simd_float4(v.0, v.1, v.2, 1)
                out.append(simd_float3(world.x, world.y, world.z))
            }
        }
        return out
    }

    // MARK: - Depth / Confidence saving (DepthFiles.swift)

    private func saveDepth16(_ pixelBuffer: CVPixelBuffer, to path: String) {
        DepthFiles.saveDepth16(pixelBuffer, to: path)
    }

    private func saveConfidence(_ pixelBuffer: CVPixelBuffer, to path: String) {
        DepthFiles.saveConfidence(pixelBuffer, to: path)
    }
}
