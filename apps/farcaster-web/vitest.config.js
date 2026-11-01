import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
  },
  /**
   * The app compiles JSX with the automatic runtime (@vitejs/plugin-react), so
   * components in this repo do not import React to use JSX. Without this the
   * test transform falls back to the classic runtime and any component that
   * (correctly) omits `import React` fails with "React is not defined" the
   * moment a test renders it — which is what stopped components that use the
   * page shell from being testable at all.
   */
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
});
