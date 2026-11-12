// The speech pod is a static library, so the Swift packages it uses (Kokoro, MLX) must also be linked and embedded by the app target.
const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SNIPPET = `
    # Kokoro and MLX: linked and embedded by the app itself (plugins/withAppPackages.js)
    app_project = installer.aggregate_targets.first.user_project
    app_target = app_project.targets.find { |t| t.name == 'Commonplace' }
    [
      ['https://github.com/mlalma/kokoro-ios', { kind: 'upToNextMajorVersion', minimumVersion: '1.0.10' }, ['KokoroSwift']],
      ['https://github.com/mlalma/MLXUtilsLibrary.git', { kind: 'exactVersion', version: '0.0.6' }, ['MLXUtilsLibrary']],
      ['https://github.com/ml-explore/mlx-swift', { kind: 'upToNextMajorVersion', minimumVersion: '0.29.1' }, ['MLX']],
    ].each { |url, req, products| SPM.send(:add_spm_to_target, app_project, app_target, url, req, products) }
    app_project.save
`;

module.exports = (config) => withDangerousMod(config, ['ios', (cfg) => {
  const file = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('withAppPackages')) fs.writeFileSync(file, text.replace('post_install do |installer|\n', `post_install do |installer|\n${SNIPPET}`));
  return cfg;
}]);
