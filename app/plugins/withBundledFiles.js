// Copies the pack's manifest and centroids (the offline start; shards come from GitHub Pages) and the Kokoro model into the app bundle at build time (too large for the JS bundle).
const { withXcodeProject } = require('expo/config-plugins');

const SCRIPT = [
  'set -e',
  'DEST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"',
  'rm -rf "$DEST/pack"',
  'mkdir -p "$DEST/pack"',
  'cp "$SRCROOT/../../data/pack/manifest.json" "$DEST/pack/"',
  'cp "$SRCROOT/../../data/pack/"centroids.*.i8 "$DEST/pack/"',
  'mkdir -p "$DEST/Kokoro"',
  'rsync -a "$SRCROOT/../../ios/Kokoro/kokoro-v1_0.safetensors" "$SRCROOT/../../ios/Kokoro/voices.npz" "$DEST/Kokoro/"',
].join('\n');

// Xcode embeds most package frameworks but not all of them (KokoroSwift is missed): copy the rest and sign them.
const EMBED = [
  'set -e',
  'FW="$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH"',
  'mkdir -p "$FW"',
  'for f in "$BUILT_PRODUCTS_DIR"/PackageFrameworks/*.framework; do',
  '  name=$(basename "$f")',
  '  if [ ! -d "$FW/$name" ]; then',
  '    cp -R "$f" "$FW/$name"',
  '    codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY:--}" --preserve-metadata=identifier,entitlements "$FW/$name"',
  '  fi',
  'done',
].join('\n');

module.exports = (config) => withXcodeProject(config, (cfg) => {
  const project = cfg.modResults;
  const target = project.getFirstTarget().uuid;
  const name = '"Copy pack and model"';
  const exists = Object.values(project.hash.project.objects.PBXShellScriptBuildPhase ?? {}).some((p) => p.name === name);
  if (!exists) project.addBuildPhase([], 'PBXShellScriptBuildPhase', 'Copy pack and model', target, { shellPath: '/bin/sh', shellScript: SCRIPT });
  const embedName = '"Embed package frameworks"';
  const embedded = Object.values(project.hash.project.objects.PBXShellScriptBuildPhase ?? {}).some((p) => p.name === embedName);
  if (!embedded) project.addBuildPhase([], 'PBXShellScriptBuildPhase', 'Embed package frameworks', target, { shellPath: '/bin/sh', shellScript: EMBED });
  Object.values(project.pbxXCBuildConfigurationSection()).forEach((c) => {
    if (c.buildSettings) c.buildSettings.ENABLE_USER_SCRIPT_SANDBOXING = 'NO';
  });
  return cfg;
});
