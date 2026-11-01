import { isProd } from '~/constants/env';

// Dev-only escape hatch: persist `farcasterApi.local` in localStorage to
// flip the API base from prod (`farcaster.xyz/~api`) to a backend running
// on `localhost:8080`. Use the helper from `init/initFarcasterApi.ts` —
// don't poke localStorage directly.
const STORAGE_KEY = 'farcasterApi.local';

function isLocalApiEnabled(): boolean {
  if (isProd) {
    return false;
  }
  if (typeof window === 'undefined') {
    return false;
  }
  return window.localStorage.getItem(STORAGE_KEY) === 'true';
}

// Read once at import time. Exported because it is not only an escape hatch:
// with it on, the app is served by the local mock API, so a device-only
// session IS served (see ~/components/session/useDeviceOnlySession) — the
// landing that says "nothing can serve this session" would be wrong here.
const localApiEnabled = isLocalApiEnabled();

const upstreamApiUrl = 'https://farcaster.xyz/~api';

// Farcaster allows its private web API from the official site and localhost,
// but not arbitrary production origins. Hosted builds use the same-origin
// Cloudflare Pages Function relay at /~api.
const productionApiUrl =
  typeof window === 'undefined'
    ? upstreamApiUrl
    : `${window.location.origin}/~api`;

const baseApiUrl = localApiEnabled
  ? 'http://localhost:8080'
  : isProd
    ? productionApiUrl
    : upstreamApiUrl;

const parsedBaseApiUrl = new URL(baseApiUrl);
const baseApiHost = `${parsedBaseApiUrl.host}${parsedBaseApiUrl.pathname}`;
const baseUseHttps = parsedBaseApiUrl.protocol === 'https:';

const wsUrl = localApiEnabled
  ? 'ws://localhost:8080/stream'
  : 'wss://ws.farcaster.xyz/stream';

export {
  baseApiHost,
  baseApiUrl,
  baseUseHttps,
  localApiEnabled,
  STORAGE_KEY,
  wsUrl,
};
