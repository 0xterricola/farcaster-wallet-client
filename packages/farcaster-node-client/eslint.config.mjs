import customConfig from 'eslint-config-custom';

export default [
  ...customConfig,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  },
  {
    // The live suites talk to a real node and the fake one is a deliberately
    // verbose test double; both are allowed a looser style than the source.
    files: ['**/__tests__/**/*.ts', 'test/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Vitest config files are default-exported by convention.
    files: ['vitest.config.ts'],
    rules: {
      'import/no-default-export': 'off',
    },
  },
];
