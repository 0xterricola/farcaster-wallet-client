/* eslint-disable no-undef */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          unstable_transformImportMeta: true,
          disableImportExportTransform: false,
        },
      ],
    ],
    plugins: [
      // @noble/curves ships a BLS12-381 build that is ~1 MB of dead weight for
      // our read path (V16 off-chain messages are Ed25519). Alias it away, the
      // same way apps/farcaster-mobile does.
      [
        'module-resolver',
        {
          alias: {
            '@noble/curves/bls12-381': './src/shims/empty.js',
            '@adraffy/ens-normalize': './src/shims/empty.js',
          },
        },
      ],
    ],
  };
};