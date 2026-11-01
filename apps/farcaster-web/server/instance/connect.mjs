/**
 * The connect service a copy of Fiddy answers for itself.
 *
 * WHY THIS EXISTS
 *
 * "Connect your Farcaster account" is one tap with no fee and no passphrase:
 * the browser asks for a *posting key* the protocol has been asked to grant, the
 * person approves it in their own Farcaster app, and from then on the client
 * writes as them. On fiddy.fun that request is made by Fiddy's control plane,
 * which holds a paid key and a sponsored app account. **A copy of Fiddy a person
 * runs themselves has neither**, so `/api/fiddy/connect` answered 404 there and
 * the one-tap approval simply did not exist at that address — a tester who
 * pressed Cast was walked to Advanced, and the only key path left there wanted
 * their recovery phrase.
 *
 * This is the other half of that: the same four endpoints, answered by the
 * instance's own server, with the same wire shape the browser already speaks
 * (`~/snapchain/accounts/managedConnect`) — so the screens, the polling and the
 * identity rules are the ones that already shipped, not a second implementation
 * of the same product.
 *
 * WHAT IT DOES, IN THE ORDER THE PROTOCOL CHECKS IT
 *
 *   1. `begin` — mint an Ed25519 key for this caller, sign Farcaster's
 *      `SignedKeyRequest` for it with the *instance's own* Farcaster account,
 *      and hand that to Farcaster's client API. The answer is a link
 *      (`https://client.farcaster.xyz/deeplinks/…`) the browser draws as a QR.
 *   2. the person scans it with their phone and approves in the Farcaster app.
 *      The app makes the on-chain addition; their custody key is never asked
 *      for, and no recovery phrase is involved anywhere.
 *   3. `read` — asks Farcaster's API whether the request completed, and then asks
 *      **this instance's own node** whether the key is on the FID. Two
 *      independent answers, and an identity is adopted only when they agree
 *      about which account it is.
 *   4. `read` (again) hands the person's browser the *private* half of that key,
 *      once, so the client signs its own writes with it through the node it is
 *      already pointed at — the same device-key path the Advanced screen uses.
 *      This instance keeps nothing that can post as anybody; see the note at
 *      `postingKey` below for why the key crosses to the browser rather than
 *      staying here.
 *
 * WHAT IT WILL NOT DO
 *
 * - It never answers `connected` from a request it did not create, and never for
 *   an account other than the one the request was bound to.
 * - It never stores a recovery phrase or a custody key. The one it is configured
 *   with is the instance's own app account, read from the environment.
 * - It never pretends it can approve anything when it cannot: if neither the
 *   instance itself nor the project's signer can ask, it says so in a sentence
 *   naming exactly what to set.
 *
 * The wire shape is the hosted service's, including the parts that are about
 * identity rather than keys: `attempt` (this tab's own label, echoed back so a
 * device nobody is signed in on may only adopt a connection it started),
 * `forFid` + `proof` (who the browser says this is for, with the SIWF proof of
 * that sign-in), and `refused`/`wrong_account` when the approval turns out to be
 * somebody else's.
 *
 * CONFIGURATION (the instance's own Farcaster account — not the person's):
 *
 *   FIDDY_INSTANCE_APP_FID   the FID that asks; it is the name the approval
 *                            screen shows ("… requests to add a key")
 *   FIDDY_INSTANCE_APP_KEY   that FID's custody key, as a 0x private key or a
 *                            twelve-word phrase, kept on this machine
 *   FIDDY_SIGNER_REQUEST_URL what to ask when this instance has NO Farcaster
 *                            account of its own: a service that lends one for a
 *                            key somebody else minted (default fiddy.fun's
 *                            `/api/fiddy/signer-request`; set it to an empty
 *                            string to refuse to ask anybody). Asking is what
 *                            puts a name on the approval screen, and only the
 *                            person's own phone can complete it.
 *   FIDDY_FC_CLIENT_API      override for Farcaster's client API (default
 *                            https://api.farcaster.xyz; a probe points it at a
 *                            local stub)
 *   SNAPCHAIN_HTTP_URL       the node reads and writes go through
 */

import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The deadline Farcaster recommends: a day is plenty of time to scan a code. */
const REQUEST_DEADLINE_SECONDS = 24 * 60 * 60;

/**
 * EIP-712 domain and type of the request signature.
 *
 * Copied from Farcaster's own reference implementation
 * (docs.farcaster.xyz/reference/contracts/reference/signed-key-request-validator):
 * a fixed protocol constant, and the address is the validator on Optimism. The
 * signature only *names* the requesting FID — nothing here touches that chain;
 * Farcaster's API checks the signature against the custody address of that FID.
 */
const SIGNED_KEY_REQUEST_DOMAIN = {
  name: 'Farcaster SignedKeyRequestValidator',
  version: '1',
  chainId: 10,
  verifyingContract: '0x00000000fc700472606ed4fa22623acf62c60553',
};

const SIGNED_KEY_REQUEST_TYPE = [
  { name: 'requestFid', type: 'uint256' },
  { name: 'key', type: 'bytes' },
  { name: 'deadline', type: 'uint256' },
];

/**
 * The link a phone camera can resolve, for a request whose API answer carries the
 * `farcaster://` form. Measured 2026-10-21 on the hosted flow: the same request
 * object comes back from production as this https URL. The raw deeplink is kept
 * in the record too, so a native client can use it as it is.
 */
const DEEPLINK_HOST =
  'https://client.farcaster.xyz/deeplinks/signed-key-request';

/** How long a node read may take before the instance stops waiting on it. */
const NODE_TIMEOUT_MS = 8_000;

/** Farcaster's own field number for an account's @handle. */
const USER_DATA_TYPE_USERNAME = 6;

/**
 * The eight-byte PKCS#8 header that precedes a raw Ed25519 seed, and the twelve
 * bytes that precede the raw public key in an SPKI document. Both are fixed
 * structures (RFC 8410), and going through them is what lets a key be minted
 * with `node:crypto` alone: the service keeps no crypto dependency of its own,
 * and the 32-byte seed it hands over is exactly the shape the browser's
 * `appKeyFromPrivateKeyHex` reads.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A fresh Ed25519 posting key: the 32-byte seed, and the public key it makes. */
export const generatePostingKey = () => {
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });

  if (publicKey.length !== SPKI_ED25519_PREFIX.length + 32) {
    throw new Error('this Node builds Ed25519 keys in a shape this cannot read');
  }

  return {
    privateKeyHex: `0x${seed.toString('hex')}`,
    publicKeyHex: `0x${publicKey.subarray(SPKI_ED25519_PREFIX.length).toString('hex')}`,
  };
};

const INSTANCE_NOT_SET_UP =
  'This copy of Fiddy has no Farcaster account of its own to ask with, and it has been told not to ask anybody else (FIDDY_SIGNER_REQUEST_URL is empty). Set FIDDY_INSTANCE_APP_FID and FIDDY_INSTANCE_APP_KEY, or leave FIDDY_SIGNER_REQUEST_URL alone so the project signs the request instead - or add a key from Advanced, your setup.';

// WHY NOTHING FROM THE WORKSPACE IS IMPORTED HERE, AND WHY THAT IS NOT A
// LIMITATION: this module runs inside the server that serves the client —
// `vite dev`, or `vite preview` after `fiddy client up --build` — i.e. under
// plain Node. The workspace's own packages (`farcaster-node-client`, and the
// `@farcaster/core` protobufs behind it) build to ESM with extensionless
// relative imports, which Node's resolver refuses (measured: `Cannot find module
// …/dist/appKey`), and `vite preview` has no module runner to borrow. So the
// service speaks the two plain-JSON node reads it needs with `fetch`, mints the
// key with `node:crypto`, and hands the key to the browser — where the app's
// own, tested write path (protobufs included) already lives. Everything the
// service does about *identity* is still done here, with viem.
//
// Loaded when used, not on import: `vite.config.js` pulls this file in while it
// reads the app's config, and a signing library does not belong at that moment.
let viemAccounts;
const accounts = async () => (viemAccounts ??= await import('viem/accounts'));

let viemSiwe;
const siwe = async () => (viemSiwe ??= await import('viem/siwe'));

let viemCore;
const viem = async () => (viemCore ??= await import('viem'));

/**
 * The instance's own Farcaster account, read off the environment.
 *
 * `configured` is what lets the service answer a person who presses Connect on
 * an instance that has not chosen an app account yet: an honest sentence, in
 * place, instead of a dead button. It is not an error — that self-hoster can
 * still add a key from Advanced.
 */
export const readInstanceConfig = (env = {}) => {
  const appFid = Number(env.FIDDY_INSTANCE_APP_FID ?? '');
  const appKeyRaw = (env.FIDDY_INSTANCE_APP_KEY ?? '').trim();
  return {
    appFid: Number.isInteger(appFid) && appFid > 0 ? appFid : null,
    appKeyRaw: appKeyRaw.length > 0 ? appKeyRaw : null,
    clientApi: (env.FIDDY_FC_CLIENT_API ?? 'https://api.farcaster.xyz').replace(
      /\/+$/,
      '',
    ),
    // Who to ask when this instance has no account of its own. An empty string is
    // a deliberate "ask nobody", not an unset one.
    remoteSigner:
      env.FIDDY_SIGNER_REQUEST_URL === undefined
        ? 'https://fiddy.fun/api/fiddy/signer-request'
        : (env.FIDDY_SIGNER_REQUEST_URL ?? '').trim().replace(/\/+$/, '') ||
          null,
    nodeUrl: env.SNAPCHAIN_HTTP_URL ?? env.VITE_SNAPCHAIN_HTTP_URL ?? null,
  };
};

/**
 * A custody key, however it was written down: a 0x private key, or the twelve
 * words every Farcaster client derives that key from. Both produce an account
 * that can sign; nothing else about the account is used here.
 */
const custodyAccountFrom = async (raw) => {
  const { mnemonicToAccount, privateKeyToAccount } = await accounts();
  const trimmed = raw.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    return privateKeyToAccount(
      trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`,
    );
  }
  return mnemonicToAccount(trimmed.replace(/\s+/g, ' '));
};

const asApprovalUrl = (request) => {
  const deeplink =
    typeof request?.deeplinkUrl === 'string' ? request.deeplinkUrl : '';
  if (deeplink.startsWith('http')) {
    return deeplink;
  }
  const token = typeof request?.token === 'string' ? request.token : '';
  return token.length > 0
    ? `${DEEPLINK_HOST}?token=${encodeURIComponent(token)}`
    : null;
};

/**
 * A record per caller handle, kept in a file.
 *
 * WHY A FILE, AND WHY 0600: the key it holds can cast as somebody. The hosted
 * service keeps the equivalent in a database; a self-hosted instance has a
 * filesystem and one person, and losing the record means asking that person to
 * approve again on their phone — so it is worth surviving a dev-server restart
 * (vite restarts itself when its config changes), and worth keeping out of every
 * other read on the box.
 */
export const createFileStore = (path) => {
  const load = () => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  const save = (records) => {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(records, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  };
  return {
    path,
    get: (handle) => (handle ? load()[handle] : undefined),
    set: (handle, record) => {
      const records = load();
      records[handle] = record;
      save(records);
    },
    delete: (handle) => {
      const records = load();
      if (handle && handle in records) {
        delete records[handle];
        save(records);
      }
    },
    all: () => Object.values(load()),
  };
};

export const createMemoryStore = () => {
  const records = new Map();
  return {
    get: (handle) => (handle ? records.get(handle) : undefined),
    set: (handle, record) => void records.set(handle, record),
    delete: (handle) => void records.delete(handle),
    all: () => [...records.values()],
  };
};

/**
 * Who is asking, checked rather than believed.
 *
 * The browser hands over the FID it is signed in as, together with the SIWF
 * message and signature of that sign-in. Four checks, all local: the message
 * parses; it was signed for THIS host (so a signature harvested from another
 * app's sign-in cannot be replayed here); the signature recovers to the address
 * the message names; and the message names the FID it is claimed for.
 *
 * The nonce is deliberately not checked: it belongs to a sign-in session this
 * instance never saw, and it protects nothing the host, signature and FID checks
 * do not — what matters here is that the claim is *provable*, not that it is
 * fresh.
 */
export const verifyBindingProof = async ({ proof, forFid, host }) => {
  const { parseSiweMessage } = await siwe();
  const { recoverMessageAddress, isAddressEqual } = await viem();

  let parsed;
  try {
    parsed = parseSiweMessage(proof?.message ?? '');
  } catch {
    return { ok: false, reason: 'the sign-in proof did not parse' };
  }

  if (typeof parsed.domain !== 'string' || parsed.domain !== host) {
    return {
      ok: false,
      reason: `the proof was signed for ${parsed.domain ?? 'no host'}, not ${host}`,
    };
  }

  const claimed = (parsed.resources ?? [])
    .map((resource) => /^farcaster:\/\/fid\/(\d+)$/.exec(resource)?.[1])
    .find(Boolean);

  if (!claimed || Number(claimed) !== Number(forFid)) {
    return { ok: false, reason: 'the proof does not name the account it is for' };
  }

  let recovered;
  try {
    recovered = await recoverMessageAddress({
      message: proof.message,
      signature: proof.signature,
    });
  } catch {
    return { ok: false, reason: 'the sign-in signature could not be recovered' };
  }

  if (!parsed.address || !isAddressEqual(recovered, parsed.address)) {
    return {
      ok: false,
      reason: 'the signature does not match the address it claims',
    };
  }

  return { ok: true, address: recovered };
};

/**
 * What the browser reads, including the posting key it is being handed.
 *
 * WHY THE KEY CROSSES TO THE BROWSER instead of staying here: in this design the
 * client signs its own writes through the node it is already pointed at, which
 * is one code path (the one Advanced uses, already tested) rather than a second
 * implementation of the protocol inside a dev server, and it keeps working when
 * the service is restarted. The exposure is bounded: the key can cast, react and
 * follow for one FID, it is delivered only to a caller holding the HttpOnly
 * handle cookie, and the person can turn the connection off here or in the app
 * that granted it.
 *
 * It is delivered on every `read` while connected, not once: a reload that
 * races the browser's own storage would otherwise lock the person out of the key
 * they approved, with no way back except deleting the record by hand.
 */
const statusBody = (record) => ({
  state: record.state,
  approvalUrl: record.state === 'waiting' ? (record.approvalUrl ?? null) : null,
  postingKey:
    record.state === 'connected' ? (record.key?.privateKeyHex ?? null) : null,
  fid:
    record.state === 'connected'
      ? (record.fid ?? null)
      : (record.echoFid ?? null),
  username: record.username ?? null,
  forFid: record.forFid ?? null,
  refused: record.refused ?? null,
  attempt: record.attempt ?? null,
});

/**
 * What every method of the service answers: an HTTP status, the body the
 * browser reads, and — for the one call that can start a request — the handle
 * the plugin puts in the caller's cookie.
 *
 * @typedef {{ status: number, body: Record<string, unknown>, handle?: string }} ServiceAnswer
 */

/**
 * The service. Every method answers `{ status, body, handle? }` and nothing
 * throws for an ordinary refusal, so a screen always gets a sentence to show.
 *
 * `store` and `fetchImpl` are injected so the whole thing can be exercised with
 * real signatures and a stubbed network
 * (`src/__tests__/instanceConnect.test.ts`).
 *
 * `fetchImpl` is the network for Farcaster's API and `nodeFetchImpl` the one for
 * this instance's own node: they are separate services, and a test that stubs
 * one must not accidentally answer for the other.
 *
 * @param {{
 *   config: ReturnType<typeof readInstanceConfig>,
 *   store: ReturnType<typeof createFileStore> | ReturnType<typeof createMemoryStore>,
 *   fetchImpl?: typeof fetch,
 *   nodeFetchImpl?: typeof fetch,
 *   now?: () => number,
 *   log?: (message: string) => void,
 * }} options
 */
export const createInstanceConnectService = ({
  config,
  store,
  fetchImpl = fetch,
  nodeFetchImpl = fetch,
  now = () => Date.now(),
  log = () => {},
}) => {
  const configured = Boolean(config.appFid && config.appKeyRaw);
  // Never undefined: a caller that never set this is asking nobody, which is the
  // behaviour this service had before it could borrow a signature at all.
  const remoteSigner = config.remoteSigner ?? null;
  let custodyPromise;

  const custody = () => {
    custodyPromise ??= custodyAccountFrom(config.appKeyRaw);
    return custodyPromise;
  };

  /** One call to Farcaster's client API. A refusal is an answer, not an exception. */
  const clientApi = async (path, init) => {
    const response = await fetchImpl(`${config.clientApi}${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  };

  /** One read of this instance's own node, as the node itself answers it. */
  const nodeGet = async (path) => {
    if (!config.nodeUrl) {
      return null;
    }
    const response = await nodeFetchImpl(`${config.nodeUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
    });
    return response.ok ? await response.json() : null;
  };

  /**
   * Does the instance's own node hold this key on this FID?
   *
   * `null` when there is no node to ask or it cannot be reached — an honest
   * "nobody confirmed this here", never a yes.
   */
  const keyOnNode = async (fid, publicKeyHex) => {
    try {
      const page = await nodeGet(`/v1/signersByFid?fid=${fid}&pageSize=200`);
      if (page === null) {
        return null;
      }
      const wanted = publicKeyHex.toLowerCase();
      const signers = Array.isArray(page.signers) ? page.signers : [];
      return signers.some(
        (signer) =>
          typeof signer?.key === 'string' &&
          signer.key.toLowerCase() === wanted,
      );
    } catch (error) {
      log(`the node could not confirm the key: ${error?.message ?? error}`);
      return null;
    }
  };

  /** The @handle for an account, read from the instance's own node. Best effort. */
  const usernameOf = async (fid) => {
    try {
      const page = await nodeGet(`/v1/userDataByFid?fid=${fid}&pageSize=100`);
      const messages = Array.isArray(page?.messages) ? page.messages : [];
      for (const message of messages) {
        const body = message?.data?.userDataBody;
        const type =
          typeof body?.type === 'number'
            ? body.type
            : Number(String(body?.type ?? '').replace(/\D+/g, ''));
        if (type === USER_DATA_TYPE_USERNAME) {
          return typeof body?.value === 'string' && body.value.length > 0
            ? body.value
            : null;
        }
      }
      return null;
    } catch {
      return null;
    }
  };

  /**
   * Ask Farcaster whether the request completed, and if it did, decide what it
   * means HERE. Returns the record unchanged while there is nothing new to say.
   */
  const refresh = async (record) => {
    const answer = await clientApi(
      `/v2/signed-key-request?token=${encodeURIComponent(record.request.token)}`,
    );
    if (!answer.ok) {
      // Farcaster's API is the only thing that knows whether the on-chain
      // addition happened; without it this stays exactly as it was.
      log(`signed key request status failed: HTTP ${answer.status}`);
      return record;
    }

    const request = answer.payload?.result?.signedKeyRequest;
    if (request?.state !== 'completed') {
      return record;
    }

    const approvedFid = Number(request.userFid);
    if (!Number.isInteger(approvedFid) || approvedFid <= 0) {
      return record;
    }

    // The identity rules, in the order that matters. The first is the one the
    // whole feature exists for: an approval is never adopted for somebody else.
    if (Number(record.forFid ?? 0) > 0 && approvedFid !== Number(record.forFid)) {
      return {
        ...record,
        state: 'wrong_account',
        refused: 'other_account',
        echoFid: approvedFid,
        username: await usernameOf(approvedFid),
        completedAt: now(),
      };
    }

    const askingFid = Number(record.request?.requestFid ?? config.appFid ?? 0);
    if (askingFid > 0 && approvedFid === askingFid) {
      // The account that ASKED approved its own request (whether that was this
      // instance or a service lending one): that is a key for the wrong person,
      // and it is refused exactly as the hosted service does.
      return {
        ...record,
        state: 'wrong_account',
        refused: 'app_account',
        echoFid: approvedFid,
        username: null,
        completedAt: now(),
      };
    }

    const onNode = await keyOnNode(approvedFid, record.key.publicKeyHex);
    if (onNode === false) {
      // Farcaster says the on-chain addition is confirmed and this node has not
      // indexed it yet. Nothing is claimed: the browser's next poll asks again,
      // and this is the same read the posting-key screen makes.
      log(
        `FID ${approvedFid} completed the request; this node does not list the key yet`,
      );
      return record;
    }

    return {
      ...record,
      state: 'connected',
      fid: approvedFid,
      username: await usernameOf(approvedFid),
      confirmedByNode: onNode === true,
      completedAt: now(),
    };
  };

  /**
   * The signature, from the project's own service, for a key this instance minted.
   *
   * This instance has no Farcaster account of its own, and the protocol needs
   * *somebody* to sign the request — so it asks the service that publishes one
   * (`fiddy.fun/api/fiddy/signer-request`, overridable). What comes back names
   * that account as the asker; the approval still happens on the person's own
   * phone, and the key stays here. A refusal is reported as one, with the two
   * ways forward named rather than a dead button.
   */
  const askTheProject = async (publicKeyHex) => {
    let response;
    try {
      response = await fetchImpl(remoteSigner, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ key: publicKeyHex }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      log(`could not reach the signer service: ${error?.message ?? error}`);
      return {
        error: {
          status: 502,
          body: {
            code: 'CONNECT_UNREACHABLE',
            message: `This copy of Fiddy could not reach the service that would ask for a posting key on its behalf (${remoteSigner}). Set FIDDY_INSTANCE_APP_FID and FIDDY_INSTANCE_APP_KEY to ask with an account of its own, or try again.`,
          },
        },
      };
    }

    const payload = await response.json().catch(() => null);
    const requestFid = Number(payload?.requestFid);
    const { signature, deadline } = payload ?? {};

    if (
      !response.ok ||
      !Number.isInteger(requestFid) ||
      requestFid <= 0 ||
      typeof signature !== 'string' ||
      !Number.isFinite(Number(deadline))
    ) {
      return {
        error: {
          status: 502,
          body: {
            code: 'CONNECT_SIGNER_REFUSED',
            message:
              typeof payload?.message === 'string'
                ? `The service that would ask on this copy of Fiddy's behalf refused: ${payload.message}`
                : `The service that would ask on this copy of Fiddy's behalf answered ${response.status}. Set FIDDY_INSTANCE_APP_FID and FIDDY_INSTANCE_APP_KEY to ask with an account of its own, or add a key from Advanced, your setup.`,
          },
        },
      };
    }

    return {
      requestFid,
      signature,
      deadline: Number(deadline),
      via: `the project's signer (${remoteSigner})`,
    };
  };

  /**
   * Start — or re-hand — one request.
   *
   * @param {{ handle?: string | undefined, attempt?: unknown, forFid?: unknown, proof?: unknown, host?: unknown }} asked
   * @returns {Promise<ServiceAnswer>}
   */
  const begin = async ({ handle, attempt, forFid, proof, host }) => {
    if (!configured && remoteSigner === null) {
      return {
        status: 501,
        body: { code: 'CONNECT_UNAVAILABLE', message: INSTANCE_NOT_SET_UP },
      };
    }

    const existing = store.get(handle);
    if (existing && existing.state !== 'wrong_account') {
      // A second press while a link is waiting is answered with *that same
      // link*, never a second request — the person's phone is not a race.
      const refreshed = await refresh(existing);
      if (refreshed !== existing) {
        store.set(existing.handle, refreshed);
      }
      return { status: 200, body: { ...statusBody(refreshed), reused: true } };
    }

    let boundAddress = null;
    if (proof && Number(forFid) > 0) {
      const checked = await verifyBindingProof({
        proof,
        forFid: Number(forFid),
        host,
      });
      if (!checked.ok) {
        return {
          status: 200,
          body: {
            state: 'wrong_account',
            approvalUrl: null,
            fid: null,
            username: null,
            forFid: Number(forFid),
            refused: 'other_account',
            attempt: typeof attempt === 'string' ? attempt : null,
            reason: checked.reason,
          },
        };
      }
      boundAddress = checked.address;
    }

    // WHO ASKS. The instance's own account first, because that is the instance
    // speaking for itself; failing that, a service that lends one, because a
    // self-hoster usually has no spare Farcaster account and the protocol needs
    // *somebody* to sign the request. Either way the key was minted here and the
    // approval happens on the person's phone.
    const key = generatePostingKey();
    const publicKeyHex = key.publicKeyHex;

    let asking;
    if (configured) {
      const deadline = Math.floor(now() / 1000) + REQUEST_DEADLINE_SECONDS;
      try {
        const account = await custody();
        const signature = await account.signTypedData({
          domain: SIGNED_KEY_REQUEST_DOMAIN,
          types: { SignedKeyRequest: SIGNED_KEY_REQUEST_TYPE },
          primaryType: 'SignedKeyRequest',
          message: {
            requestFid: BigInt(config.appFid),
            key: publicKeyHex,
            deadline: BigInt(deadline),
          },
        });
        asking = { requestFid: config.appFid, signature, deadline, via: 'this instance' };
      } catch (error) {
        return {
          status: 500,
          body: {
            code: 'CONNECT_APP_ACCOUNT_UNREADABLE',
            message: `This copy of Fiddy could not read the key of the Farcaster account it asks with (${error?.message ?? error}).`,
          },
        };
      }
    } else {
      const borrowed = await askTheProject(publicKeyHex);
      if (borrowed.error) {
        return borrowed.error;
      }
      asking = borrowed;
    }

    let answer;
    try {
      answer = await clientApi('/v2/signed-key-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: publicKeyHex,
          requestFid: asking.requestFid,
          signature: asking.signature,
          deadline: asking.deadline,
        }),
      });
    } catch {
      return {
        status: 502,
        body: {
          code: 'CONNECT_UNREACHABLE',
          message:
            "Farcaster's sign-in service could not be reached from this copy of Fiddy.",
        },
      };
    }

    const request = answer.payload?.result?.signedKeyRequest;
    const approvalUrl = answer.ok ? asApprovalUrl(request) : null;

    if (approvalUrl === null || typeof request?.token !== 'string') {
      return {
        status: 502,
        body: {
          code: 'CONNECT_REQUEST_REFUSED',
          message:
            typeof answer.payload?.message === 'string'
              ? `Farcaster refused this copy of Fiddy's request: ${answer.payload.message}`
              : `Farcaster refused this copy of Fiddy's request (HTTP ${answer.status}). Check FIDDY_INSTANCE_APP_FID and FIDDY_INSTANCE_APP_KEY.`,
        },
      };
    }

    const newHandle = handle ?? randomBytes(16).toString('hex');
    const record = {
      handle: newHandle,
      createdAt: now(),
      attempt: typeof attempt === 'string' ? attempt : null,
      forFid: Number(forFid) > 0 ? Number(forFid) : null,
      boundAddress,
      key: { privateKeyHex: key.privateKeyHex, publicKeyHex },
      request: {
        token: request.token,
        // The deadline and the account that asked come from whoever signed, so
        // this records what Farcaster was actually told rather than what this
        // instance assumed.
        deadline: asking.deadline,
        requestFid: asking.requestFid,
        via: asking.via,
        deeplinkUrl:
          typeof request.deeplinkUrl === 'string' ? request.deeplinkUrl : null,
      },
      approvalUrl,
      state: 'waiting',
    };
    store.set(newHandle, record);
    log(
      `asked Farcaster for a posting key, with FID ${asking.requestFid} as the asker (${asking.via})`,
    );
    return {
      status: 200,
      handle: newHandle,
      body: { ...statusBody(record), reused: false },
    };
  };

  /**
   * What is true right now, asked of Farcaster and of the instance's own node.
   *
   * @param {{ handle?: string | undefined }} asked
   * @returns {Promise<ServiceAnswer>}
   */
  const read = async ({ handle }) => {
    const record = store.get(handle);
    if (!record) {
      return {
        status: 200,
        body: {
          state: 'none',
          approvalUrl: null,
          fid: null,
          username: null,
          forFid: null,
          refused: null,
          attempt: null,
          postingKey: null,
        },
      };
    }
    if (record.state === 'waiting') {
      const refreshed = await refresh(record);
      if (refreshed !== record) {
        store.set(record.handle, refreshed);
      }
      return { status: 200, body: statusBody(refreshed) };
    }
    return { status: 200, body: statusBody(record) };
  };

  /**
   * Turn it off here. The posting key this instance held is deleted, so it can
   * post as nobody; the authorization on the account itself is the person's own
   * to remove in the app that granted it, which is what the screen says.
   */
  /**
   * @param {{ handle?: string | undefined }} asked
   * @returns {Promise<ServiceAnswer>}
   */
  const remove = async ({ handle }) => {
    store.delete(handle);
    return {
      status: 200,
      body: {
        state: 'revoked',
        approvalUrl: null,
        fid: null,
        username: null,
        forFid: null,
        refused: null,
        attempt: null,
        postingKey: null,
      },
    };
  };

  return { begin, read, remove, configured };
};
