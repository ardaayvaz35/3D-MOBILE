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
};

export type CaptureResult = {
  archivePath: string;
  frameCount: number;
  durationSeconds: number;
};
