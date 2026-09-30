import type React from 'react';
import type {
  CaptureResult,
  FrameCapturedPayload,
  GuidancePayload,
  PosePayload,
  VideoFormat,
  VistaShotResult,
  WindowScanResult,
  WindowShotResult,
} from '../../modules/arkit-capture/src/ArkitCapture.types';

type NativeModuleShape = {
  isLidarSupported(): boolean;
  getVideoFormats(): { formats: VideoFormat[] };
  startRecording(): void;
  stopRecording(): Promise<CaptureResult>;
  beginWindowScan(): void;
  setExposurePoint(x: number, y: number): void;
  captureWindowShot(): Promise<WindowShotResult>;
  finishWindowScan(): Promise<WindowScanResult>;
  cancelWindowScan(): void;
  beginSegment(outdoor: boolean): Promise<number>;
  classifiedPoints(): Promise<number[]>;
  sampleLuma(points: number[]): number[];
  raycast(x: number, y: number, viewW: number, viewH: number): number[] | null;
  setOpeningsHint(json: string): void;
  startVista(role: string): string;
  captureVistaShot(): Promise<VistaShotResult>;
  endVista(openingIds: string[]): Promise<number>;
  addListener(eventName: 'onPose', listener: (payload: PosePayload) => void): { remove: () => void };
  addListener(
    eventName: 'onFrameCaptured',
    listener: (payload: FrameCapturedPayload) => void
  ): { remove: () => void };
  addListener(
    eventName: 'onGuidance',
    listener: (payload: GuidancePayload) => void
  ): { remove: () => void };
};

/**
 * The ArkitCapture native module only exists in a custom Dev Client build
 * (EAS build), never in plain Expo Go. Loading it via `require` inside a
 * try/catch means the whole app still boots fine under Expo Go - the LiDAR
 * screen just reports the module as unavailable instead of crashing.
 */
let nativeModule: NativeModuleShape | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PreviewViewComponent: React.ComponentType<any> | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../modules/arkit-capture');
  nativeModule = mod.default;
  PreviewViewComponent = mod.ArkitPreviewView;
} catch {
  nativeModule = null;
  PreviewViewComponent = null;
}

export function isArkitModuleAvailable(): boolean {
  return nativeModule !== null;
}

export function isLidarSupported(): boolean {
  if (!nativeModule) return false;
  try {
    return nativeModule.isLidarSupported();
  } catch {
    return false;
  }
}

export function startLidarRecording(): void {
  if (!nativeModule) {
    throw new Error('ArkitCapture native modülü mevcut değil (Dev Client gerekli)');
  }
  nativeModule.startRecording();
}

export async function stopLidarRecording(): Promise<CaptureResult> {
  if (!nativeModule) {
    throw new Error('ArkitCapture native modülü mevcut değil (Dev Client gerekli)');
  }
  return nativeModule.stopRecording();
}

export function onFrameCaptured(listener: (payload: FrameCapturedPayload) => void): () => void {
  if (!nativeModule) return () => {};
  const subscription = nativeModule.addListener('onFrameCaptured', listener);
  return () => subscription.remove();
}

/** Live target arrow and height lock, ~10 times a second while recording. */
export function onGuidance(listener: (payload: GuidancePayload) => void): () => void {
  if (!nativeModule) return () => {};
  const subscription = nativeModule.addListener('onGuidance', listener);
  return () => subscription.remove();
}

/** Video formats ARKit world tracking offers, with the camera each uses (0.5x check). */
export function getVideoFormats(): VideoFormat[] {
  if (!nativeModule?.getVideoFormats) return [];
  try {
    return nativeModule.getVideoFormats().formats ?? [];
  } catch {
    return [];
  }
}

function requireModule(): NativeModuleShape {
  if (!nativeModule) {
    throw new Error('ArkitCapture native modülü mevcut değil (Dev Client gerekli)');
  }
  return nativeModule;
}

/** Window pass: switches the live session to photo mode (no mesh, high-res stills). */
export function beginWindowScan(): void {
  requireModule().beginWindowScan();
}

/** Meter exposure on a point of the preview; x, y are 0..1 of the view. */
export function setWindowExposurePoint(x: number, y: number): void {
  requireModule().setExposurePoint(x, y);
}

/** One press: three exposures (-1.5 / 0 / +1.5 EV) with their ARKit poses. */
export function captureWindowShot(): Promise<WindowShotResult> {
  return requireModule().captureWindowShot();
}

export function finishWindowScan(): Promise<WindowScanResult> {
  return requireModule().finishWindowScan();
}

export function cancelWindowScan(): void {
  nativeModule?.cancelWindowScan();
}

/** New exposure segment: outdoor meters and locks, indoor restores the room's. */
export function beginSegment(outdoor: boolean): Promise<number> {
  return requireModule().beginSegment(outdoor);
}

/** Window / door / floor points of the classified mesh, flat [x, y, z, cls, ...]. */
export function classifiedPoints(): Promise<number[]> {
  return requireModule().classifiedPoints();
}

/** Luma 0..255 of the current camera image at world points (flat x, y, z), -1 out of view. */
export function sampleLuma(points: number[]): number[] {
  return requireModule().sampleLuma(points);
}

/** World point under a tap on the preview (x, y in 0..1 of a viewW x viewH view). */
export function raycast(x: number, y: number, viewW: number, viewH: number): number[] | null {
  return requireModule().raycast(x, y, viewW, viewH);
}

/** Live openings list, written into the archive as openings_hint.json. */
export function setOpeningsHint(hint: object): void {
  requireModule().setOpeningsHint(JSON.stringify(hint));
}

/** Pauses frame recording and starts a vista (or control) photo set. */
export function startVista(role: 'vista' | 'control'): string {
  return requireModule().startVista(role);
}

export function captureVistaShot(): Promise<VistaShotResult> {
  return requireModule().captureVistaShot();
}

/** Closes the photo set, restores the segment exposure, resumes frames. */
export function endVista(openingIds: string[]): Promise<number> {
  return requireModule().endVista(openingIds);
}

export function onPose(listener: (payload: PosePayload) => void): () => void {
  if (!nativeModule) return () => {};
  const subscription = nativeModule.addListener('onPose', listener);
  return () => subscription.remove();
}

export const ArkitPreviewView = PreviewViewComponent;
