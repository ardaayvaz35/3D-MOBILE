import type React from 'react';
import type { CaptureResult, FrameCapturedPayload } from '../../modules/arkit-capture/src/ArkitCapture.types';

type NativeModuleShape = {
  isLidarSupported(): boolean;
  startRecording(): void;
  stopRecording(): Promise<CaptureResult>;
  addListener(
    eventName: 'onFrameCaptured',
    listener: (payload: FrameCapturedPayload) => void
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

export const ArkitPreviewView = PreviewViewComponent;
