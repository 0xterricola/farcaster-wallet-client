import { defineConfig } from 'vitest/config';

// The tests exercise the node HTTP API seam: every network call in this suite
// goes to a real HTTP server (test/fakeSnapchainNode.ts) over a real socket.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
  },
});
