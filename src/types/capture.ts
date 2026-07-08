export type ClientType = 'ios_lidar' | 'android_arcore' | 'web_photo' | 'web_video';

export type CaptureStatusValue =
  | 'uploaded'
  | 'queued'
  | 'sfm_running'
  | 'training'
  | 'exporting'
  | 'done'
  | 'failed'
  | 'unknown';

export type UploadResponse = {
  capture_id: string;
  status: string;
  message: string;
};

export type CaptureDetail = {
  capture_id: string;
  status: CaptureStatusValue;
  progress: number;
  stage_detail: string;
  output_splat_url: string | null;
  output_ply_url: string | null;
  created_at: string;
  updated_at: string;
};

export type FrameMeta = {
  frame_id: number;
  timestamp_ns: number;
  image_path: string;
  depth_path?: string;
  confidence_path?: string;
  camera_intrinsics?: number[];
  camera_transform?: number[][];
  image_width: number;
  image_height: number;
};
