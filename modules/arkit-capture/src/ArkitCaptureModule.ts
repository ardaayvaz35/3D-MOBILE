import { NativeModule, requireNativeModule } from 'expo';

import {
  ArkitCaptureModuleEvents,
  CaptureResult,
  WindowScanResult,
  WindowShotResult,
} from './ArkitCapture.types';

declare class ArkitCaptureModule extends NativeModule<ArkitCaptureModuleEvents> {
  isLidarSupported(): boolean;
  startRecording(): void;
  stopRecording(): Promise<CaptureResult>;
  beginWindowScan(): void;
  setExposurePoint(x: number, y: number): void;
  captureWindowShot(): Promise<WindowShotResult>;
  finishWindowScan(): Promise<WindowScanResult>;
  cancelWindowScan(): void;
}

export default requireNativeModule<ArkitCaptureModule>('ArkitCapture');
