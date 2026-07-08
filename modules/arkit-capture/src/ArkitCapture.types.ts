export type ArkitCaptureModuleEvents = {
  onFrameCaptured: (payload: FrameCapturedPayload) => void;
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
};

export type CaptureResult = {
  archivePath: string;
  frameCount: number;
  durationSeconds: number;
};
