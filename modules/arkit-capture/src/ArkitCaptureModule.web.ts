import { registerWebModule, NativeModule } from 'expo';

import { ArkitCaptureModuleEvents } from './ArkitCapture.types';

// ArkitCaptureModule is not available on the web platform.
class ArkitCaptureModule extends NativeModule<ArkitCaptureModuleEvents> {}

export default registerWebModule(ArkitCaptureModule, 'ArkitCaptureModule');
