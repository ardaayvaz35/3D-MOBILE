// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// This machine is memory-constrained (8 GB, shared with the Python backend,
// VS Code, Chrome, etc.). Metro spawns a worker pool for parallel transforms;
// on a tight RAM budget those workers get OOM-killed (SIGTERM) and the bundler
// dies. Cap the pool to 2 workers so Metro fits in the available memory.
config.maxWorkers = 2;

module.exports = config;
