// Re-export the native module. On web, it will be resolved to ArkitCaptureModule.web.ts
// and on native platforms to ArkitCaptureModule.ts
export { default } from './src/ArkitCaptureModule';
export { default as ArkitPreviewView } from './src/ArkitPreviewView';
export * from './src/ArkitCapture.types';
