Pod::Spec.new do |s|
  s.name           = 'CommonplaceSpeech'
  s.version        = '1.0.0'
  s.summary        = 'On-device speech for Commonplace (Kokoro-82M on MLX)'
  s.description    = 'Reads passages aloud with Kokoro-82M, on the device.'
  s.author         = ''
  s.homepage       = 'https://github.com/user863/curi'
  s.platforms      = { :ios => '18.0' }
  s.source         = { :git => '' }
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.{h,m,mm,swift}'
  # Packages build as frameworks in PackageFrameworks/; the module search needs that folder.
  frameworks = '${SYMROOT}/${CONFIGURATION}${EFFECTIVE_PLATFORM_NAME}/PackageFrameworks'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'FRAMEWORK_SEARCH_PATHS' => "$(inherited) \"#{frameworks}\"",
    'SWIFT_INCLUDE_PATHS' => "$(inherited) \"#{frameworks}\"",
  }

  spm_dependency(s, url: 'https://github.com/mlalma/kokoro-ios', requirement: { kind: 'upToNextMajorVersion', minimumVersion: '1.0.10' }, products: ['KokoroSwift'])
  spm_dependency(s, url: 'https://github.com/mlalma/MLXUtilsLibrary.git', requirement: { kind: 'exactVersion', version: '0.0.6' }, products: ['MLXUtilsLibrary'])
  spm_dependency(s, url: 'https://github.com/ml-explore/mlx-swift', requirement: { kind: 'upToNextMajorVersion', minimumVersion: '0.29.1' }, products: ['MLX'])
end
