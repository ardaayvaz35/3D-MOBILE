Pod::Spec.new do |s|
  s.name           = 'ArkitCapture'
  s.version        = '1.0.0'
  s.summary        = 'ARKit LiDAR capture (RGB+Depth+Pose) for 3D scanning'
  s.description    = 'Captures ARKit scene depth, confidence and camera pose frames and exports them as a tar.gz archive for the 3D scanner backend.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ARKit', 'AVFoundation', 'CoreVideo', 'Metal'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
