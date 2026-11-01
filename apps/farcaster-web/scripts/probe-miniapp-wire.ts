/**
 * A real Mini App HOST, for `scripts/verify-miniapp-wire.mjs` — built the way
 * `components/miniApp/MiniApp.tsx` builds one, over two real frames:
 *
 *   `#miniapp-frame`  the frame the host opened (the one `contentWindow` names)
 *   `#foreign-frame`  any other frame in this page: the sibling an attacker
 *                     controls, which can post into the host because the
 *                     listener lives on the host's own window
 *
 * The wire is the client's own: `createIframeEndpoint` → the shipped gate
 * (`~/components/miniApp/miniAppWireGate`) → `@farcaster/miniapp-host`'s own
 * `exposeToEndpoint`. `mount('legacy')` builds the wire the way it was built
 * before card t_c39bf6da — no gate, `miniAppOrigin: '*'` — so both the hole and
 * the fix can be measured in one browser against the same two frames.
 *
 * Both frames are the same page (`probe-miniapp-wire-app.html`), served from
 * another origin than this one (`?app=` names it), so they are real cross-origin
 * frames: the identity `event.source === iframe.contentWindow` is measured here
 * and not assumed.
 *
 * The runner drives this through `window.__wireProbe`. Served by the dev server
 * (vite transforms it on request) — not part of the app's build, nothing
 * imports it.
 */
import {
  createIframeEndpoint,
  exposeToEndpoint,
} from '@farcaster/miniapp-host';

import {
  gateMiniAppWire,
  pinnedMiniAppOrigin,
} from '~/components/miniApp/miniAppWireGate';

const params = new URLSearchParams(window.location.search);
/** The origin the frames are served from — the app's own origin, in production. */
const APP_ORIGIN = params.get('app') ?? window.location.origin;

const miniAppFrame = document.getElementById(
  'miniapp-frame',
) as HTMLIFrameElement;
const foreignFrame = document.getElementById(
  'foreign-frame',
) as HTMLIFrameElement;

for (const [frame, role] of [
  [miniAppFrame, 'miniapp'],
  [foreignFrame, 'foreign'],
] as const) {
  // The role is in the URL so the probe script can tell the two frames apart
  // from outside: they are cross-origin to this page, so it cannot reach into
  // them to find out which is which.
  frame.src = `${APP_ORIGIN}/scripts/probe-miniapp-wire-app.html?role=${role}`;
}

/** Every host member a frame drove, in order. */
const calls: string[] = [];

/**
 * Every message that reached this window, with the two identity questions the
 * gate asks answered for each — so a refusal can be told apart from a message
 * that never arrived, and the browser's own `event.source` identity is
 * measured rather than assumed.
 */
type RawMessage = {
  origin: string;
  fromMiniApp: boolean;
  fromForeign: boolean;
  frameWindow: boolean;
  type: string;
};

const rawMessages: RawMessage[] = [];

window.addEventListener('message', (event) => {
  rawMessages.push({
    origin: event.origin,
    fromMiniApp: event.source === miniAppFrame.contentWindow,
    fromForeign: event.source === foreignFrame.contentWindow,
    frameWindow: Boolean(miniAppFrame.contentWindow),
    type: String((event.data as { type?: string })?.type ?? 'none'),
  });
});

const log = (line: string) => {
  calls.push(line);
  const node = document.getElementById('log');
  if (node) {
    node.textContent = calls.join('\n');
  }
};

const setStatus = (text: string) => {
  const node = document.getElementById('status');
  if (node) {
    node.textContent = text;
  }
};

/** The fake reader this host claims, so a reply is recognisable. */
const HOST_FID = 191554;
const HOST_USERNAME = 'probe-host';

const hostSdk = {
  context: {
    user: {
      fid: HOST_FID,
      username: HOST_USERNAME,
      displayName: 'Probe Host',
      pfpUrl: 'https://example.com/probe-pfp.png',
    },
    client: { platformType: 'web', clientFid: 9152, added: true },
    features: { haptics: false },
  },
  ready: async () => {
    log('ready');
    setStatus('a frame called ready()');
  },
  composeCast: async () => {
    log('composeCast');
    setStatus('a frame called composeCast()');
    return { cast: { hash: '0xprobe' } };
  },
  signIn: async () => {
    log('signIn');
    return { message: 'probe', signature: '0xprobe', authMethod: 'custody' };
  },
  close: () => undefined,
  openUrl: () => undefined,
  setPrimaryButton: () => undefined,
  viewProfile: async () => undefined,
  viewCast: async () => undefined,
  addMiniApp: async () => undefined,
  signManifest: async () => undefined,
  eip6963RequestProvider: () => log('eip6963RequestProvider'),
  ethProviderRequest: async () => {
    log('ethProviderRequest');
    return [];
  },
  getCapabilities: async () => [],
  getChains: async () => [],
};

let unexpose: (() => void) | undefined;

/**
 * Open the wire over `#miniapp-frame`.
 *
 * `gated` is this repo's wire (frame window + launched origin, both required).
 * `legacy` is the wire as it was before this card: the whole SDK exposed to any
 * origin, with comlink's origin check reading `'*'`.
 */
const mount = (mode: 'gated' | 'legacy', pin?: string) => {
  unexpose?.();
  calls.length = 0;

  const endpoint = createIframeEndpoint({
    iframe: miniAppFrame,
    targetOrigin: APP_ORIGIN,
    debug: false,
  });

  // The pin, stated once and used for both halves — the same shape
  // `MiniApp.tsx` uses: what gates the endpoint is also what the package's own
  // origin list is given.
  const pinned =
    mode === 'gated' ? (pin ?? pinnedMiniAppOrigin(APP_ORIGIN)) : undefined;

  const wired = pinned
    ? gateMiniAppWire(endpoint, () => miniAppFrame.contentWindow, pinned)
    : endpoint;

  unexpose = exposeToEndpoint({
    endpoint: wired,
    // The probe host implements the members the app calls, not every member of
    // the interface.
    // @ts-expect-error probe host implements a subset on purpose
    sdk: hostSdk,
    miniAppOrigin: pinned ?? '*',
  });

  setStatus(`wire open (${mode}${pin ? `, pin ${pin}` : ''})`);
  return true;
};

Object.assign(window as unknown as Record<string, unknown>, {
  __wireProbe: {
    mount,
    unmount: () => {
      unexpose?.();
      unexpose = undefined;
    },
    readCalls: () => [...calls],
    readMessages: () => [...rawMessages],
    resetCalls: () => {
      calls.length = 0;
      rawMessages.length = 0;
      const node = document.getElementById('log');
      if (node) {
        node.textContent = '';
      }
    },
    frames: () => ({
      miniAppReady: Boolean(miniAppFrame.contentWindow),
      foreignReady: Boolean(foreignFrame.contentWindow),
      // This page's own origin, for a check that the frames really are another
      // origin.
      hostOrigin: window.location.origin,
      appOrigin: APP_ORIGIN,
    }),
  },
});

setStatus('host up, two frames embedded');
