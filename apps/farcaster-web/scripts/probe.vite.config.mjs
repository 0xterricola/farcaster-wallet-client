/**
 * The dev server `scripts/verify-media-upload.mjs` asks for.
 *
 * It is the app's own `vite.config.js` plus two things a probe needs and a
 * normal dev server must not have:
 *
 *   1. `cacheDir` OF ITS OWN. Several vite dev servers share
 *      `node_modules/.vite`, and when one of them re-optimizes deps the others
 *      start answering `504 Outdated Optimize Dep` for the page's modules —
 *      which looks like a broken app rather than a cache collision.
 *
 *   2. a proxy for the media path. The probe's page is https and the media
 *      service runs plain http, and a browser refuses to POST from an https
 *      page to an http URL ("TypeError: Failed to fetch"; the composer then
 *      says "we couldn't reach the photo host"). Proxying `/api/fiddy/media`
 *      through the client's own origin is also the production shape: fiddy.fun
 *      serves the client and the bytes from one origin.
 *
 *   MEDIA_SERVICE_URL  where the media service actually listens
 *                      (default http://localhost:3217)
 *
 * Not part of the build; nothing imports it.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'vite';

import base from '../vite.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const mediaServiceUrl = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3217';

export default defineConfig(async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base;
  return {
    ...resolved,
    // Its own cache directory, and one more per server when several of these
    // are up at once (the sign-up probe runs three): two dev servers sharing a
    // dep cache make each other answer `504 Outdated Optimize Dep` whenever one
    // re-optimizes, which reads as a broken app rather than a cache collision.
    cacheDir:
      process.env.PROBE_VITE_CACHE_DIR ??
      path.join(appRoot, '.probe-vite-cache'),
    server: {
      ...resolved.server,
      proxy: {
        ...resolved.server?.proxy,
        '/api/fiddy/media': {
          target: mediaServiceUrl,
          changeOrigin: false,
        },
      },
    },
  };
});