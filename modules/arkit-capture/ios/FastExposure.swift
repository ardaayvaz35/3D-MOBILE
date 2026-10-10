import ARKit
import AVFoundation
import QuartzCore

/// Exposure that follows the scene within a few camera frames.
///
/// iOS's continuous auto exposure is deliberately smooth: turning from the
/// room to a window it takes ~0.3-1 s to settle, and at 4 frames a second
/// the frames taken meanwhile are blown out (2026-10-07, window scan: 34 of
/// the 93 blown room frames were taken before the exposure had settled).
/// Here every camera frame is metered on a coarse grid of the luma plane and
/// the next exposure is set directly (custom duration + ISO): one correction
/// in flight at a time, so a step lands 2-3 camera frames later (~30-50 ms at
/// 60 fps) and a large jump settles in two or three steps.
///
/// Metering ignores clipped pixels and aims the rest at mid-grey; when much
/// of the frame is clipped (a window filling the view) it steps down until
/// little is. Shutter is capped at `maxDuration` so motion blur does not grow;
/// past that, ISO. White balance stays on continuous auto.
///
/// Frames are "settling" while a correction is in flight or the metering
/// error is still large; CaptureManager does not keep those. Every frame
/// carries its exposure, so the server brings them all to one scale.
final class FastExposure {
    static let shared = FastExposure()

    /// Mid-grey in linear light: what the unclipped part of the frame is aimed at.
    static let targetLinear: Float = 0.18
    /// Below this the error is ignored (no hunting on noise).
    static let deadbandEV: Float = 0.12
    /// A frame whose metering error is larger than this is settling.
    static let settledEV: Float = 0.35
    /// Share of the error corrected per step (< 1: no overshoot).
    static let stepGain: Float = 0.85
    /// Over this share of clipped pixels the exposure is pulled down.
    static let clipHigh: Float = 0.12
    static let clipPullEV: Float = -0.8
    /// Shutter cap: the auto mode's usual 1/60 s; ISO takes over past it.
    static let maxDuration: Double = 1.0 / 60.0
    /// A correction that has not landed after this long is given up on.
    static let commandTimeout: TimeInterval = 0.25
    /// Settling longer than this lets frames through anyway (never starve a scan).
    static let maxSettle: TimeInterval = 1.0

    private(set) var active = false
    private(set) var toneMapping = "off"          // "on" / "unsupported" / "off"
    /// Last metered values, for the frame metadata.
    private(set) var lastClip: Float = 0
    private(set) var lastErrorEV: Float = 0
    private(set) var lastControl = "auto"         // "fast" while we drive it

    private var inFlight = false
    private var commandAt: TimeInterval = 0
    private var landsAt: Double = 0               // frame timestamp from which the last command applies
    private var settlingSince: TimeInterval = 0
    private var supported = false

    private init() {}

    private var device: AVCaptureDevice? {
        if #available(iOS 16.0, *) {
            return ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera
        }
        return nil
    }

    /// Recording starts (or a vista pass ends): take over the exposure.
    func start() {
        guard let d = device else { active = false; lastControl = "auto"; return }
        do { try d.lockForConfiguration() } catch { active = false; return }
        defer { d.unlockForConfiguration() }
        supported = d.isExposureModeSupported(.custom)
        // One fixed tone curve for every frame instead of the local, per-frame
        // one, where the format offers it: the server's brightness model
        // assumes one curve per scan.
        if d.activeFormat.isGlobalToneMappingSupported {
            d.isGlobalToneMappingEnabled = true
            toneMapping = d.isGlobalToneMappingEnabled ? "on" : "off"
        } else {
            toneMapping = "unsupported"
        }
        if d.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
            d.whiteBalanceMode = .continuousAutoWhiteBalance
        }
        inFlight = false
        landsAt = 0
        settlingSince = 0
        active = supported
        lastControl = supported ? "fast" : "auto"
        print("[exposure] fast=\(supported) toneMapping=\(toneMapping)")
    }

    /// Recording ends or a vista pass takes the exposure: back to iOS's own.
    func stop() {
        guard active || toneMapping == "on" else { return }
        active = false
        lastControl = "auto"
        guard let d = device else { return }
        do { try d.lockForConfiguration() } catch { return }
        defer { d.unlockForConfiguration() }
        if d.activeFormat.isGlobalToneMappingSupported { d.isGlobalToneMappingEnabled = false }
        toneMapping = "off"
        if d.isExposureModeSupported(.continuousAutoExposure) { d.exposureMode = .continuousAutoExposure }
    }

    /// Object mode: someone else freezes the exposure. Stop driving it and give
    /// the camera back to continuous auto (so the lock grabs a settled value),
    /// but keep the global tone curve on: one curve for the whole scan.
    func pauseControl() {
        guard active else { return }
        active = false
        lastControl = "auto"
        guard let d = device else { return }
        do { try d.lockForConfiguration() } catch { return }
        defer { d.unlockForConfiguration() }
        if d.isExposureModeSupported(.continuousAutoExposure) { d.exposureMode = .continuousAutoExposure }
    }

    /// Every camera frame (main thread, ARSession delegate).
    func process(_ frame: ARFrame) {
        guard active, let d = device else { return }
        let (clip, meanLin) = Self.meter(frame.capturedImage)
        lastClip = clip
        var err: Float = 0
        if meanLin > 1e-4 {
            err = log2(Self.targetLinear / meanLin)
        } else {
            err = 2                                  // all black or all clipped below
        }
        if clip > Self.clipHigh { err = min(err, Self.clipPullEV) }
        lastErrorEV = err
        let now = CACurrentMediaTime()
        if abs(err) > Self.settledEV {
            if settlingSince == 0 { settlingSince = now }
        } else {
            settlingSince = 0
        }
        if inFlight && now - commandAt > Self.commandTimeout { inFlight = false }
        guard !inFlight, frame.timestamp >= landsAt, abs(err) > Self.deadbandEV else { return }

        let format = d.activeFormat
        let current = frame.camera.exposureDuration * Double(d.iso)
        let wanted = current * pow(2.0, Double(Self.stepGain * err))
        let maxS = min(Self.maxDuration, format.maxExposureDuration.seconds)
        let minS = format.minExposureDuration.seconds
        let seconds = min(max(wanted / Double(format.minISO), minS), maxS)
        let iso = Float(min(max(wanted / seconds, Double(format.minISO)), Double(format.maxISO)))
        do { try d.lockForConfiguration() } catch { return }
        inFlight = true
        commandAt = now
        d.setExposureModeCustom(duration: CMTime(seconds: seconds, preferredTimescale: 1_000_000_000),
                                iso: iso) { [weak self] syncTime in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.inFlight = false
                self.landsAt = syncTime.seconds.isFinite ? syncTime.seconds : 0
            }
        }
        d.unlockForConfiguration()
    }

    /// True while this frame should not be kept: a correction is in flight or
    /// has not reached this frame, or the metering error is still large. Never
    /// for longer than `maxSettle` in a row.
    func isSettling(at timestamp: TimeInterval) -> Bool {
        guard active else { return false }
        if settlingSince > 0 && CACurrentMediaTime() - settlingSince > Self.maxSettle { return false }
        return inFlight || timestamp < landsAt || abs(lastErrorEV) > Self.settledEV
    }

    /// (share of clipped pixels, mean linear brightness of the unclipped ones)
    /// from a 48 x 36 grid of the luma plane.
    static func meter(_ buffer: CVPixelBuffer) -> (Float, Float) {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard CVPixelBufferGetPlaneCount(buffer) >= 1,
              let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)?.assumingMemoryBound(to: UInt8.self)
        else { return (0, targetLinear) }
        let w = CVPixelBufferGetWidthOfPlane(buffer, 0)
        let h = CVPixelBufferGetHeightOfPlane(buffer, 0)
        let row = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let nx = 48, ny = 36
        var clipped = 0, n = 0
        var sum: Float = 0
        for j in 0..<ny {
            let y = (j * 2 + 1) * h / (ny * 2)
            for i in 0..<nx {
                let x = (i * 2 + 1) * w / (nx * 2)
                let v = base[y * row + x]
                if v >= 250 {
                    clipped += 1
                } else {
                    let f = Float(v) / 255
                    sum += f * f * sqrtf(f)          // ~ v^2.5, close enough to the sRGB decode for metering
                    n += 1
                }
            }
        }
        let total = Float(nx * ny)
        return (Float(clipped) / total, n > 0 ? sum / Float(n) : 0)
    }
}
