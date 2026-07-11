const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Forces the local ARKit native module (modules/arkit-capture) to be linked.
 *
 * Expo's `use_expo_modules!` in the generated Podfile is invoked with no
 * search paths, and in this project it does not apply the default local
 * `modules/` scan -- so the standalone `expo-modules-autolinking resolve`
 * finds ArkitCapture but pod install / ExpoModulesProvider generation drop
 * it. Passing explicit searchPaths to `use_expo_modules!` feeds them into
 * BOTH the pod resolution and the generate-modules-provider step, which
 * registers the module with Expo's runtime registry.
 *
 * This runs during `expo prebuild`, so it re-applies on every clean prebuild.
 */
module.exports = function withArkitLocalModule(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfile, 'utf8');

      if (!contents.includes('searchPaths:')) {
        const patched = contents.replace(
          /^([ \t]*)use_expo_modules!\s*$/m,
          "$1use_expo_modules!(searchPaths: ['../node_modules', '../modules'])"
        );
        if (patched === contents) {
          throw new Error(
            '[withArkitLocalModule] Could not find `use_expo_modules!` in Podfile to patch.'
          );
        }
        fs.writeFileSync(podfile, patched);
        // eslint-disable-next-line no-console
        console.log('[withArkitLocalModule] Patched Podfile use_expo_modules! with searchPaths.');
      }

      return cfg;
    },
  ]);
};
