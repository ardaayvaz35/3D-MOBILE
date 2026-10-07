import CoreVideo
import Foundation

/// LiDAR depth (uint16 millimetres) and confidence (uint8 0/1/2), raw and
/// headerless, row by row: the format of the scan's depth_/conf_ files. Used
/// by the recording and by the vista pass.
enum DepthFiles {

    static func saveDepth16(_ pixelBuffer: CVPixelBuffer, to path: String) {
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
                // Round, not truncate (truncation biased every depth 0.5 mm short).
                // A non-finite or negative reading would trap UInt16(); 0 = no depth.
                let mm = depthMeters * 1000
                let depthMM: UInt16 = (mm.isFinite && mm > 0)
                    ? UInt16(min(mm.rounded(), Float(UInt16.max))) : 0
                pixels.append(depthMM)
            }
        }

        let data = pixels.withUnsafeBytes { Data($0) }
        try? data.write(to: URL(fileURLWithPath: path))
    }

    static func saveConfidence(_ pixelBuffer: CVPixelBuffer, to path: String) {
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

    /// Writes both next to `stem` (stem_depth.bin, stem_conf.bin). Returns the
    /// file names and the grid size, only for files that landed whole.
    static func save(depth: CVPixelBuffer, confidence: CVPixelBuffer?, dir: URL, stem: String)
        -> (depth: String, confidence: String, width: Int, height: Int) {
        let w = CVPixelBufferGetWidth(depth), h = CVPixelBufferGetHeight(depth)
        var dName = "", cName = ""
        let d = dir.appendingPathComponent(stem + "_depth.bin")
        saveDepth16(depth, to: d.path)
        if let size = try? FileManager.default.attributesOfItem(atPath: d.path)[.size] as? Int, size == w * h * 2 {
            dName = d.lastPathComponent
        }
        if let c = confidence {
            let cu = dir.appendingPathComponent(stem + "_conf.bin")
            saveConfidence(c, to: cu.path)
            if let size = try? FileManager.default.attributesOfItem(atPath: cu.path)[.size] as? Int,
               size == CVPixelBufferGetWidth(c) * CVPixelBufferGetHeight(c) {
                cName = cu.lastPathComponent
            }
        }
        return (dName, cName, w, h)
    }
}
