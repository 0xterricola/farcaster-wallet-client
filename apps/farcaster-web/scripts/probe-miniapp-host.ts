/**
 * A real Mini App HOST, for `scripts/verify-miniapp-autologin.mjs`.
 *
 * This is the other half of the app-side SDK: it is the client's own
 * `@farcaster/miniapp-host` package — the same one `components/miniApp/MiniApp.tsx`
 * uses to run other people's Mini Apps — exposing a fake user to fiddy.fun in
 * an iframe. Nothing here is a stub of the PROTOCOL: comlink carries the calls,
 * `miniapp-core`'s shapes are the real ones, and the SIWE message this host
 * answers `signIn` with is signed by a throwaway key through viem, so the app's
 * own verifier has to genuinely accept it.
 *
 * What is fake is the person: fid, handle, name and avatar are this file's
 * constants, and the key is a test key used nowhere else.
 *
 * Served by the dev server (vite transforms it on request, bare imports
 * included) — it is not part of the app's build and nothing imports it.
 */
import {
  createIframeEndpoint,
  exposeToEndpoint,
} from '@farcaster/miniapp-host';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

// A throwaway key, generated for this probe and used nowhere else.
const ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

/**
 * The fake person, taken from the URL so the probe script owns the fixture:
 * whoever runs the probe decides which account the host claims to be.
 */
const params = new URLSearchParams(window.location.search);
const HOST_FID = Number(params.get('fid') ?? 191554);
const HOST_USERNAME = params.get('username') ?? 'probe-host';
const HOST_DISPLAY_NAME = params.get('displayName') ?? 'Probe Host';
const HOST_PFP = params.get('pfpUrl') ?? 'https://example.com/probe-pfp.png';

/** Every call the hosted app made, in order — the probe reads this back. */
const calls: string[] = [];

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

const hostSdk = {
  context: {
    client: {
      platformType: 'web',
      clientFid: 9152,
      added: true,
    },
    user: {
      fid: HOST_FID,
      username: HOST_USERNAME,
      displayName: HOST_DISPLAY_NAME,
      pfpUrl: HOST_PFP,
    },
    features: { haptics: false },
  },
  ready: async () => {
    log('ready');
    setStatus('the hosted app called ready()');
  },
  signIn: async ({ nonce }: { nonce: string }) => {
    log(`signIn nonce=${nonce}`);

    // Built the way this client's own host builds it for the Mini Apps it
    // embeds (`createSiwfMessage` in `farcaster-client-data`): the fid travels
    // in the message's resources, so the account is covered by the signature.
    const message = createSiweMessage({
      address: ACCOUNT.address,
      chainId: 10,
      domain: window.location.host,
      nonce,
      uri: `${window.location.origin}/login`,
      version: '1',
      statement: 'Farcaster Auth',
      resources: [`farcaster://fid/${HOST_FID}`],
    });

    const signature = await ACCOUNT.signMessage({ message });

    return { message, signature, authMethod: 'custody' };
  },
  close: () => undefined,
  openUrl: (url: string) => log(`openUrl ${url}`),
  setPrimaryButton: () => undefined,
  composeCast: async () => ({ cast: undefined }),
  viewProfile: async () => undefined,
  viewCast: async () => undefined,
  viewToken: async () => undefined,
  sendToken: async () => ({ success: false }),
  swapToken: async () => ({ success: false }),
  openMiniApp: async () => undefined,
  requestCameraAndMicrophoneAccess: async () => ({ enabled: false }),
  impactOccurred: () => undefined,
  notificationOccurred: () => undefined,
  selectionChanged: () => undefined,
  ethProviderRequest: async () => undefined,
  ethProviderRequestV2: () => undefined,
  eip6963RequestProvider: () => undefined,
  getCapabilities: async () => ['actions.ready', 'actions.signIn'],
  getChains: async () => ['eip155:10'],
  updateBackState: () => undefined,
  addFrame: async () => undefined,
  addMiniApp: async () => undefined,
  signManifest: async () => undefined,
};

const frame = document.createElement('iframe');
frame.src = `${window.location.origin}/`;
frame.setAttribute('data-fiddy', 'hosted-app');
document.getElementById('frame')?.appendChild(frame);

const endpoint = createIframeEndpoint({
  iframe: frame,
  targetOrigin: window.location.origin,
  debug: false,
});

exposeToEndpoint({
  endpoint,
  // The subset of the host interface this probe's app calls. Typed loosely on
  // purpose: this is a probe host, not the client's own.
  // @ts-expect-error probe host implements the handlers the app uses
  sdk: hostSdk,
  miniAppOrigin: '*',
});

// The probe script reads these back through `page.evaluate`.
Object.assign(window as unknown as Record<string, unknown>, {
  __hostCalls: calls,
  __hostFrame: frame,
});

setStatus('host up, app embedded');
