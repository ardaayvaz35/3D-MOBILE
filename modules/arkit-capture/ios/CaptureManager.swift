import ARKit
import AVFoundation
import CoreVideo
import simd

/// ARKit LiDAR capture. Attaches to the shared ArkitSessionHost (owned by
/// the live preview view) as a frame sink -- it no longer owns its own
/// ARSession. Captures per frame:
///   - RGB frame (JPEG)
///   - Scene depth (16-bit PNG, millimeters)
///   - Confidence map (8-bit PNG, 0-2)
///   - Camera pose (world-space 4x4)
///   - Camera intrinsics (fx, fy, cx, cy)
///
/// Also tracks a coarse "angle coverage" heuristic: buckets the camera's
/// heading (yaw) into 12 sectors around a full circle and reports what
/// fraction have been visited. This is NOT true surface-coverage detection
/// (that needs the ARKit mesh + occlusion analysis) -- it's a cheap proxy
/// that still catches the single most common bad-scan pattern: standing
/// still and only panning, or only covering one side of the object.
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
    // A short interval still guards CPU (JPEG encoding is not free at 60 fps).
    private static let minFrameInterval: TimeInterval = 0.1
    // Keep a frame only once the camera has actually moved somewhere new.
    // Sized against the byte budget, not just against what looks "new": a
    // thorough room walk is on the order of 15 m of path, so an 8 cm step
    // yields ~190 translation-triggered frames plus rotation-triggered ones
    // -- roughly 250 frames, ~18 MB, comfortably inside the 34 MB budget.
    // At 6 cm a continuous walk could still exhaust the budget mid-room,
    // which is the failure we are fixing. 8 cm is also a healthy stereo
    // baseline for 3DGS, so nothing is given up for the headroom.
    private static let minTranslationMeters: Float = 0.08
    private static let minRotationRadians: Float = 10.0 * .pi / 180.0
    // Reject frames taken mid-swing: above this the exposure smears. The
    // rate comes from consecutive ARKit poses, which costs nothing, rather
    // than a per-frame Laplacian on the pixels, which would cost plenty.
    private static let maxAngularSpeed: Float = 0.55  // rad/s
    private var lastCaptureTime: TimeInterval = 0
    private var lastKeptTransform: simd_float4x4?
    private var previousTransform: simd_float4x4?
    private var previousTimestamp: TimeInterval = 0
    private(set) var skippedBlurred = 0
    private(set) var skippedRedundant = 0

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
    private static let imageByteBudget = 300 * 1024 * 1024
    private static let jpegQuality: Double = 0.9
    private static let targetLongEdge: CGFloat = 1920
    private var imageBytesUsed = 0
    private var budgetReached = false

    // CIContext kurulumu pahali. Her karede yenisini yaratmak tarama sirasinda
    // gozle gorulur takilmaya yol aciyordu.
    private lazy var ciContext = CIContext()

    /// (frameCount, angleCoveragePct 0..1, kullanilanBayt, butceDoldu)
    private let onFrame: (Int, Double, Int, Bool) -> Void
    private(set) var isRecording = false
    private var frameCount = 0
    private var frames: [FrameData] = []
    private var recordingStart: Date?
    private var visitedSectors = Set<Int>()

    init(onFrame: @escaping (Int, Double, Int, Bool) -> Void) {
        self.onFrame = onFrame
    }

    /// Yukleme butcesinin ne kadari kullanildi (0..1).
    var byteBudgetFraction: Double {
        min(1.0, Double(imageBytesUsed) / Double(Self.imageByteBudget))
    }

    func startRecording() {
        frames.removeAll()
        frameCount = 0
        lastCaptureTime = 0
        imageBytesUsed = 0
        budgetReached = false
        visitedSectors.removeAll()
        lastKeptTransform = nil
        previousTransform = nil
        previousTimestamp = 0
        skippedBlurred = 0
        skippedRedundant = 0
        // The capture directory is reused across scans and the archive is now
        // zipped straight from it, so anything a previous scan left behind
        // would be shipped inside this one. Start from an empty directory.
        try? FileManager.default.removeItem(at: tempDir)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        isRecording = true
        recordingStart = Date()
        ArkitSessionHost.shared.onFrame = { [weak self] frame in
            self?.handle(frame: frame)
        }
    }

    func stopRecordingAndExport() throws -> ExportResult {
        isRecording = false

        // Grab the fused LiDAR mesh BEFORE clearing the frame sink / tearing
        // down: these ARMeshAnchors are ARKit's realtime reconstruction (the
        // blue overlay). Their vertices are the geometry seed the server uses
        // to init the gaussian splat -- no COLMAP, works on blank walls.
        let meshVertices = Self.extractWorldVertices(
            from: ArkitSessionHost.shared.currentMeshAnchors()
        )

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

        print("[capture] exporting \(frames.count) frames "
              + "(\(imageBytesUsed / 1_048_576) MB; skipped \(skippedBlurred) blurred, "
              + "\(skippedRedundant) redundant)")

        let exporter = FrameExporter()
        try exporter.export(frames: frames, meshVertices: meshVertices,
                            captureDir: tempDir, to: exportURL)

        return ExportResult(
            archivePath: exportURL.path,
            frameCount: frames.count,
            durationSeconds: duration
        )
    }

    func teardown() {
        ArkitSessionHost.shared.onFrame = nil
    }

    private func handle(frame: ARFrame) {
        guard isRecording else { return }

        // Require an active LiDAR depth frame: it is the cheapest available
        // proof that tracking is healthy this instant.
        //
        // The per-frame depth/confidence buffers are still not persisted. The
        // original reason given here -- "the server reconstructs via COLMAP
        // from the RGB frames only" -- is out of date: the server now uses the
        // fused LiDAR mesh (mesh.ply, written at export) to seed the splat and
        // never runs COLMAP for this client type. Per-frame depth would add
        // supervision on textureless walls on top of that seed; it is left off
        // for now because it roughly doubles the archive against a hard 50 MB
        // per-object upload cap, and the seed already carries most of the same
        // geometry.
        guard frame.sceneDepth != nil else {
            return
        }

        let pose = frame.camera.transform

        // Angular speed from consecutive poses, for the blur test below. Always
        // update it, even on frames we go on to skip, or the rate would be
        // measured across a gap and read as fast motion.
        var angularSpeed: Float = 0
        if let prev = previousTransform, frame.timestamp > previousTimestamp {
            let dt = Float(frame.timestamp - previousTimestamp)
            if dt > 0 { angularSpeed = Self.angleBetween(prev, pose) / dt }
        }
        previousTransform = pose
        previousTimestamp = frame.timestamp

        // Angle-coverage tracking updates on every skip path too, so the UI
        // progress stays responsive whatever we decide about this frame.
        if frame.timestamp - lastCaptureTime < Self.minFrameInterval {
            registerAngleCoverage(transform: pose)
            return
        }
        lastCaptureTime = frame.timestamp

        // Butce dolduysa yeni kare biriktirme, ama aci takibi ve olaylar aksin
        // ki kullanici taramayi bitirmesi gerektigini ekranda gorsun.
        if budgetReached {
            registerAngleCoverage(transform: pose)
            onFrame(frameCount, angleCoveragePct, imageBytesUsed, true)
            return
        }

        // Blur gate: a smeared frame actively hurts -- the optimiser fits the
        // smear. Skipping costs nothing because the user is still moving and a
        // sharp frame of the same view arrives a moment later.
        if angularSpeed > Self.maxAngularSpeed {
            skippedBlurred += 1
            registerAngleCoverage(transform: pose)
            return
        }

        // Novelty gate: measured against the last frame we KEPT, not the last
        // frame seen, so holding the phone still consumes no budget at all.
        // The first frame has no reference and is always kept.
        if let kept = lastKeptTransform {
            let moved = simd_distance(Self.translation(kept), Self.translation(pose))
            let turned = Self.angleBetween(kept, pose)
            if moved < Self.minTranslationMeters && turned < Self.minRotationRadians {
                skippedRedundant += 1
                registerAngleCoverage(transform: pose)
                return
            }
        }

        let timestamp = frame.timestamp
        let index = frameCount

        let rgbImage = CIImage(cvPixelBuffer: frame.capturedImage)

        // Uzun kenari hedefe indir. 1920x1440 q0.9 kare basina ~500 KB tutuyordu
        // ve bir dakikalik tarama 50 MB sinirini rahatlikla asiyordu.
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

        if imageBytesUsed + jpeg.count > Self.imageByteBudget {
            budgetReached = true
            registerAngleCoverage(transform: frame.camera.transform)
            onFrame(frameCount, angleCoveragePct, imageBytesUsed, true)
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
        imageBytesUsed += jpeg.count
        frameCount += 1
        // Only advance the novelty reference once the frame is actually on
        // disk; a failed write above must not make the next frame look
        // redundant against a view we never stored.
        lastKeptTransform = pose

        let transform = pose

        // Goruntu kuculunce ic parametreler de ayni oranda kuculmeli, yoksa
        // poz ile goruntu birbirini tutmaz ve rekonstruksiyon bozulur.
        var intrinsics = frame.camera.intrinsics
        if scale < 1.0 {
            let s = Float(scale)
            intrinsics[0, 0] *= s
            intrinsics[1, 1] *= s
            intrinsics[2, 0] *= s
            intrinsics[2, 1] *= s
        }

        frames.append(FrameData(
            index: index,
            timestamp: timestamp,
            rgbPath: rgbPath,
            depthPath: "",
            confidencePath: "",
            intrinsics: intrinsics,
            transform: transform,
            imageWidth: outWidth,
            imageHeight: outHeight
        ))

        registerAngleCoverage(transform: transform)
        onFrame(frameCount, angleCoveragePct, imageBytesUsed, false)
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

    // MARK: - Depth / Confidence saving

    private func saveDepth16(_ pixelBuffer: CVPixelBuffer, to path: String) {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)

        guard let baseAddr = CVPixelBufferGetBaseAddress(pixelBuffer)?
            .assumingMemoryBound(to: Float32.self) else { return }

        var pixels = [UInt16]()
        pixels.reserveCapacity(width * height)

        for y in 0..<height {
            let row = baseAddr.advanced(by: y * bytesPerRow / MemoryLayout<Float32>.stride)
            for x in 0..<width {
                let depthMeters = row[x]
                let depthMM = UInt16(min(depthMeters * 1000, Float(UInt16.max)))
                pixels.append(depthMM)
            }
        }

        let data = pixels.withUnsafeBytes { Data($0) }
        try? data.write(to: URL(fileURLWithPath: path))
    }

    private func saveConfidence(_ pixelBuffer: CVPixelBuffer, to path: String) {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)

        guard let baseAddr = CVPixelBufferGetBaseAddress(pixelBuffer)?
            .assumingMemoryBound(to: UInt8.self) else { return }

        var pixels = [UInt8]()
        pixels.reserveCapacity(width * height)

        for y in 0..<height {
            let row = baseAddr.advanced(by: y * bytesPerRow)
            for x in 0..<width {
                pixels.append(row[x])  // ARKit confidence: 0=low, 1=med, 2=high
            }
        }

        let data = Data(pixels)
        try? data.write(to: URL(fileURLWithPath: path))
    }
}
