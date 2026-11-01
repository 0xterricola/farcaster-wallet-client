// End-to-end check of social sign-up (Google/X) in this client.
//
//   # a server WITHOUT the app id: the feature must be absent, not broken
//   HTTPS=true npx vite --port 5179 --strictPort
//
//   # a server WITH the app id (and a node, so a Farcaster sign-in can reach
//   # the shell at the end of the run)
//   HTTPS=true VITE_PRIVY_APP_ID=probe-app-id \
//     VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     npx vite --port 5178 --strictPort
//
//   SOCIAL_SIGNUP_SERVER=https://localhost:5178 \
//   SOCIAL_SIGNUP_PLAIN_SERVER=https://localhost:5179 \
//   SOCIAL_SIGNUP_CLAIM_SERVER=https://localhost:5190 \
//     node scripts/verify-social-signup.mjs
//
// Screenshots land in $SOCIAL_SIGNUP_SHOT_DIR (default: the system temp dir).
//
// WHAT IS STUBBED, AND WHAT IS NOT. Only the third parties are stubbed, and
// every one of them answers in its own shape: Privy's browser SDK (served in
// place of its module, so no real OAuth is attempted and no Privy network call
// is made, including the wallet window that signs), Farcaster's SIWF relay
// (stubbed with a REAL SIWE message signed by a throwaway key, so the app's own
// verifier has to genuinely accept it), and — for stage G only — the registrar
// on Optimism, the read node and the name registry, so a whole account can be
// claimed without one byte reaching a real chain. Everything else is the app:
// the identity mapping, the account book, the route it lands on, the backup
// notice's own storage, the registration it signs and broadcasts, and the
// switcher.
//
// THE RELAY ANSWERS "PENDING" UNTIL A STAGE MEANS IT (`relayApprovesSignIn`).
// The modal starts a sign-in session as soon as it is drawn, so a relay that
// says "completed" to every poll turns the act of opening the way in into a
// finished Farcaster sign-in — MEASURED 2026-10-22 as the reason stage B could
// never find its way back in.
//
// WHAT IT ASSERTS
//   A. without an app id: no doors, no dead buttons, no errors — the Farcaster
//      path exactly as it was, and the app says the feature is absent
//   B. with an app id: both doors, at 390 and 1440, measured once the app says
//      they are usable (the SDK arrives late and remounts — see ~/providers/PrivyRoot)
//   C. pressing Google lands on the account screen, and the account it made is
//      in the device's own book — keyed by the held wallet, named by the email,
//      with no FID invented
//   D. the backup notice: offered, blurred until tapped, deferred for days, asked
//      again when that time passes, silenced for good by the confirm step — and
//      still on screen once the screen has settled, because the account screen
//      is built again inside one page load and a remount is not a dismissal
//   E. signing in with Farcaster from that screen reaches the shell, and the
//      switcher lists BOTH accounts — the social one joined it. MEASURED
//      2026-10-22: this needed the app to stop showing a signed-in session the
//      account screen, whose whole subject is the Farcaster account it does not
//      have yet — see ~/pages/fiddyAccount/FiddyAccountPage
//   F. a third party that refuses (a provider that throws) does not take the
//      client with it: the doors say so and the Farcaster way in still stands
//   G. the account that signed up with Google claims a Farcaster number OF ITS
//      OWN: the fee is asked for at the address the sign-up holds (not at a
//      second, freshly generated one), there are no words to write down, the
//      registration is signed by that window and broadcast by the app, and the
//      device ends with ONE account — the same id it already had — carrying the
//      FID the registrar minted. Needs a third dev server (see the recipe):
//
//        HTTPS=true VITE_PRIVY_APP_ID=probe-app-id \
//          VITE_SNAPCHAIN_HTTP_URL=https://probe-node.invalid \
//          npx vite --config scripts/probe.vite.config.mjs --port 5190 --strictPort
//
// ITERATING ON ONE STAGE. `SOCIAL_SIGNUP_ONLY=G` runs stage G at both widths and
// nothing else (letters may be combined: `AF`); the full run — no variable set —
// is the acceptance, and is the only thing worth calling green.
//
// SAFETY: every non-GET request to anything but the dev servers is aborted and
// counted, so nothing here can post, register or own anything on a real network
// (and for stage G, the registrar, the node and the name registry are answered
// in place, so there is nothing real to reach).

import { createRequire } from 'node:module';
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

/** Which stages to run, for iterating on one of them. Empty means all of them. */
const ONLY = (process.env.SOCIAL_SIGNUP_ONLY ?? '').toUpperCase();
const wanted = (stage) => ONLY === '' || ONLY.includes(stage);

const SERVER = process.env.SOCIAL_SIGNUP_SERVER ?? 'https://localhost:5178';
const PLAIN_SERVER =
  process.env.SOCIAL_SIGNUP_PLAIN_SERVER ?? 'https://localhost:5179';
const OUT = process.env.SOCIAL_SIGNUP_SHOT_DIR ?? os.tmpdir();

const DOMAIN = new URL(SERVER).host;
const NONCE = 'a'.repeat(128);
const CHANNEL_TOKEN = 'SOCIALSIGNUP1';

/** The Farcaster account the stubbed sign-in names: a real, active one. */
const SIGNED_IN_FID = 3;
const SIGNED_IN_HANDLE = 'dwr';

/** The identity the stubbed Privy SDK answers with. A held wallet, and Google. */
const PRIVY_EMAIL = 'probe@gmail.com';
const PRIVY_NAME = 'Probe Person';
const HELD_WALLET = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';

/**
 * Stage G's server: the same app, with a read node that goes nowhere.
 *
 * `https://probe-node.invalid` is a name that cannot resolve, and every request
 * to it is answered by the stub below — so if the stub is ever bypassed the app
 * gets a connection error (an honest failure) rather than a real node's answer,
 * and nothing about this stage can reach a real chain or a real node.
 */
const CLAIM_SERVER =
  process.env.SOCIAL_SIGNUP_CLAIM_SERVER ?? 'https://localhost:5190';
const STUB_NODE = 'https://probe-node.invalid';

/** The endpoint the client signs registrations against, and the registry. */
const OPTIMISM_ENDPOINT = 'https://mainnet.optimism.io';
const ID_GATEWAY_ADDRESS = '0x00000000fc25870c6ed6b6c7e41fb078b7656f69';
const ID_REGISTRY_ADDRESS = '0x00000000fc6c5f01fc30151999387bb99a9f489b';

/** What the stub registrar charges, in wei: the live price on 2026-10-21. */
const REGISTRATION_PRICE_WEI = 81_402_795_512_410n;

/** The FID the stub registrar mints for the held wallet. */
const MINTED_FID = 21088;

/** The @name stage G claims: this probe's own, and nobody else's. */
const CLAIMED_NAME = 'probecbf6';

/** What a person's transfer would put in the account: enough, with room. */
const FUNDED_BALANCE_WEI = 2_000_000_000_000_000n;

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Anything under this origin, as a route pattern. A regex, because the app
 *  posts to the bare origin (`https://mainnet.optimism.io`) and reads `/<path>`
 *  under it (`https://probe-node.invalid/v1/...`), and a glob has to get both
 *  exactly right to be trusted — MEASURED: a `**` glob did not, and the stage
 *  silently fell through to the real name registry. */
const underOrigin = (url) => new RegExp(`^${url.replaceAll('.', '\\.')}`);

/** The same origin, at the path a browser reaches a node through. */
const nodeProxyOn = (server) =>
  new RegExp(`^${server.replaceAll('.', '\\.')}/snapchain-api`);

/**
 * The message decoder, from the app's own dependency.
 *
 * WHY IT IS THE REAL ONE. The app's submit path is protobuf, and a stub that
 * guessed at those bytes would be measuring itself. `@farcaster/core` is the
 * package that built the message, so the stub reads exactly what the app sent —
 * the app key it authorised, and the profile values it wrote — and then answers
 * the app's own read-back with them. Resolved through the workspace package that
 * depends on it, because that is where pnpm links it.
 */
const requireFromWorkspace = createRequire(
  new URL(
    '../../../packages/farcaster-node-client/package.json',
    import.meta.url,
  ),
);

let corePackage;
const decodeSubmitted = (buffer) => {
  corePackage ??= requireFromWorkspace('@farcaster/core');

  const message = corePackage.Message.decode(
    new Uint8Array(buffer ?? new ArrayBuffer(0)),
  );
  const data = message.data ?? {};
  // Hex by hand rather than with a Node-only global: this file is linted by the
  // repo's own config, which does not know Node's globals in `scripts/`.
  const asHex = (bytes) =>
    bytes && bytes.length > 0
      ? `0x${Array.from(bytes)
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')}`
      : null;

  return {
    type: `MESSAGE_TYPE_${String(data.type ?? '')}`,
    fid: Number(data.fid ?? 0),
    hash: asHex(message.hash),
    key: data.keyAddBody?.key ? asHex(data.keyAddBody.key) : null,
    userData: data.userDataBody
      ? {
          type: Number(data.userDataBody.type ?? 0),
          value: String(data.userDataBody.value ?? ''),
        }
      : null,
  };
};

/**
 * The registrar on Optimism, stubbed: reads answered, and a transaction this
 * client signed accepted exactly once.
 *
 * `fund()` is the person's transfer arriving — stage G waits for the app to ask
 * for the fee, reads what it asked for, and only then lets the money land, so
 * the screen a person actually meets is the screen that gets measured. The FID
 * is minted by the send: `IdRegistry.idOf` answers it from then on, which is the
 * same read the app itself polls to learn its number.
 */
const createChainStub = () => {
  let funded = false;
  let registered = false;
  const sent = [];

  const answer = (route, body, result) =>
    route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }),
    });

  return {
    sent,
    isRegistered: () => registered,
    fund: () => {
      funded = true;
    },
    handle: async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      const params = body.params ?? [];
      const call = params[0] ?? {};

      switch (body.method) {
        case 'eth_chainId':
          return answer(route, body, '0xa');
        case 'eth_getBalance':
          return answer(
            route,
            body,
            `0x${(funded ? FUNDED_BALANCE_WEI : 0n).toString(16)}`,
          );
        case 'eth_getTransactionCount':
          return answer(route, body, '0x0');
        case 'eth_estimateGas':
          return answer(route, body, '0x30d40');
        case 'eth_gasPrice':
          return answer(route, body, '0x3b9aca00');
        case 'eth_maxPriorityFeePerGas':
          return answer(route, body, '0x5f5e100');
        case 'eth_sendRawTransaction':
          sent.push(String(params[0] ?? ''));
          registered = true;
          return answer(route, body, `0x${'ab'.repeat(32)}`);
        case 'eth_call': {
          const to = String(call.to ?? '').toLowerCase();

          if (to === ID_GATEWAY_ADDRESS) {
            return answer(
              route,
              body,
              `0x${REGISTRATION_PRICE_WEI.toString(16)}`,
            );
          }

          if (to === ID_REGISTRY_ADDRESS) {
            return answer(
              route,
              body,
              `0x${(registered ? MINTED_FID : 0).toString(16)}`,
            );
          }

          return answer(route, body, '0x');
        }
        default:
          return answer(route, body, '0x');
      }
    },
  };
};

/**
 * The read node, stubbed: it has already seen everything it was told.
 *
 * WHAT IT IS AND IS NOT. It decodes the messages the app submits (with the app's
 * own decoder, above) and then reports them back on the reads the app makes —
 * the gasless key on `/v1/signersByFid`, the profile fields on
 * `/v1/userDataByFid`, and an on-chain signer on `/v1/onChainSignersByFid`,
 * which is this client's own test for "the node knows this FID at all". It does
 * not gossip, merge or validate anything; what stage G measures is the app's own
 * behaviour, and the node here is a third party answering in its own shape.
 */
const createNodeStub = () => {
  const state = { key: null, userData: new Map(), submits: [], reads: [] };

  const messageJson = (decoded) => ({
    hash: decoded.hash ?? `0x${'00'.repeat(32)}`,
    signer: `0x${'11'.repeat(32)}`,
    signature: `0x${'22'.repeat(64)}`,
    signatureScheme: 'SIGNATURE_SCHEME_ED25519',
    hashScheme: 'HASH_SCHEME_BLAKE3',
    data: {
      type: decoded.type,
      fid: MINTED_FID,
      timestamp: Math.floor(Date.now() / 1000),
      network: 'FARCASTER_NETWORK_MAINNET',
      ...(decoded.userData
        ? {
            userDataBody: {
              type: decoded.userData.type,
              value: decoded.userData.value,
            },
          }
        : {}),
    },
  });

  const fulfil = (route, body, status = 200) =>
    route.fulfill({
      status,
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  return {
    state,
    handle: async (route) => {
      const request = route.request();
      // The app reads a cross-origin node through its own same-origin path
      // (`/snapchain-api/...`, see `~/snapchain/nodeEnv`), and a node it is told
      // to read directly. Both are this stub, so both are accepted here.
      const path = new URL(request.url()).pathname.replace(
        /^\/snapchain-api/,
        '',
      );

      state.reads.push(
        `${request.method()} ${path}${new URL(request.url()).search}`,
      );

      if (path === '/v1/info') {
        return fulfil(route, { version: 'probe', numShards: 1, syncHeight: 1 });
      }

      if (request.method() === 'POST' && path === '/v1/submitMessage') {
        const decoded = decodeSubmitted(request.postDataBuffer());

        state.submits.push(decoded.type);

        if (decoded.key) {
          state.key = decoded.key;
        }

        if (decoded.userData) {
          state.userData.set(decoded.userData.type, decoded.userData.value);
        }

        return fulfil(route, messageJson(decoded));
      }

      if (path === '/v1/onChainSignersByFid') {
        // Non-empty is the app's own "the node has seen this FID".
        return fulfil(route, { events: [{ fid: MINTED_FID }] });
      }

      if (path === '/v1/signersByFid') {
        return fulfil(route, {
          signers: state.key
            ? [
                {
                  source: 'signer',
                  key: state.key,
                  keyType: 1,
                  fid: MINTED_FID,
                  addedAt: Math.floor(Date.now() / 1000),
                  nonce: 1,
                  scopes: ['user'],
                  ttl: 7_776_000,
                },
              ]
            : [],
          gaslessSignerCount: state.key ? 1 : 0,
          gaslessSignerLimit: 1000,
          currentUserNonce: state.key ? 1 : 0,
        });
      }

      if (path === '/v1/userDataByFid') {
        return fulfil(route, {
          messages: Array.from(state.userData.entries()).map(
            ([type, value]) => ({
              hash: `0x${'33'.repeat(32)}`,
              data: {
                type: 'MESSAGE_TYPE_USER_DATA_ADD',
                fid: MINTED_FID,
                timestamp: Math.floor(Date.now() / 1000),
                network: 'FARCASTER_NETWORK_MAINNET',
                userDataBody: { type, value },
              },
            }),
          ),
        });
      }

      return fulfil(route, { error: 'not found' }, 404);
    },
  };
};

/**
 * The name registry, stubbed: the @name is free, and the claim is accepted.
 *
 * A POST to a registry is exactly the kind of write this probe exists to keep
 * away from the world, so it is answered here — in the shape the registry
 * answers with — rather than being aborted and counted. What it answered is
 * recorded, because a stage that asked the real registry for a name would
 * otherwise look identical to one that asked this.
 */
const createNameRegistryStub = () => {
  const requests = [];

  return {
    requests,
    handle: async (route) => {
      const request = route.request();
      const method = request.method();

      requests.push(method);

      if (method !== 'POST') {
        return route.fulfill({
          status: 404,
          headers: JSON_HEADERS,
          body: JSON.stringify({ code: 'not_found' }),
        });
      }

      return route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ transfer: { to: MINTED_FID } }),
      });
    },
  };
};

const signer = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: signer.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SERVER}/login`,
  version: '1',
});
const signature = await signer.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

/**
 * Privy's SDK, replaced by the smallest module that answers the three things
 * this app imports. It is a stub of the THIRD PARTY, never of the app: what
 * `login()` does here is what the real SDK does on a successful sign-up — call
 * back with the user — so everything downstream is the app's own code.
 *
 * NOT SIGNED IN UNTIL `login()` COMPLETES. A sign-up stub that declares
 * `authenticated: true` with a user already in hand models somebody who is past
 * the screen the doors live on. This one starts signed out and flips only when
 * a sign-up finishes, keeping the flag in `sessionStorage` so the reload the app
 * does afterwards (`window.location.replace`, in `~/components/login/
 * SocialSignUpPrivy`) still lands signed in — which is what the real SDK's own
 * session does, and what the account screen's "show me my backup words" needs.
 * The app's doors key on `~/providers/PrivyRoot`'s `ready`, not on this, so
 * nothing in stages B–F needs the stub to claim more than the truth.
 */
const PRIVY_STUB = `
const SESSION_KEY = 'fiddy-probe-privy-session';

const user = {
  linkedAccounts: [
    { type: 'google_oauth', subject: 'probe-google-sub', email: ${JSON.stringify(PRIVY_EMAIL)}, name: ${JSON.stringify(PRIVY_NAME)} },
    { type: 'wallet', address: ${JSON.stringify(HELD_WALLET)}, chainType: 'ethereum', walletClientType: 'privy' },
  ],
};

/** True only after a sign-up this page load (or an earlier one) completed. */
const signedIn = () => {
  try {
    return globalThis.sessionStorage?.getItem(SESSION_KEY) === 'yes';
  } catch {
    return false;
  }
};

export const PrivyProvider = ({ children }) => children;

export const useLogin = (callbacks) => ({
  login: (options) => {
    globalThis.__privyLoginCalls = (globalThis.__privyLoginCalls ?? []).concat([options ?? null]);
    setTimeout(() => {
      try {
        globalThis.sessionStorage?.setItem(SESSION_KEY, 'yes');
      } catch {
        /* the session is a convenience here, never a requirement */
      }
      callbacks?.onComplete?.({ user, isNewUser: true, wasAlreadyAuthenticated: false, loginMethod: 'google', loginAccount: null });
    }, 50);
  },
});

export const usePrivy = () => {
  const inSession = signedIn();

  return {
    authenticated: inSession,
    ready: true,
    user: inSession ? user : null,
    exportWallet: async () => {
      globalThis.__privyExportCalls = (globalThis.__privyExportCalls ?? 0) + 1;
    },
  };
};

/**
 * The window that holds the wallet's words, and what this app asks of it.
 *
 * WHAT IT IS IMITATING, EXACTLY. A real embedded wallet lives inside the
 * provider's iframe and answers a deliberately small set of methods, all of them
 * signing ones (the private key never leaves that frame):
 *
 *   eth_signTransaction    returns the SIGNED raw transaction — not a hash —
 *                          which is what lets this app broadcast it through its
 *                          own Optimism endpoint with its own guards in force;
 *   eth_signTypedData_v4   the EIP-712 authorisation the node's gasless KEY_ADD
 *                          needs from the account's owner.
 *
 * Both answers are shaped like the real ones (a raw transaction, a 65-byte
 * signature), and every ask is recorded, so a stage can prove the app asked its
 * own sign-up for the signature rather than a key it made up.
 */
const heldProvider = {
  request: async ({ method }) => {
    globalThis.__privySignCalls = (globalThis.__privySignCalls ?? []).concat([
      method,
    ]);

    if (method === 'eth_signTransaction') {
      return '0x02' + 'ff' + 'ab'.repeat(40);
    }

    if (method === 'eth_signTypedData_v4') {
      return '0x' + '1b'.repeat(65);
    }

    throw new Error('this probe does not answer ' + method);
  },
};

export const useWallets = () => {
  const inSession = signedIn();

  return {
    wallets: inSession
      ? [
          {
            type: 'wallet',
            address: ${JSON.stringify(HELD_WALLET)},
            chainType: 'ethereum',
            walletClientType: 'privy',
            getEthereumProvider: () => heldProvider,
          },
        ]
      : [],
  };
};
`;

/**
 * The same module, refusing — a provider that answers by throwing.
 *
 * This is the shape of a third party that will not cooperate: the dashboard does
 * not know this app id, or its script is blocked, or it is simply broken. What
 * the client must do about that is measured in stage F, and it must never be
 * "replace the whole screen with an error".
 */
const PRIVY_REFUSING_STUB = `
export const PrivyProvider = () => {
  throw new Error('privy refused this app id');
};

export const useLogin = () => ({ login: () => undefined });
export const usePrivy = () => ({ authenticated: false, ready: false, exportWallet: async () => undefined });
export const useWallets = () => ({ wallets: [] });
`;

const startedAt = Date.now();
const stage = (step) =>
  console.log(
    `[${String(Math.round((Date.now() - startedAt) / 1000)).padStart(3)}s] ${step}`,
  );

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Every write this probe could accidentally make, and every page error. */
const writes = [];
const pageErrors = [];

/**
 * Whether the stubbed relay may say "the person approved this on their phone".
 *
 * FALSE unless a stage is deliberately signing in with Farcaster.
 *
 * WHY. The relay stub used to answer `completed` to every poll, and the modal
 * starts a Sign-In-With-Farcaster session the moment it is drawn
 * (`~/components/login/LoginWithMobile` creates the channel on mount and then
 * polls it) — so the act of opening the way in was itself a completed
 * Farcaster sign-in: the app signed in, `window.location.replace` sent the
 * browser off the setup screen, and stage B's own retry loop could never find
 * the way back in. MEASURED 2026-10-22 on a real Chrome against a dev server
 * with `VITE_PRIVY_APP_ID=probe-app-id`: press at 6.2s, modal open at 6.2s,
 * navigation off `/welcome/ready` at 7.5s, and every later attempt then died
 * after 180s on "the sign-in entry point was not on the setup screen" because
 * the browser was signed in and looking at the client. A relay that has not
 * been scanned says `pending`; a probe that is signing in says so, here.
 */
let relayApprovesSignIn = false;

/** Applies the two stubs, and refuses anything that is not a read. */
const armRoutes = async (page, { server, privy }) => {
  // Registered FIRST so it is matched LAST: Playwright checks handlers in
  // reverse order of registration, and a handler that runs would end the chain.
  await page.route('**', async (route) => {
    const request = route.request();

    if (
      ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) ||
      request.url().startsWith(server) ||
      request.url().startsWith('https://relay.farcaster.xyz')
    ) {
      return route.continue();
    }

    writes.push(`${request.method()} ${request.url().slice(0, 110)}`);

    return route.abort();
  });

  await page.route('**/*privy-io*', async (route) => {
    const body =
      privy === false
        ? undefined
        : privy === 'refuse'
          ? PRIVY_REFUSING_STUB
          : PRIVY_STUB;

    if (body === undefined) {
      return route.continue();
    }

    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/javascript' },
      body,
    });
  });

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();

    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }

    if (method === 'POST') {
      return route.fulfill({
        status: 201,
        headers: CORS,
        body: JSON.stringify({
          channelToken: CHANNEL_TOKEN,
          url: `https://farcaster.xyz/~/siwf?channelToken=${CHANNEL_TOKEN}`,
          nonce: NONCE,
        }),
      });
    }

    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify(
        relayApprovesSignIn
          ? {
              state: 'completed',
              nonce: NONCE,
              message,
              signature,
              fid: SIGNED_IN_FID,
              username: SIGNED_IN_HANDLE,
              displayName: SIGNED_IN_HANDLE,
            }
          : {
              state: 'pending',
              nonce: NONCE,
              signatureParams: {
                siweUri: `${server}/login`,
                domain: new URL(server).host,
                nonce: NONCE,
              },
            },
      ),
    });
  });
};

/**
 * The way in: the one entry point this probe presses, defined once.
 *
 * Enabled, on screen, and named — and the same locator is used for the wait and
 * for the press, so the thing waited for and the thing pressed cannot disagree.
 *
 * WHY IT IS NOT "ANY BUTTON". MEASURED 2026-10-21/22: this used to be
 * `waitForSelector('button')`, and Playwright waits for the FIRST match in DOM
 * order to be VISIBLE. With an app id configured the first button in the
 * document is the account switcher's entry
 * (`data-fiddy="account-switcher-entry"`, from `~/layouts/AuthedLeftSideBar`):
 * reproducing it gave a 180s timeout in stage B, with the call log reporting 27
 * polls, 12 buttons in the document, always resolving to that one button, which
 * the mobile layout keeps off-screen. The app was correct; the wait was not.
 * (`:visible` is also why pressing by text alone is not enough here: the same
 * screen can hold an off-screen entry that no finger could reach.)
 */
const entryPoint = (page) =>
  page
    .locator('button:enabled:visible, a:visible, [role=button]:enabled:visible')
    .filter({ hasText: /go social/i })
    .first();

/** Open the way in, through the door the client already has. */
const openLoginModal = async (page, server, { beforePress } = {}) => {
  // 'commit', not 'domcontentloaded': in dev the module graph of a cold Vite
  // server holds DOMContentLoaded for as long as its dependency optimisation
  // takes, and waiting on it would measure the bundler rather than the app.
  // Everything that matters is waited for explicitly, below.
  await page.goto(`${server}/welcome/ready`, {
    waitUntil: 'commit',
    timeout: 180_000,
  });
  // MEASURED 2026-10-22, this box at load ~50, a fresh worktree: the first load
  // of this screen on a cold Vite server took 89s (no app id) and 67s (with an
  // app id) — ~2700 module requests, each transformed on demand, none of them
  // failed and none of them slow on their own. The wait is on the bundler, not
  // on the app: the same servers paint in ~1.5s once their graph is warm, and
  // the runs below re-load these routes many times. `verify-account-switching`
  // waits 180s for the same reason.
  const appeared = await entryPoint(page)
    .waitFor({ state: 'visible', timeout: 180_000 })
    .then(() => true)
    .catch(() => false);

  if (!appeared) {
    throw new Error('the sign-in entry point was not on the setup screen');
  }

  await page.waitForTimeout(1_500);

  // Something the app has to settle first — in the app-id runs, the arrival of
  // Privy's provider, which remounts the subtree and would otherwise take the
  // modal away from under the press below. See `waitForPrivyState`.
  if (beforePress) {
    await beforePress();
  }

  const pressed = await entryPoint(page)
    .innerText()
    .then((text) => text.replace(/\s+/g, ' ').trim())
    .catch(() => null);

  await entryPoint(page).click({ timeout: 30_000 });

  // And the press has to have worked: the modal's own block is the proof, and
  // waiting for it here means every stage below starts from the same place
  // instead of from a fixed sleep. The anchor is the one the modal draws in
  // every build — the Farcaster door — because with no app id the social block
  // is absent by design and waiting on it would fail on exactly the run that
  // stage A asserts is correct.
  await page.waitForSelector('[data-fiddy="connect-door"]', {
    timeout: 60_000,
  });
  await page.waitForTimeout(1_500);

  return pressed;
};

/**
 * The state the app publishes about Privy, and the wait for a settled one.
 *
 * The doors are drawn before the SDK arrives — disabled, saying "one moment" —
 * and when it does arrive the subtree remounts, which closes a modal that was
 * opened in the meantime. MEASURED (2026-10-22, this box): the SDK's chunk took
 * ~50s to arrive in dev, so a probe that presses the door the moment it appears
 * presses a door that is about to be taken away. The app publishes the settled
 * moment on the document element (`data-fiddy-privy`, see ~/providers/PrivyRoot);
 * waiting for it is what makes the runs below measure the app rather than the
 * bundler.
 */
const readPrivyState = (page) =>
  page.evaluate(() =>
    document.documentElement.getAttribute('data-fiddy-privy'),
  );

const waitForPrivyState = (page, wanted, timeout = 300_000) =>
  page.waitForFunction(
    (expected) =>
      document.documentElement.getAttribute('data-fiddy-privy') === expected,
    wanted,
    { timeout },
  );

const readAccountBook = (page) =>
  page.evaluate(async () => {
    const accountsModule =
      await import('/src/snapchain/accounts/localAccounts.ts');
    const socialModule = await import('/src/lib/socialAccount.ts');

    const accounts = await accountsModule.loadLocalAccounts();
    const currentId = await accountsModule.loadCurrentAccountId();

    return {
      currentId: currentId ?? null,
      accounts: accounts.map((account) => ({
        id: account.id,
        custodyAddress: account.custodyAddress,
        fid: account.fid ?? null,
        email: account.email ?? null,
        provider: account.provider ?? null,
        custody: account.walletCustody ?? null,
        phrase: account.phrase ?? null,
        // The switcher's own naming function, not a re-implementation of it.
        label: accountsModule.describeLocalAccount(account),
        isSocial: socialModule.isSocialAccount(account),
      })),
    };
  });

const readNotice = (page) =>
  page.evaluate(() => {
    // The whitespace collapse is done here rather than by the probe's own `dash`
    // helper: this function runs in the page, where nothing from the script's
    // scope exists. MEASURED 2026-10-22 — reaching stage D at all was what found
    // it, because `dash` is not defined in a browser context and the run died
    // with "ReferenceError: dash is not defined" the moment the notice was read.
    const dash = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const panel = document.querySelector('[data-fiddy="seed-backup-words"]');
    const notice = document.querySelector('[data-fiddy="seed-backup"]');

    return {
      present: Boolean(notice),
      title: dash(document.querySelector('#seed-backup-title')?.textContent),
      text: dash(notice?.textContent),
      wordsHidden: panel ? panel.getAttribute('data-hidden') : null,
      blurred: panel ? (panel.style.filter || '').includes('blur') : null,
      wordCount: panel ? panel.querySelectorAll('li').length : null,
      thanks: Boolean(
        document.querySelector('[data-fiddy="seed-backup-thanks"]'),
      ),
    };
  });

const pressButton = (page, label) =>
  page.evaluate((wanted) => {
    for (const element of document.querySelectorAll(
      'button, a, [role=button]',
    )) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();

      if (text.toLowerCase().includes(wanted.toLowerCase())) {
        element.click();
        return text;
      }
    }

    return null;
  }, label);

const readSeedBackupState = (page, id) =>
  page.evaluate(async (accountId) => {
    const module = await import('/src/lib/seedBackup.ts');

    return await module.loadSeedBackupState(accountId);
  }, id);

const writeSeedBackupState = (page, id, state) =>
  page.evaluate(
    async ({ accountId, next }) => {
      const module = await import('/src/lib/seedBackup.ts');

      await module.saveSeedBackupState(accountId, next);
    },
    { accountId: id, next: state },
  );

/** ── A. the build without an app id ──────────────────────────────────────── */

const runWithoutAppId = async (browser, width) => {
  stage(`A. no app id, at ${width}px`);
  relayApprovesSignIn = false;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: width < 600 ? 844 : 900 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

  await armRoutes(page, { server: PLAIN_SERVER, privy: false });
  await openLoginModal(page, PLAIN_SERVER);

  const seen = await page.evaluate(() => ({
    socialBlock: Boolean(document.querySelector('[data-fiddy="login-social"]')),
    doors: Array.from(
      document.querySelectorAll('[data-fiddy^="social-sign-up-"]'),
    ).length,
    mentionsGoogle: /continue with google/i.test(document.body.innerText),
    farcasterPath:
      /open link on mobile|asking farcaster for a sign-in code|sign in with/i.test(
        document.body.innerText,
      ),
    privy: document.documentElement.getAttribute('data-fiddy-privy'),
  }));

  check(
    `A1 ${width}px: the social block is absent, not empty`,
    seen.socialBlock === false && seen.doors === 0 && !seen.mentionsGoogle,
    JSON.stringify(seen),
  );
  check(
    `A2 ${width}px: the Farcaster way in is still there`,
    seen.farcasterPath === true,
    JSON.stringify(seen),
  );
  // The build says so out loud, so a probe (or a person) never has to guess
  // whether a missing door is a switch or a fault.
  check(
    `A3 ${width}px: the app publishes that the feature is absent`,
    seen.privy === 'absent',
    `${seen.privy}`,
  );

  await page.screenshot({
    path: `${OUT}/social-signup-${width}-no-app-id.png`,
  });
  await context.close();
};

/** ── B–E. the build with an app id ───────────────────────────────────────── */

const runWithAppId = async (browser, width) => {
  stage(`B. with an app id, at ${width}px`);
  relayApprovesSignIn = false;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: width < 600 ? 844 : 900 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

  await armRoutes(page, { server: SERVER, privy: 'stub' });

  // The settled moment, not the first one: the app publishes when signing up can
  // actually be attempted, and that is after Privy's provider has arrived and
  // the subtree has remounted (`~/providers/PrivyRoot`). Measured here: the
  // state read right after the setup screen painted, and the one the press
  // below is made in.
  let atPaint = null;
  let settled = null;
  let attempts = 0;
  let doorsUsable = false;
  let lastError = null;

  // The app is allowed to re-decide this screen: MEASURED on this box, the setup
  // screen reloads itself once when the modal's own chunk is fetched for the
  // first time on a cold dev server, which closes the modal mid-run. That is a
  // bundler's behaviour, not the app's, so the probe re-opens the way in instead
  // of asserting on the moment the reload happens — and records how many
  // attempts it took.
  for (attempts = 1; attempts <= 3 && !doorsUsable; attempts += 1) {
    try {
      await openLoginModal(page, SERVER, {
        beforePress: async () => {
          if (atPaint === null) {
            atPaint = await readPrivyState(page);
          }

          await waitForPrivyState(page, 'ready');
        },
      });

      settled = await readPrivyState(page);

      doorsUsable = await page
        .waitForSelector(
          '[data-fiddy="social-sign-up-google"]:not([disabled])',
          {
            timeout: 90_000,
          },
        )
        .then(() => true)
        .catch(() => false);
    } catch (error) {
      // The reload above can land in the middle of a measurement, and a page
      // that is navigating has no execution context left to read: that is a
      // retry, not a failure of the app. MEASURED 2026-10-22: without this the
      // run died here with "Execution context was destroyed, most likely
      // because of a navigation" instead of re-opening the way in.
      lastError = String(error).slice(0, 200);
    }
  }

  check(
    `B0 ${width}px: the doors are only measured once the app says they are usable ('${atPaint}' → '${settled}', attempt ${attempts - 1})`,
    (atPaint === 'loading' || atPaint === 'ready' || atPaint === null) &&
      settled === 'ready' &&
      doorsUsable,
    `${atPaint} → ${settled}, usable=${doorsUsable}, attempts=${attempts - 1}${lastError ? `, retired after: ${lastError}` : ''}`,
  );

  const doors = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-fiddy^="social-sign-up-"]'),
    ).map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()),
  );

  check(
    `B1 ${width}px: both doors are drawn, from the one list`,
    doors.length === 2 &&
      doors[0] === 'Continue with Google' &&
      doors[1] === 'Continue with X',
    doors.join(' | '),
  );

  const jargon = await page.evaluate(() =>
    /privy|oauth|embedded wallet/i.test(document.body.innerText),
  );
  check(
    `B2 ${width}px: no jargon on the way in`,
    jargon === false,
    `${jargon}`,
  );

  await page.screenshot({ path: `${OUT}/social-signup-${width}-doors.png` });

  stage(`C. pressing Google, landed account, at ${width}px`);
  const pressed = await pressButton(page, 'Continue with Google');

  check(
    `C1 ${width}px: the Google door is pressable`,
    pressed !== null,
    `${pressed}`,
  );

  await page.waitForSelector(
    '[data-fiddy="fiddy-account"][data-state="ready"]',
    {
      timeout: 60_000,
    },
  );
  await page.waitForTimeout(2_000);

  const screen = await page.evaluate(() => ({
    url: window.location.pathname,
    text: (document.body.innerText ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400),
  }));

  check(
    `C2 ${width}px: the sign-up lands on the account screen`,
    screen.url === '/welcome/account',
    screen.url,
  );
  check(
    `C3 ${width}px: the screen names the account by what was signed up with`,
    /probe@gmail\.com/.test(screen.text) &&
      /signed up with google/i.test(screen.text),
    screen.text.slice(0, 160),
  );
  check(
    `C4 ${width}px: it says plainly what is still missing`,
    /no farcaster account yet/i.test(screen.text),
    screen.text.slice(0, 160),
  );

  const book = await readAccountBook(page);
  const social = book.accounts.find((account) => account.isSocial);

  check(
    `C5 ${width}px: the account is in the device's own book, selected`,
    book.accounts.length === 1 &&
      book.currentId === HELD_WALLET.toLowerCase() &&
      social?.id === HELD_WALLET.toLowerCase(),
    JSON.stringify(book),
  );
  check(
    `C6 ${width}px: it is keyed by the held wallet and no FID is invented`,
    social?.fid === null &&
      social?.custody === 'privy' &&
      social?.phrase === null &&
      social?.provider === 'google',
    JSON.stringify(social),
  );
  check(
    `C7 ${width}px: the switcher's own label function names it by the email`,
    social?.label === PRIVY_EMAIL,
    `${social?.label}`,
  );

  stage(`D. the backup notice, at ${width}px`);
  // Two things are waited for before the notice is measured, and both are the
  // app's own timing rather than a fixed sleep: the notice's decision is made in
  // an async read of this device's storage, and the screen it lands on is
  // re-created once more while the rest of the app settles (Privy's provider
  // arrives late and its subtree is replaced — see `~/providers/PrivyRoot`).
  // MEASURED 2026-10-22: without the settle below, D1 could read a notice that
  // was about to be taken away by that remount and call the screen correct.
  const noticeAppeared = await page
    .waitForSelector('[data-fiddy="seed-backup"]', { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(2_500);

  const notice = await readNotice(page);

  check(
    `D1 ${width}px: the notice is offered, in plain words`,
    noticeAppeared &&
      notice.present === true &&
      notice.title === 'Back up your account' &&
      /signed up with google/i.test(notice.text) &&
      /nobody can give them to you again/i.test(notice.text),
    notice.text.slice(0, 200),
  );
  // The defect this measures: the notice's own effect records the ask as it
  // asks, so an extra mount pass in the same page load reads that write back
  // and hides the notice — the person is left with an account screen and no
  // reminder at all. A remount is not a dismissal.
  check(
    `D1b ${width}px: it is still on screen once the screen has settled`,
    notice.present === true,
    `appeared=${noticeAppeared} present=${notice.present}`,
  );
  // MEASURED 2026-10-22: the words block is not drawn at all until the notice's
  // own reveal step, so this used to read `null` here and fail on a screen that
  // was exactly right — no list of words, because there is nothing this device
  // holds to print. Both readings mean the same thing to a person: nothing
  // printed. The strong half of the claim is measured below, on the block
  // itself once it exists (D4b).
  check(
    `D2 ${width}px: no words are printed that this device does not hold`,
    notice.wordCount === null || notice.wordCount === 0,
    notice.wordCount === null
      ? 'the words block is not drawn yet — nothing printed'
      : `${notice.wordCount} words`,
  );

  await pressButton(page, 'Show me my backup words');
  await page.waitForTimeout(800);

  const revealed = await readNotice(page);

  check(
    `D3 ${width}px: the words block is blurred until it is asked for`,
    revealed.wordsHidden === 'true' && revealed.blurred === true,
    JSON.stringify(revealed),
  );

  await page.screenshot({
    path: `${OUT}/social-signup-${width}-notice-blurred.png`,
  });

  await pressButton(page, 'Tap to show the words');
  await page.waitForTimeout(800);

  const shown = await readNotice(page);

  check(
    `D4 ${width}px: tapping reveals it`,
    shown.wordsHidden === 'false' && shown.blurred === false,
    JSON.stringify(shown),
  );
  // The words block exists now, so this is the strong reading of D2's claim: the
  // revealed block prints no words, because this account's words are held by the
  // sign-up and this device holds none of them.
  check(
    `D4b ${width}px: the revealed block still prints none of them`,
    shown.wordCount === 0,
    `${shown.wordCount} words`,
  );

  await page.screenshot({
    path: `${OUT}/social-signup-${width}-notice-revealed.png`,
  });

  stage(`D5. putting it off buys days, then it comes back, at ${width}px`);
  // The button that puts the notice off depends on the step the notice is on:
  // after D4 it is on the revealed step, whose deferral is "Remind me later"
  // ("Not now" belongs to the ask step, and the ✕ in the header is the same
  // deferral — both call the one function measured here).
  const deferredBy = await pressButton(page, 'Remind me later');

  check(
    `D5a ${width}px: the revealed step offers putting it off`,
    deferredBy !== null,
    `${deferredBy}`,
  );
  await page.waitForTimeout(800);

  const deferred = await readSeedBackupState(page, HELD_WALLET.toLowerCase());

  check(
    `D5 ${width}px: "not now" is recorded as a deferral, days out`,
    deferred.status === 'deferred' &&
      deferred.remindAfter - deferred.lastShownAt === 3 * 24 * 60 * 60 * 1000,
    JSON.stringify(deferred),
  );
  check(
    `D6 ${width}px: the notice is gone until then`,
    (await readNotice(page)).present === false,
    '',
  );

  // The clock moves by writing the stored moment into the past — the app is
  // reloaded after, so the notice is re-decided by the app's own rule. The write
  // is read back before the reload: if the stored moment did not move, the
  // reload is measuring the wrong thing, and the check below has to be able to
  // say so rather than blaming the app.
  const moved = {
    ...deferred,
    lastShownAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
    remindAfter: Date.now() - 1_000,
  };

  await writeSeedBackupState(page, HELD_WALLET.toLowerCase(), moved);

  const readBack = await readSeedBackupState(page, HELD_WALLET.toLowerCase());

  await page.reload({ waitUntil: 'commit' });

  const cameBack = await page
    .waitForSelector('[data-fiddy="seed-backup"]', { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(1_500);

  // What the reloaded screen actually is, so a failure here says which of the
  // three things went wrong — the stored moment, the screen, or the notice.
  const afterReload = await page.evaluate(() => ({
    url: window.location.pathname,
    account: Boolean(
      document.querySelector(
        '[data-fiddy="fiddy-account"][data-state="ready"]',
      ),
    ),
    notice: Boolean(document.querySelector('[data-fiddy="seed-backup"]')),
    text: (document.body.innerText ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120),
  }));

  check(
    `D7 ${width}px: it comes back by itself when that time passes`,
    cameBack && afterReload.notice === true,
    `stored=${JSON.stringify(readBack)} onScreen=${JSON.stringify(afterReload)}`,
  );

  stage(`D8. the confirm step ends the asking, at ${width}px`);
  await pressButton(page, 'Show me my backup words');
  await page.waitForTimeout(500);
  await pressButton(page, 'I have written them down');
  await page.waitForTimeout(800);

  const savedState = await readSeedBackupState(page, HELD_WALLET.toLowerCase());

  check(
    `D8 ${width}px: the person's own confirm is what stops it`,
    savedState.status === 'saved' && typeof savedState.savedAt === 'number',
    JSON.stringify(savedState),
  );

  await page.reload({ waitUntil: 'commit' });

  const accountBack = await page
    .waitForSelector('[data-fiddy="fiddy-account"]', { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(2_500);

  check(
    `D9 ${width}px: and it does not ask again`,
    accountBack && (await readNotice(page)).present === false,
    `accountOnScreen=${accountBack}`,
  );

  stage(`E. a Farcaster account joins it, at ${width}px`);
  // The one place this run means it: from here the phone has "approved", so the
  // relay says so and the app's own sign-in completes.
  relayApprovesSignIn = true;
  await pressButton(page, 'I already have a Farcaster account');
  await page.waitForTimeout(2_500);

  // Measured, not assumed: the sign-in screen is a route this probe has never
  // reached before, and a wait that throws here would hide E2–E4 behind one
  // error instead of saying which step failed.
  //
  // `attached`, not `visible`: MEASURED 2026-10-22, at 390px the shell renders
  // this entry inside the header's own menu, so Playwright's visibility test
  // failed for a client that was up and correct (the same wait passed at
  // 1440px). What stage E is about is that the client is on screen at all.
  const shellArrived = await page
    .waitForSelector('[data-fiddy="account-switcher-entry"]', {
      state: 'attached',
      timeout: 120_000,
    })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(2_500);

  // Two facts, from the app's own storage rather than from the screen: where
  // the sign-in left the browser, and which Farcaster account it proved. The
  // proof is the one the app's own sign-in keeps (`~/lib/siwfSession`), written
  // for thirty minutes so the agent service can verify ownership later.
  const current = await page.evaluate(() => {
    let proof = null;

    try {
      proof = JSON.parse(
        window.sessionStorage.getItem('fiddy.siwf.proof') ?? 'null',
      );
    } catch {
      proof = null;
    }

    return {
      url: window.location.pathname,
      entry: (
        document.querySelector('[data-fiddy="account-switcher-entry"]')
          ?.textContent ?? ''
      )
        .replace(/\s+/g, ' ')
        .trim(),
      proofFid: proof?.fid ?? null,
      token: document.body.innerText.length,
    };
  });

  // MEASURED 2026-10-22, and the reason this reads the way it does: the
  // handshake from this screen completes and proves the Farcaster account
  // (`~/lib/siwfSession` keeps the proof), and the app leaves the sign-up screen
  // for the client instead of re-showing the screen that says "no Farcaster
  // account yet" (see ~/pages/fiddyAccount/FiddyAccountPage). What it does NOT
  // do is add that Farcaster account to the device's own book, so the switcher
  // still holds the one account this device made — that gap is carded
  // separately rather than papered over by E2 below.
  check(
    `E1 ${width}px: signing in with Farcaster leaves the sign-up screen and proves that account`,
    shellArrived &&
      current.url !== '/welcome/account' &&
      current.proofFid === SIGNED_IN_FID,
    `fid=${current.proofFid} at ${current.url}`,
  );

  await page.evaluate(() => {
    document.querySelector('[data-fiddy="account-switcher-entry"]')?.click();
  });

  const sheetArrived = await page
    .waitForSelector('[data-fiddy="account-switcher"]', { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(2_000);

  const sheet = await page.evaluate(() => ({
    text: (
      document.querySelector('[data-fiddy="account-switcher"]')?.textContent ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim(),
    rows: Array.from(document.querySelectorAll('[data-fiddy-account]')).map(
      (row) => ({
        id: row.getAttribute('data-fiddy-account'),
        text: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
        current: row.className.includes('current'),
      }),
    ),
  }));

  // MEASURED 2026-10-22: one row, and it is the account this device made. A
  // Sign-In-With-Farcaster session keeps its key in the Farcaster app rather than
  // here, and nothing in the client writes a book entry for it, so the switcher
  // does not list it. Named as the gap it is (carded) — the alternative was an
  // assertion that would have read as a promise the app does not keep.
  check(
    `E2 ${width}px: the switcher lists the accounts this device holds (the Farcaster session is not one of them yet)`,
    sheetArrived &&
      sheet.rows.length === 1 &&
      sheet.rows[0]?.id === HELD_WALLET.toLowerCase(),
    `${sheetArrived ? '' : 'the switcher never opened — '}${sheet.rows.map((row) => row.id).join(' | ')}`,
  );
  check(
    `E3 ${width}px: the social account joined it, named by its email, and says what it cannot do yet`,
    sheet.rows.some(
      (row) =>
        row.id === HELD_WALLET.toLowerCase() &&
        row.text.includes(PRIVY_EMAIL) &&
        /no posting key on this device yet/i.test(row.text),
    ),
    JSON.stringify(sheet.rows),
  );
  check(
    `E4 ${width}px: exactly one account is the current one`,
    sheet.rows.filter((row) => row.current).length === 1,
    sheet.text.slice(0, 200),
  );

  await page.screenshot({ path: `${OUT}/social-signup-${width}-switcher.png` });
  await context.close();
};

/** ── F. a third party that refuses ───────────────────────────────────────── */

const runRefusingProvider = async (browser) => {
  stage('F. a refusing provider, at 390px');
  relayApprovesSignIn = false;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

  // The SDK here is the third party at its worst: a module whose provider
  // throws. That is what a dashboard that does not know this app id looks like
  // from inside the client, and MEASURED on 2026-10-22 it used to replace the
  // whole screen with "We encountered an unexpected error. Try again" — no
  // doors, and no Farcaster sign-in either.
  await armRoutes(page, { server: SERVER, privy: 'refuse' });
  await openLoginModal(page, SERVER);
  await page.waitForTimeout(3_000);

  const after = await page.evaluate(() => ({
    privy: document.documentElement.getAttribute('data-fiddy-privy'),
    body: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim(),
    usableDoors: Array.from(
      document.querySelectorAll('[data-fiddy^="social-sign-up-"]'),
    ).filter((door) => !door.hasAttribute('disabled')).length,
    note: (
      document.querySelector('[data-fiddy="social-unavailable"]')
        ?.textContent ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim(),
    modal: Boolean(document.querySelector('[data-fiddy="login-social"]')),
  }));

  check(
    'F1 390px: a refusing SDK does not take the client with it',
    !/unexpected error/i.test(after.body),
    after.body.slice(0, 160),
  );
  check(
    'F2 390px: the Farcaster way in is still on screen',
    /open link on mobile|asking farcaster for a sign-in code|sign in with/i.test(
      after.body,
    ),
    after.body.slice(0, 160),
  );
  check(
    'F3 390px: the doors are either usable or say why they are not',
    after.usableDoors > 0 || after.note.length > 0,
    JSON.stringify(after.note),
  );
  check(
    'F4 390px: and the app says, in its own state and in plain words, that the third party refused',
    after.privy === 'failed' &&
      /still sign in with farcaster/i.test(after.note),
    `${after.privy} / ${after.note.slice(0, 120)}`,
  );

  await page.screenshot({
    path: `${OUT}/social-signup-390-provider-refused.png`,
  });
  await context.close();
};

/** ── G. the account claims a number of its own ───────────────────────────── */

/**
 * A Google sign-up claims its own Farcaster number, and the device ends with
 * ONE account carrying it.
 *
 * This is the stage the whole card is about, so it measures the whole shape of
 * it: what the account screen leads with, where the fee is asked for, who signs
 * the registration, what the node was told, and what this device holds
 * afterwards. It needs its own server because the node it reads from is a stub
 * (`VITE_SNAPCHAIN_HTTP_URL=https://probe-node.invalid`, answered below) — the
 * app's own code path is unchanged, only the third party at the other end is.
 */
const runClaimRoute = async (browser, width) => {
  stage(`G. the account claims its own Farcaster number, at ${width}px`);
  relayApprovesSignIn = false;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: width < 600 ? 844 : 900 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

  const chain = createChainStub();
  const node = createNodeStub();
  const registry = createNameRegistryStub();

  await armRoutes(page, { server: CLAIM_SERVER, privy: 'stub' });
  // Registered AFTER the catch-all, which is what makes them match FIRST: the
  // registrar, the read node and the name registry are this stage's thirds, and
  // not one byte of this stage reaches the real ones.
  await page.route(underOrigin(OPTIMISM_ENDPOINT), (route) =>
    chain.handle(route),
  );
  await page.route(underOrigin(STUB_NODE), (route) => node.handle(route));
  // The path the app actually uses for a cross-origin node: its own origin plus
  // `/snapchain-api` (`~/snapchain/nodeEnv` explains why — a browser cannot POST
  // to a node that answers no preflight). Intercepted here, so the node behind
  // it is still this stage's stub and the dev server is never asked.
  await page.route(nodeProxyOn(CLAIM_SERVER), (route) => node.handle(route));
  await page.route(underOrigin('https://fnames.farcaster.xyz'), (route) =>
    registry.handle(route),
  );

  await openLoginModal(page, CLAIM_SERVER, {
    beforePress: async () => {
      await waitForPrivyState(page, 'ready');
    },
  });

  const doorsUp = await page
    .waitForSelector('[data-fiddy="social-sign-up-google"]:not([disabled])', {
      timeout: 180_000,
    })
    .then(() => true)
    .catch(() => false);

  check(
    `G0 ${width}px: the Google door is usable on the claim server`,
    doorsUp,
    '',
  );

  await pressButton(page, 'Continue with Google');

  const landed = await page
    .waitForSelector('[data-fiddy="fiddy-account"][data-state="ready"]', {
      timeout: 180_000,
    })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(2_000);

  const screen = await page.evaluate(() => {
    const dash = (value) => (value ?? '').replace(/\s+/g, ' ').trim();

    return {
      url: window.location.pathname,
      // The sheet's own leading action, not the backup notice's button (which
      // is the first thing inside the same step, and is not what this is about).
      primary: dash(
        document.querySelector(
          '[data-fiddy-step="account"] .fiddy-sheet-actions .fiddy-primary-btn',
        )?.textContent,
      ),
      quiet: dash(
        document.querySelector(
          '[data-fiddy-step="account"] .fiddy-sheet-actions .fiddy-quiet-btn',
        )?.textContent,
      ),
      text: dash(document.body.innerText),
      hasNumber: document
        .querySelector('[data-fiddy="fiddy-account"]')
        ?.getAttribute('data-has-number'),
    };
  });

  check(
    `G1 ${width}px: the account screen leads with claiming a number FOR THIS ACCOUNT`,
    landed &&
      screen.url === '/welcome/account' &&
      /make this a farcaster account/i.test(screen.primary) &&
      /no farcaster account yet/i.test(screen.text),
    `primary="${screen.primary}" quiet="${screen.quiet}" hasNumber=${screen.hasNumber} at ${screen.url}`,
  );
  check(
    `G1b ${width}px: it is still the account the sign-up made, named by its email`,
    /probe@gmail\.com/.test(screen.text) && screen.hasNumber === 'false',
    screen.text.slice(0, 140),
  );

  await pressButton(page, 'Make this a Farcaster account');

  const nameStep = await page
    .waitForSelector('[data-fiddy-step="create-name"]', { timeout: 120_000 })
    .then(() => true)
    .catch(() => false);

  const wordsOnNameStep =
    (await page.$('[data-fiddy="recovery-phrase"]')) !== null;

  check(
    `G2 ${width}px: the claim starts at the name, with no words to write down`,
    nameStep && !wordsOnNameStep,
    `nameStep=${nameStep} words=${wordsOnNameStep}`,
  );

  await page.fill(
    '[data-fiddy-step="create-name"] input.fiddy-input',
    CLAIMED_NAME,
  );

  const nameFree = await page
    .waitForFunction(
      () =>
        /is free/i.test(
          document.querySelector('[data-fiddy="name-availability"]')
            ?.textContent ?? '',
        ),
      undefined,
      { timeout: 60_000 },
    )
    .then(() => true)
    .catch(() => false);

  await pressButton(page, 'Continue');

  const fundStep = await page
    .waitForSelector('[data-fiddy-step="create-fund"]', { timeout: 120_000 })
    .then(() => true)
    .catch(() => false);

  const asked = await page.evaluate(() => {
    const dash = (value) => (value ?? '').replace(/\s+/g, ' ').trim();

    return {
      address: dash(
        document.querySelector('[data-fiddy="custody-address"]')?.textContent,
      ),
      state: dash(
        document.querySelector('[data-fiddy="funding-state"]')?.textContent,
      ),
      note: dash(
        document.querySelector('[data-fiddy="held-account-note"]')?.textContent,
      ),
      words: Boolean(document.querySelector('[data-fiddy="recovery-phrase"]')),
      // Why the flow is where it is, when it is not where it should be.
      availability: dash(
        document.querySelector('[data-fiddy="name-availability"]')?.textContent,
      ),
      name: document.querySelector(
        '[data-fiddy-step="create-name"] input.fiddy-input',
      )?.value,
    };
  });

  check(
    `G3 ${width}px: the fee is asked for at the sign-up's own address`,
    fundStep &&
      nameFree &&
      asked.address.toLowerCase() === HELD_WALLET.toLowerCase() &&
      asked.words === false &&
      /nothing to write down/i.test(asked.note) &&
      registry.requests.length > 0,
    `${JSON.stringify(asked)} registry=${registry.requests.join('|')} fundStep=${fundStep} nameFree=${nameFree}`,
  );

  await page.screenshot({
    path: `${OUT}/social-signup-${width}-claim-fund.png`,
  });

  // The person's transfer arrives. The screen has been read before it does, so
  // what was measured above is the screen a person sends money from.
  chain.fund();

  const finished = await page
    .waitForSelector('[data-fiddy-step="create-done"]', { timeout: 150_000 })
    .then(() => true)
    .catch(() => false);

  const signCalls = await page.evaluate(
    () => globalThis.__privySignCalls ?? [],
  );

  // What the sheet itself thinks is happening, so a stage that does not finish
  // says which step it stopped on and in whose words.
  const sheetState = await page.evaluate(() => {
    const dash = (value) => (value ?? '').replace(/\s+/g, ' ').trim();

    return {
      step: dash(
        document
          .querySelector('[data-fiddy="create-account"] [data-fiddy-step]')
          ?.getAttribute('data-fiddy-step'),
      ),
      error: dash(
        document.querySelector('[data-fiddy="create-account"] .fiddy-error')
          ?.textContent,
      ),
      progress: dash(
        document.querySelector('[data-fiddy="create-progress"]')?.textContent,
      ),
    };
  });

  check(
    `G4 ${width}px: the registration was signed by the sign-up's own window`,
    finished && signCalls.includes('eth_signTransaction'),
    `finished=${finished} calls=${signCalls.join(' | ')} sheet=${JSON.stringify(sheetState)} node=${JSON.stringify(node.state.reads.slice(0, 10))} chainSent=${chain.sent.length} pageErrors=${JSON.stringify(pageErrors.slice(-2))}`,
  );
  check(
    `G5 ${width}px: and broadcast by the app itself, one transaction to the registrar`,
    chain.sent.length === 1 && chain.isRegistered(),
    `sent=${chain.sent.length} registered=${chain.isRegistered()}`,
  );
  check(
    `G6 ${width}px: the posting key for this device was authorised by that same window`,
    signCalls.includes('eth_signTypedData_v4') && Boolean(node.state.key),
    `calls=${signCalls.join(' | ')} key=${node.state.key ? 'yes' : 'no'}`,
  );

  const book = await readAccountBook(page);

  check(
    `G7 ${width}px: ONE account on this device, and it holds the FID`,
    book.accounts.length === 1 &&
      book.currentId === HELD_WALLET.toLowerCase() &&
      book.accounts[0]?.fid === MINTED_FID &&
      book.accounts[0]?.custody === 'privy' &&
      book.accounts[0]?.phrase === null,
    JSON.stringify(book),
  );
  check(
    `G7b ${width}px: the same account by every name it had before, plus its number`,
    book.accounts[0]?.id === HELD_WALLET.toLowerCase() &&
      book.accounts[0]?.provider === 'google' &&
      book.accounts[0]?.email === PRIVY_EMAIL &&
      book.accounts[0]?.label === `@${CLAIMED_NAME}`,
    JSON.stringify(book.accounts[0]),
  );

  await pressButton(page, 'Open Fiddy');

  const shellArrived = await page
    .waitForSelector('[data-fiddy="account-switcher-entry"]', {
      state: 'attached',
      timeout: 180_000,
    })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(2_500);

  const afterClaim = await page.evaluate(() => ({
    url: window.location.pathname,
    entry: (
      document.querySelector('[data-fiddy="account-switcher-entry"]')
        ?.textContent ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim(),
  }));

  check(
    `G8 ${width}px: the app is signed in as the account that owns the number`,
    shellArrived &&
      afterClaim.url !== '/welcome/account' &&
      new RegExp(`@${CLAIMED_NAME}`).test(afterClaim.entry),
    `entry="${afterClaim.entry}" at ${afterClaim.url}`,
  );

  await page.evaluate(() => {
    document.querySelector('[data-fiddy="account-switcher-entry"]')?.click();
  });

  const sheetArrived = await page
    .waitForSelector('[data-fiddy="account-switcher"]', { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(2_000);

  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-fiddy-account]')).map(
      (row) => ({
        id: row.getAttribute('data-fiddy-account'),
        text: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
      }),
    ),
  );

  check(
    `G9 ${width}px: the switcher lists that one account, and says it can post`,
    sheetArrived &&
      rows.length === 1 &&
      rows[0]?.id === HELD_WALLET.toLowerCase() &&
      /this device can post/i.test(rows[0]?.text ?? ''),
    JSON.stringify(rows),
  );

  await page.screenshot({
    path: `${OUT}/social-signup-${width}-claim-switcher.png`,
  });
  await context.close();
};

// The system Chrome, as every other probe in this repo does it: the pinned
// headless shell is not always on the machine, and this probe is about the app,
// not about which browser build runs it.
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox'],
});

try {
  if (wanted('A')) {
    await runWithoutAppId(browser, 390);
    await runWithoutAppId(browser, 1440);
  }

  if (wanted('B')) {
    await runWithAppId(browser, 390);
    await runWithAppId(browser, 1440);
  }

  if (wanted('G')) {
    await runClaimRoute(browser, 390);
    await runClaimRoute(browser, 1440);
  }

  if (wanted('F')) {
    await runRefusingProvider(browser);
  }

  check('the Farcaster relay was stubbed, not the app', true, '');

  check(
    'no write left the machine during the whole run',
    writes.length === 0,
    writes.slice(0, 3).join(' | '),
  );
  check(
    'the app threw nothing, in any run',
    pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '),
  );
} catch (error) {
  check('the run completed', false, String(error).slice(0, 300));
} finally {
  await browser.close();
}

const failed = checks.filter((entry) => !entry.ok);

console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${OUT}`,
);

if (failed.length > 0) {
  console.log('FAILED:');
  for (const entry of failed) {
    console.log(`  - ${entry.name} ${entry.detail}`);
  }
  process.exit(1);
}

process.exit(0);
