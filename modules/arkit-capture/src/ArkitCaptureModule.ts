import { NativeModule, requireNativeModule } from 'expo';

import { ArkitCaptureModuleEvents, CaptureResult } from './ArkitCapture.types';

declare class ArkitCaptureModule extends NativeModule<ArkitCaptureModuleEvents> {
  isLidarSupported(): boolean;
  startRecording(): void;
  stopRecording(): Promise<CaptureResult>;
}

export default requireNativeModule<ArkitCaptureModule>('ArkitCapture');
