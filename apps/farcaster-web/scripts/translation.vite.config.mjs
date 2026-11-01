/**
 * The dev server `scripts/verify-cast-translations.mjs` asks for.
 *
 * It is the app's own config (through `probe.vite.config.mjs`, which gives it a
 * cache directory of its own) plus one thing: a proxy for the two translate
 * routes, pointed at the release's own service — the process
 * `fiddy-unfurl.service` runs (`server/unfurl/server.mjs`).
 *
 * Proxying them through the client's OWN origin is not a convenience here, it is
 * production's shape: nginx forwards `/api/translate` and `/api/translations` to
 * 127.0.0.1:3220, and `verify-no-off-site-reads.mjs` exists to keep a browser
 * from talking to anybody else. A probe that pointed the page straight at the
 * service's port would measure a shape that never ships.
 *
 *   TRANSLATE_SERVICE_URL   where the service listens (default 127.0.0.1:5221)
 *
 * Not part of the build; nothing imports it.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'vite';

import probe from './probe.vite.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const service = process.env.TRANSLATE_SERVICE_URL ?? 'http://127.0.0.1:5221';

export default defineConfig(async (env) => {
  const resolved = typeof probe === 'function' ? await probe(env) : probe;
  return {
    ...resolved,
    cacheDir:
      process.env.PROBE_VITE_CACHE_DIR ?? path.join(appRoot, '.probe-vite-cache'),
    server: {
      ...resolved.server,
      proxy: {
        ...resolved.server?.proxy,
        '/api/translate': { target: service, changeOrigin: false },
        '/api/translations': { target: service, changeOrigin: false },
      },
    },
  };
});