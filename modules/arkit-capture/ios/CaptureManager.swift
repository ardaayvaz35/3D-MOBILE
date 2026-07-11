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
    }

    struct ExportResult {
        let archivePath: String
        let frameCount: Int
        let durationSeconds: Double
    }

    private static let angleSectorCount = 12
    // Cap the capture rate: ARKit delivers ~60 fps, but photogrammetry only
    // needs a few well-spaced frames per second. Saving every frame produced
    // ~360 MB scans. ~3 fps keeps a 30 s room scan around 20-30 MB.
    private static let minFrameInterval: TimeInterval = 0.33
    private var lastCaptureTime: TimeInterval = 0

    private let onFrame: (Int, Double) -> Void  // (frameCount, angleCoveragePct 0..1)
    private(set) var isRecording = false
    private var frameCount = 0
    private var frames: [FrameData] = []
    private var recordingStart: Date?
    private var visitedSectors = Set<Int>()

    init(onFrame: @escaping (Int, Double) -> Void) {
        self.onFrame = onFrame
    }

    func startRecording() {
        frames.removeAll()
        frameCount = 0
        lastCaptureTime = 0
        visitedSectors.removeAll()
        isRecording = true
        recordingStart = Date()
        ArkitSessionHost.shared.onFrame = { [weak self] frame in
            self?.handle(frame: frame)
        }
    }

    func stopRecordingAndExport() throws -> ExportResult {
        isRecording = false
        ArkitSessionHost.shared.onFrame = nil
        let start = recordingStart ?? Date()
        let duration = Date().timeIntervalSince(start)

        let exportURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("scan_\(UUID().uuidString.prefix(8)).zip")

        let exporter = FrameExporter()
        try exporter.export(frames: frames, to: exportURL)

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

        // Require an active LiDAR depth frame (ensures good tracking), but we no
        // longer persist the depth/confidence buffers: the server reconstructs
        // via COLMAP from the RGB frames only, and the raw depth maps roughly
        // doubled the archive size (pushing scans over the upload limit).
        guard frame.sceneDepth != nil else {
            return
        }

        // Throttle to ~3 fps. Angle-coverage tracking still updates below so the
        // UI progress stays responsive even for skipped frames.
        if frame.timestamp - lastCaptureTime < Self.minFrameInterval {
            registerAngleCoverage(transform: frame.camera.transform)
            return
        }
        lastCaptureTime = frame.timestamp

        let timestamp = frame.timestamp
        let index = frameCount
        frameCount += 1

        let rgbImage = CIImage(cvPixelBuffer: frame.capturedImage)
        let rgbName = "frame_\(String(format: "%06d", index)).jpg"
        let rgbPath = tempDir.appendingPathComponent(rgbName).path

        if let jpeg = CIContext().jpegRepresentation(
            of: rgbImage, colorSpace: rgbImage.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.6]
        ) {
            try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
            try? jpeg.write(to: URL(fileURLWithPath: rgbPath))
        }

        let transform = frame.camera.transform
        let intrinsics = frame.camera.intrinsics

        frames.append(FrameData(
            index: index,
            timestamp: timestamp,
            rgbPath: rgbPath,
            depthPath: "",
            confidencePath: "",
            intrinsics: intrinsics,
            transform: transform
        ))

        registerAngleCoverage(transform: transform)
        onFrame(frameCount, angleCoveragePct)
    }

    private var angleCoveragePct: Double {
        Double(visitedSectors.count) / Double(Self.angleSectorCount)
    }

    /// Bucket the camera's world-space heading into a sector of a full circle.
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
