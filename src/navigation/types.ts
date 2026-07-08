export type AuthStackParamList = {
  SignIn: undefined;
  SignUp: undefined;
};

export type RootStackParamList = {
  Home: undefined;
  Settings: undefined;
  MyScans: undefined;
  PhotoScan: undefined;
  VideoScan: undefined;
  LidarScan: undefined;
  Status: { captureId: string };
  Viewer: { captureId: string };
  CaptureDetail: { captureId: string };
};
