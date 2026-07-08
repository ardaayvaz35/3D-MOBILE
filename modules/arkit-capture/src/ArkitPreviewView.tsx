import { requireNativeView } from 'expo';
import React from 'react';
import { View, ViewProps } from 'react-native';

// Native ARKit camera preview -- only exists in a custom Dev Client build.
// Loading it via try/catch (same pattern as arkitCapture.ts) means this
// module can still be imported on Expo Go / web without crashing the app;
// callers should additionally gate rendering on isArkitModuleAvailable().
let NativeArkitPreviewView: React.ComponentType<ViewProps> | null = null;
try {
  NativeArkitPreviewView = requireNativeView('ArkitCapture');
} catch {
  NativeArkitPreviewView = null;
}

export default function ArkitPreviewView(props: ViewProps) {
  if (!NativeArkitPreviewView) {
    return <View {...props} />;
  }
  return <NativeArkitPreviewView {...props} />;
}
