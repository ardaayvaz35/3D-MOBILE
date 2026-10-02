export type ArkitCaptureModuleEvents = {
  onFrameCaptured: (payload: FrameCapturedPayload) => void;
  onGuidance: (payload: GuidancePayload) => void;
  onPose: (payload: PosePayload) => void;
  onObjects: (payload: ObjectsPayload) => void;
};

export type FrameCapturedPayload = {
  frameCount: number;
  /**
   * Coarse "have you scanned from enough angles" proxy (0..1): fraction of
   * 12 heading sectors the camera has visited while recording. Not true
   * surface coverage (that needs mesh + occlusion analysis) -- just cheap
   * feedback that catches the most common bad scan (standing still, or only
   * covering one side).
   */
  angleCoverage: number;
  /** Arsivde su ana kadar kullanilan JPEG baytlari. */
  bytesUsed: number;
  /**
   * Yukleme butcesi doldu. Supabase ucretsiz plani tek nesnede 50 MB'a izin
   * veriyor, o yuzden bu noktadan sonra yeni kare kaydedilmiyor; kullaniciyi
   * taramayi bitirmeye yonlendirmek gerekiyor.
   */
  storageLimitReached: boolean;
  /**
   * The last several frames were rejected as motion-blurred (speed x
   * exposure x focal length exceeded the smear limit). Nothing is being
   * recorded until the user slows down, so tell them now.
   */
  movingTooFast: boolean;
  /**
   * iOS thermal state when the event was sent: 0 nominal, 1 fair, 2 serious
   * (native side halves the frame rate and slows the heat map), 3 critical
   * (native side stops taking frames).
   */
  thermalState: number;
};

export type CaptureResult = {
  archivePath: string;
  frameCount: number;
  durationSeconds: number;
};

export type WindowShotResult = {
  /** Button presses so far; each press saves three exposures. */
  shotCount: number;
};

export type WindowScanResult = {
  archivePath: string;
  /** JPEG files in the archive (shotCount x 3 exposures). */
  photoCount: number;
  shotCount: number;
};

/** A direction in portrait screen terms (unit vector, camera frame). */
export type ScreenDirection = { right: number; up: number; forward: number };

export type GuidancePayload = {
  /** explore: look where nobody looked yet; improve: fill missing visitor
   *  angles; walk: nothing left from here, walk on; wait: not enough data. */
  mode: 'explore' | 'improve' | 'walk' | 'wait';
  target?: ScreenDirection;
  walk?: ScreenDirection;
  walkMeters?: number;
  /** Camera on target (within 10 deg) and height in band. */
  aligned: boolean;
  /** 0..1 of the 1 s hold that completes the target. */
  hold: number;
  /** Share of visitor angles already served, 0..1. */
  progress: number;
  /** "Every place is scanned" -- offer to finish. */
  done: boolean;
  /** Metres above (+) or below (-) the height locked at start. */
  heightDeviation: number;
  /** Object mode / transition screen: no height lock, no haptics. */
  heightFree?: boolean;
  inBand: boolean;
  buzzing: boolean;
  /** Full-image focal length (px) and sensor-landscape image size. */
  focal: number;
  imageWidth: number;
  imageHeight: number;
};

export type VideoFormat = {
  width: number;
  height: number;
  fps: number;
  device?: string;
  position?: number;
  highResRecommended?: boolean;
};

/** Camera pose ~10 times a second while recording. */
export type PosePayload = {
  /** ARKit camera-to-world, column-major, 16 numbers. */
  transform: number[];
  focal: number;
  imageWidth: number;
  imageHeight: number;
  trackingNormal: boolean;
  /** Exposure segment frames are being recorded in (0 = room). */
  segment: number;
  /** Frames are not being kept (vista pass or a black transition screen). */
  paused: boolean;
  /** Capture mode on the native side. */
  mode?: 'room' | 'object' | 'paused';
};

/** One piece of furniture RoomPlan found (ARKit world, metres, +Y up). */
export type RoomPlanObject = {
  id: string;
  category: string;
  center: [number, number, number];
  /** Width (box x), height (y), depth (z). */
  size: [number, number, number];
  /** Rotation about +Y; box x axis -> (cos, 0, -sin). */
  yaw_deg: number;
};

export type RoomPlanWall = {
  center: [number, number, number];
  width: number;
  yaw_deg: number;
};

export type ObjectsPayload = {
  /** running | failed | stopped | unavailable (...) | unsupported device */
  status: string;
  failure: string;
  objects: RoomPlanObject[];
  walls: RoomPlanWall[];
};

export type VistaShotResult = {
  shotCount: number;
  /** All three exposures had normal tracking; if not, ask for the target again. */
  trackingNormal: boolean;
};
