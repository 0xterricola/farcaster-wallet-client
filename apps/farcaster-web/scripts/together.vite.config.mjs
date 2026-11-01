/**
 * The dev server `scripts/verify-together-surface.mjs` measures.
 *
 * It is the app's own `vite.config.js` plus three things a probe needs and a
 * normal dev server must not have:
 *
 *   1. `cacheDir` OF ITS OWN. Several vite dev servers share
 *      `node_modules/.vite`, and when one re-optimizes deps the others answer
 *      `504 Outdated Optimize Dep` for the page's modules — which reads as a
 *      broken app rather than a cache collision.
 *
 *   2. a proxy for `/spaces`, pointed at the real collaboration service. The
 *      probe wants the page talking to the ACTUAL service over the app's own
 *      origin (which is also the production shape: fiddy.fun serves the client
 *      and the API from one origin), not to a stubbed fixture that can drift
 *      away from it.
 *
 *   3. `VITE_TOGETHER_API_URL=''` is set by the probe, which the client reads as
 *      "same origin" — so nothing in the page is cross-origin and no CORS or
 *      mixed-content rules are being worked around.
 *
 *   TOGETHER_SERVICE_URL  where the space service listens
 *                         (default http://127.0.0.1:8767)
 *
 * Not part of the build; nothing imports it.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'vite';

import base from '../vite.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const serviceUrl = process.env.TOGETHER_SERVICE_URL ?? 'http://127.0.0.1:8767';

export default defineConfig(async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base;
  return {
    ...resolved,
    cacheDir: path.join(appRoot, '.together-vite-cache'),
    server: {
      ...(resolved.server ?? {}),
      proxy: {
        ...((resolved.server ?? {}).proxy ?? {}),
        '/spaces': { target: serviceUrl, changeOrigin: false },
      },
    },
  };
});