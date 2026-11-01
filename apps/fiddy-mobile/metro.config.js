/* eslint-disable no-undef */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so edits in packages/farcaster-node-client (a
// workspace package) re-bundle, and resolve modules from both node_modules.
config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// @farcaster/core's bundled ts-proto helpers statically `require("util")`
// inside a try/catch. Metro resolves requires eagerly, so the specifier must
// resolve to something — this shim is what it resolves to.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  util: path.resolve(projectRoot, 'src/shims/util.js'),
};

module.exports = config;