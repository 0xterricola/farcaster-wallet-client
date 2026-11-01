/**
 * App keys: the client's own Ed25519 key, authorized by the user's custody
 * address with a *gasless* `KEY_ADD` — an EIP-712 signature, no Optimism
 * transaction, no ETH, nothing on-chain.
 *
 * The flow, in the order the node checks it:
 *
 *   1. read the FID's `currentUserNonce` from `GET /v1/signersByFid` — the
 *      authorization's nonce must be strictly greater;
 *   2. `makeKeyAddBody` signs the `KeyAdd` EIP-712 payload with the custody
 *      address (key, scopes, TTL, nonce, deadline) and attaches the gasless
 *      `SignedKeyRequestMetadata` from `getGaslessSignedKeyRequestMetadata`;
 *   3. the KEY_ADD message envelope itself is signed by the *new* app key;
 *   4. `POST /v1/submitMessage` sends it to your own node, which gossips it to
 *      validators;
 *   5. the key shows up in `GET /v1/signersByFid` once it merges — that is the
 *      confirmation, since a read node has no mempool to report on.
 *
 * The custody key is used for exactly this one signature (and for an optional
 * custody-signed revoke). It never leaves the browser.
 */

import {
  ADMISSIBLE_KEY_ADD_SCOPES,
  FarcasterNetwork,
  makeKeyAdd,
  makeKeyAddBody,
  makeKeyRemove,
  makeKeyRemoveBody,
  makeKeyRemoveBodySelfRevoke,
  MAX_GASLESS_KEYS_PER_FID,
  MAX_KEY_TTL_SECONDS,
  type MessageType,
  NobleEd25519Signer,
  ViemLocalEip712Signer,
} from '@farcaster/core';

import { MessageBuildError } from './errors';
import type { SnapchainNodeClient } from './http';
import {
  DEFAULT_APP_KEY_SCOPES,
  type SignerAccount,
  unwrap,
  unwrapAsync,
} from './messages';
import type { BuiltMessage, NodeMessage, NodeSigner } from './types';
import {
  bytesToHex,
  encodeMessage,
  getFarcasterSeconds,
  hexToBytes,
} from './wire';

/** How long the custody authorization stays valid after it is built. */
export const DEFAULT_KEY_ADD_DEADLINE_SECONDS = 600;

export interface AppKey {
  /** 32-byte Ed25519 secret. Stays in the browser's own storage. */
  privateKey: Uint8Array;
  /** 32-byte Ed25519 public key — this is what goes in the KEY_ADD message. */
  publicKey: Uint8Array;
  /** 0x-hex public key, the identifier the node reports back. */
  publicKeyHex: string;
}

export const appKeyFromPrivateKey = async (
  privateKey: Uint8Array,
): Promise<AppKey> => {
  if (privateKey.length !== 32) {
    throw new MessageBuildError('An Ed25519 app key must be 32 bytes');
  }
  const signer = new NobleEd25519Signer(privateKey);
  const publicKey = unwrap(await signer.getSignerKey());
  return { privateKey, publicKey, publicKeyHex: bytesToHex(publicKey) };
};

export const appKeyFromPrivateKeyHex = (
  privateKeyHex: string,
): Promise<AppKey> => appKeyFromPrivateKey(hexToBytes(privateKeyHex));

/** A fresh app key from the platform CSPRNG. One click, no network, no chain. */
export const generateAppKey = async (
  randomBytes?: (length: number) => Uint8Array,
): Promise<AppKey> => {
  const bytes = randomBytes ? randomBytes(32) : randomAppKeyBytes(32);
  return appKeyFromPrivateKey(bytes);
};

const randomAppKeyBytes = (length: number): Uint8Array => {
  const cryptoImpl = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoImpl?.getRandomValues) {
    throw new MessageBuildError('No CSPRNG available to generate an app key');
  }
  return cryptoImpl.getRandomValues(new Uint8Array(length));
};

export interface BuildKeyAddOptions {
  fid: number;
  appKey: AppKey;
  /** The user's custody signer (browser-local: derived from the seed phrase). */
  custodyAccount: SignerAccount;
  /** Must be strictly greater than the FID's `currentUserNonce`. */
  nonce: number;
  /** Sliding expiry in seconds. Defaults to the protocol maximum (90 days). */
  ttlSeconds?: number;
  /** Seconds from now that the custody authorization stays valid. */
  deadlineSeconds?: number;
  scopes?: MessageType[];
  /** FID of the requesting app; defaults to `fid` (the client requests for itself). */
  requestFid?: number;
  network?: FarcasterNetwork;
  timestamp?: number;
  /** Overrides the deadline outright (Farcaster seconds), for tests. */
  deadline?: number;
}

const eip712SignerFor = (account: SignerAccount): ViemLocalEip712Signer =>
  new ViemLocalEip712Signer(account as never);

export const validateScopes = (scopes: MessageType[]): MessageType[] => {
  if (scopes.length === 0) {
    throw new MessageBuildError('A gasless key needs at least one scope');
  }
  for (const scope of scopes) {
    if (!ADMISSIBLE_KEY_ADD_SCOPES.includes(scope)) {
      throw new MessageBuildError(
        `Scope ${scope} is not admissible for a gasless KEY_ADD`,
      );
    }
  }
  return scopes;
};

export const validateTtlSeconds = (ttlSeconds: number): number => {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new MessageBuildError('TTL must be a positive number of seconds');
  }
  if (ttlSeconds > MAX_KEY_TTL_SECONDS) {
    throw new MessageBuildError(
      `TTL is capped at ${MAX_KEY_TTL_SECONDS} seconds (90 days) by the protocol`,
    );
  }
  return Math.floor(ttlSeconds);
};

/**
 * Build the gasless KEY_ADD message. Does not touch the network: pass an FID,
 * an app key, the custody signer and a nonce and you get back the bytes the
 * node will accept.
 */
export const buildKeyAddMessage = async (
  options: BuildKeyAddOptions,
): Promise<
  BuiltMessage & {
    scopes: MessageType[];
    ttl: number;
    nonce: number;
    deadline: number;
  }
> => {
  const scopes = validateScopes(
    options.scopes ?? DEFAULT_APP_KEY_SCOPES.slice(),
  );
  const ttl = validateTtlSeconds(options.ttlSeconds ?? MAX_KEY_TTL_SECONDS);
  const now = getFarcasterSeconds();
  const deadline =
    options.deadline ??
    now + (options.deadlineSeconds ?? DEFAULT_KEY_ADD_DEADLINE_SECONDS);

  const body = await unwrapAsync(
    makeKeyAddBody(
      {
        fid: BigInt(options.fid),
        key: options.appKey.publicKey,
        scopes,
        ttl,
        nonce: options.nonce,
        deadline,
        ...(options.requestFid === undefined
          ? {}
          : { requestFid: BigInt(options.requestFid) }),
      },
      eip712SignerFor(options.custodyAccount),
    ),
  );

  const envelopeSigner = new NobleEd25519Signer(options.appKey.privateKey);
  const message = await unwrapAsync(
    makeKeyAdd(
      body,
      {
        fid: options.fid,
        network: options.network ?? FarcasterNetwork.MAINNET,
        ...(options.timestamp === undefined
          ? {}
          : { timestamp: options.timestamp }),
      },
      envelopeSigner,
    ),
  );

  return {
    bytes: encodeMessage(message),
    hash: bytesToHex(message.hash),
    message,
    scopes,
    ttl,
    nonce: options.nonce,
    deadline,
  };
};

export interface RevokeAppKeyOptions {
  fid: number;
  appKey: AppKey;
  /**
   * App-nonce namespace value. Self-revocation consumes the app nonce, which
   * the node does not expose over HTTP without the `requesterFids` parameter
   * (that parameter is unusable through the current HTTP API — see
   * docs/NODE-CLIENT.md), so the client tracks it locally.
   */
  nonce: number;
  deadlineSeconds?: number;
  network?: FarcasterNetwork;
  timestamp?: number;
}

/** Self-revoking KEY_REMOVE: the app key signs its own removal, no custody key. */
export const buildKeyRemoveSelfMessage = async (
  options: RevokeAppKeyOptions,
): Promise<BuiltMessage> => {
  const deadline =
    getFarcasterSeconds() +
    (options.deadlineSeconds ?? DEFAULT_KEY_ADD_DEADLINE_SECONDS);
  const body = unwrap(
    makeKeyRemoveBodySelfRevoke({
      key: options.appKey.publicKey,
      nonce: options.nonce,
      deadline,
    }),
  );
  const message = await unwrapAsync(
    makeKeyRemove(
      body,
      {
        fid: options.fid,
        network: options.network ?? FarcasterNetwork.MAINNET,
        ...(options.timestamp === undefined
          ? {}
          : { timestamp: options.timestamp }),
      },
      new NobleEd25519Signer(options.appKey.privateKey),
    ),
  );
  return {
    bytes: encodeMessage(message),
    hash: bytesToHex(message.hash),
    message,
  };
};

/** Custody-signed KEY_REMOVE: consumes the user nonce, works even if the app key is gone. */
export const buildKeyRemoveCustodyMessage = async (
  options: Omit<RevokeAppKeyOptions, 'appKey'> & {
    appKey: AppKey;
    custodyAccount: SignerAccount;
  },
): Promise<BuiltMessage> => {
  const deadline =
    getFarcasterSeconds() +
    (options.deadlineSeconds ?? DEFAULT_KEY_ADD_DEADLINE_SECONDS);
  const body = await unwrapAsync(
    makeKeyRemoveBody(
      {
        fid: BigInt(options.fid),
        key: options.appKey.publicKey,
        nonce: options.nonce,
        deadline,
      },
      eip712SignerFor(options.custodyAccount),
    ),
  );
  const message = await unwrapAsync(
    makeKeyRemove(
      body,
      {
        fid: options.fid,
        network: options.network ?? FarcasterNetwork.MAINNET,
        ...(options.timestamp === undefined
          ? {}
          : { timestamp: options.timestamp }),
      },
      new NobleEd25519Signer(options.appKey.privateKey),
    ),
  );
  return {
    bytes: encodeMessage(message),
    hash: bytesToHex(message.hash),
    message,
  };
};

export interface FetchSignerStateOptions {
  node: SnapchainNodeClient;
  fid: number;
  publicKeyHex?: string;
}

export interface SignerState {
  signers: NodeSigner[];
  gaslessSignerCount: number;
  gaslessSignerLimit: number;
  currentUserNonce: number;
  /** The signer record for `publicKeyHex`, when present. */
  signer?: NodeSigner;
  /** When the gasless key bucket is full, the client must revoke one first. */
  quotaExhausted: boolean;
}

export const fetchSignerState = async ({
  node,
  fid,
  publicKeyHex,
}: FetchSignerStateOptions): Promise<SignerState> => {
  const page = await node.signersByFid({ fid, pageSize: 100 });
  const wanted = publicKeyHex?.toLowerCase();
  const signer = wanted
    ? page.signers.find((candidate) => candidate.key.toLowerCase() === wanted)
    : undefined;
  return {
    signers: page.signers,
    gaslessSignerCount: page.gaslessSignerCount,
    gaslessSignerLimit: page.gaslessSignerLimit || MAX_GASLESS_KEYS_PER_FID,
    currentUserNonce: page.currentUserNonce,
    signer,
    quotaExhausted:
      page.gaslessSignerCount >=
      (page.gaslessSignerLimit || MAX_GASLESS_KEYS_PER_FID),
  };
};

export type IssueAppKeyStep =
  | 'reading-nonce'
  | 'building'
  | 'submitting'
  | 'confirming'
  | 'done';

/**
 * Issuing a key reads the FID's nonce from the node, so `nonce` is optional
 * here (pass it only to override, e.g. in tests).
 */
export interface IssueAppKeyOptions extends Omit<BuildKeyAddOptions, 'nonce'> {
  node: SnapchainNodeClient;
  nonce?: number;
  /** Polling budget while the key is gossiped and merged. */
  confirmAttempts?: number;
  confirmIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onStep?: (step: IssueAppKeyStep, detail?: string) => void;
}

export interface IssueAppKeyResult {
  /** The signer record the node reports once the key is live. */
  signer: NodeSigner;
  /** The node's echo of the accepted message. */
  submitted: NodeMessage;
  built: BuiltMessage;
  userId: { nonce: number; deadline: number };
}

/**
 * Issue the client its own app key: read the nonce, build the gasless KEY_ADD,
 * submit it through your node, then wait until the node reports the key on the
 * FID. Resolves only when the key is actually usable.
 */
export const issueAppKey = async (
  options: IssueAppKeyOptions,
): Promise<IssueAppKeyResult> => {
  const { node, onStep } = options;

  onStep?.('reading-nonce');
  const state = await fetchSignerState({ node, fid: options.fid });
  if (state.quotaExhausted) {
    throw new MessageBuildError(
      `This FID already has ${state.gaslessSignerCount}/${state.gaslessSignerLimit} gasless keys — revoke one first`,
    );
  }
  const nonce = options.nonce ?? state.currentUserNonce + 1;

  onStep?.('building');
  const built = await buildKeyAddMessage({ ...options, nonce });

  onStep?.('submitting');
  const submitted = await node.submitMessage(built.bytes);

  onStep?.('confirming');
  const signer = await waitForSigner({
    node,
    fid: options.fid,
    publicKeyHex: options.appKey.publicKeyHex,
    attempts: options.confirmAttempts ?? 15,
    intervalMs: options.confirmIntervalMs ?? 2000,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  onStep?.('done', signer.key);
  return {
    signer,
    submitted,
    built,
    userId: { nonce: built.nonce, deadline: built.deadline },
  };
};

export const waitForSigner = async (options: {
  node: SnapchainNodeClient;
  fid: number;
  publicKeyHex: string;
  attempts: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<NodeSigner> => {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const state = await fetchSignerState({
      node: options.node,
      fid: options.fid,
      publicKeyHex: options.publicKeyHex,
    });
    if (state.signer) {
      return state.signer;
    }
    await sleep(options.intervalMs);
  }
  const info = await fetchSignerState({ node: options.node, fid: options.fid });
  throw new MessageBuildError(
    `The node accepted the KEY_ADD but has not merged it after ${
      (options.attempts * options.intervalMs) / 1000
    }s (user nonce now ${info.currentUserNonce}). A read node relays writes to validators; ` +
      'if it stays unmerged, check the node log for a validation rejection.',
  );
};

/** Submit a self-revoking KEY_REMOVE through your own node. */
export const revokeAppKey = async (
  options: RevokeAppKeyOptions & { node: SnapchainNodeClient },
): Promise<NodeMessage> => {
  const built = await buildKeyRemoveSelfMessage(options);
  return options.node.submitMessage(built.bytes);
};

/** Farcaster-seconds "now", exposed so callers can compute deadlines. */
export { getFarcasterSeconds };

/**
 * Protocol constants the UI needs in order to explain a key honestly, re-exported
 * so the client does not have to depend on `@farcaster/core` directly.
 */
export {
  KEY_TYPE_ED25519,
  MAX_GASLESS_KEYS_PER_FID,
  MAX_KEY_ADD_SCOPES,
  MAX_KEY_TTL_SECONDS,
} from '@farcaster/core';
