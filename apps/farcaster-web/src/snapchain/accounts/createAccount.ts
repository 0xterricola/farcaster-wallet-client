/**
 * Creating an account, step by step, with the network as the only judge.
 *
 * The flow is deliberately shaped so that every step can be re-derived from
 * outside this file: the chain says whether the fee is paid and whether an FID
 * exists, the registry says whether the name is taken, and the node says whether
 * it has seen the new account yet. Nothing is remembered between steps as
 * "done" — a reload resumes exactly where the facts stopped, which is what makes
 * "close the tab and come back later" honest rather than hopeful.
 *
 * Two halves, because they have different rhythms:
 *
 *   `readFundingState`  — cheap, polled while a person sends ETH from a wallet or
 *                         an exchange. Says how much is needed and whether it has
 *                         arrived; it never writes.
 *   `finishAccountSetup` — after registration: add a signing key for this device,
 *                         save it on this device, claim the @name, write the
 *                         profile. Retried, because a node needs a moment to see
 *                         a brand-new FID.
 *
 * Both take their effects as injected ports, so the whole flow is exercised in
 * tests against a mocked chain and a mocked node — see `__tests__`.
 *
 * THE KEY IS NOT MERELY INSTALLED, IT IS KEPT. A gasless KEY_ADD makes the
 * account *accept* this device's key; it does not make this device *hold* it.
 * The write path resolves the key it signs with from `~/snapchain/appKeyStorage`
 * for the session's FID, so a key that is installed on the node and then dropped
 * on the floor leaves an account that can be read and never written — 501
 * `NO_APP_KEY` on every heart, follow and post. So `installSigner` hands back the
 * nonce the next message for this account must exceed, and this module writes
 * both the key and that nonce to the device's own store before it reports the
 * step as done. `AccountKeyStore` is the seam: the real one is
 * `~/snapchain/appKeyStorage`, and tests inject their own.
 */

import { saveAppKey, saveAppNonce } from '~/snapchain/appKeyStorage';

import {
  buildRegistrationRequest,
  MAX_REGISTRATION_PRICE_WEI,
  readChainId,
  readFidOf,
  readOptimismBalance,
  readRegistrationPrice,
  registerFid,
  type RegistrationSigner,
} from './optimism';
import type { CustodyAccount } from './phrase';
import { claimName } from './username';

/** Gas kept back for the registration transaction itself, in wei (0.00001 ETH).
 *  MEASURED 2026-10-21: a registration used ~200k gas at 0.001 gwei, which is
 *  about 2×10^8 wei — five hundred times under this buffer. */
export const GAS_BUFFER_WEI = 10_000_000_000_000n;

/** How many times the node is asked to show the new account before we give up. */
export const DEFAULT_SETUP_ATTEMPTS = 20;

/** The pause between those attempts. A new FID is usually visible in seconds. */
export const DEFAULT_SETUP_RETRY_MS = 3_000;

export type FundingState =
  | { kind: 'wrong-chain'; chainId: number }
  | {
      kind: 'ready';
      /** The FID this address already owns, or 0. */
      fid: number;
      /** wei */
      price: bigint;
      /** wei */
      balance: bigint;
      /** price + a gas buffer: what must be in the account. */
      needed: bigint;
      enough: boolean;
    }
  | { kind: 'unavailable'; reason: string };

/** Raised when a step cannot honestly be reported as done. */
export class AccountCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountCreationError';
  }
}

/**
 * What the screen needs to show a person who is about to send money: the amount,
 * the address, and whether it has arrived yet. Read-only.
 */
export const readFundingState = async ({
  rpcUrl,
  address,
  fetchImpl,
  registrationPriceWei,
}: {
  rpcUrl: string;
  address: string;
  fetchImpl?: typeof fetch;
  /** Injected by tests; read from the contract otherwise. */
  registrationPriceWei?: bigint;
}): Promise<FundingState> => {
  try {
    const chainId = await readChainId({ rpcUrl, fetchImpl });

    if (chainId !== 10) {
      return { kind: 'wrong-chain', chainId };
    }

    const [fid, balance, price] = await Promise.all([
      readFidOf({ rpcUrl, address, fetchImpl }),
      readOptimismBalance({ rpcUrl, address, fetchImpl }),
      registrationPriceWei !== undefined
        ? Promise.resolve(registrationPriceWei)
        : readRegistrationPrice({ rpcUrl, fetchImpl }),
    ]);

    const needed = price + GAS_BUFFER_WEI;

    return {
      kind: 'ready',
      fid,
      price,
      balance,
      needed,
      enough: balance >= needed,
    };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason:
        error instanceof Error && error.message
          ? error.message
          : "we couldn't reach the Optimism endpoint",
    };
  }
};

/** Where this device keeps the key it signs with, per FID. The real one is
 *  `~/snapchain/appKeyStorage`; tests inject a spy. */
export interface AccountKeyStore {
  saveAppKey: (fid: number, privateKeyHex: string) => Promise<void>;
  saveAppNonce: (fid: number, nonce: number) => Promise<void>;
}

/** The device's own store, which is what the write path reads. */
export const deviceKeyStore: AccountKeyStore = { saveAppKey, saveAppNonce };

/** What the post-registration half needs from the node. Implemented against the
 *  real client in `nodeAccountOps.ts`; faked in tests. */
export interface AccountNodePort {
  /** Add this device's signing key to the account (gasless: a signature, no
   *  transaction), and resolve once the node shows the key on the FID.
   *
   *  Resolves with the nonce the NEXT message for this FID must exceed, read
   *  from the node after the KEY_ADD merged — the caller stores it so a write
   *  made after a reload does not reuse a nonce the node has already seen.
   *  Must reject if the node has not seen the account yet, or if the node
   *  accepted the KEY_ADD without ever showing the key. */
  installSigner: (parameters: {
    fid: number;
    signingKeyHex: string;
    custody: CustodyAccount;
  }) => Promise<{ nextNonce: number }>;
  /** Has the node seen this FID yet, and what does it know about it? */
  readUser: (
    fid: number,
  ) => Promise<
    { fid: number; custodyAddress?: string; username?: string } | undefined
  >;
  /** Write @name / display name onto the profile. */
  setProfile: (parameters: {
    fid: number;
    signingKeyHex: string;
    username?: string;
    displayName?: string;
  }) => Promise<void>;
}

export interface FinishSetupResult {
  fid: number;
  username?: string;
  signingKeyHex: string;
  /** Steps that completed, in order, for the progress list on screen. */
  completed: ('signer' | 'name' | 'profile')[];
  /** A step that could not be finished, described the way it will be shown. */
  warning?: string;
}

/**
 * Register the FID for a locally held account, then finish the account.
 *
 * The registration is a transaction this device signs and sends; everything
 * after it is a signature. If the fee has not arrived yet, this says so instead
 * of signing something that would fail on the chain.
 */
export const createAccountOnChain = async ({
  rpcUrl,
  custody,
  fetchImpl,
  nameFetchImpl,
  attempts = DEFAULT_SETUP_ATTEMPTS,
  retryMs = DEFAULT_SETUP_RETRY_MS,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  node,
  signingKeyHex,
  username,
  displayName,
  signer,
  keyStore,
}: {
  rpcUrl: string;
  custody: CustodyAccount;
  fetchImpl?: typeof fetch;
  /** The name registry's transport. Defaults to `fetchImpl`'s default. */
  nameFetchImpl?: typeof fetch;
  attempts?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  node: AccountNodePort;
  /** This device's app key, generated locally. */
  signingKeyHex: string;
  username?: string;
  displayName?: string;
  /** Where the device's copy of the key is kept. Defaults to the real store. */
  keyStore?: AccountKeyStore;
  /** Who pays and signs the registration. Defaults to the custody account
   *  itself; a different signer (a wallet, a sponsor) keeps the account in
   *  `custody`'s name, which is the payer≠owner split. */
  signer?: RegistrationSigner;
}): Promise<{ txHash: string; result: FinishSetupResult }> => {
  const funding = await readFundingState({
    rpcUrl,
    address: custody.address,
    fetchImpl,
  });

  if (funding.kind === 'wrong-chain') {
    throw new AccountCreationError(
      `that Optimism endpoint is on a different network (${funding.chainId}) - check the endpoint in Advanced`,
    );
  }

  if (funding.kind === 'unavailable') {
    throw new AccountCreationError(funding.reason);
  }

  if (funding.fid > 0) {
    throw new AccountCreationError(
      'this account is already registered - sign in with it instead',
    );
  }

  if (funding.price > MAX_REGISTRATION_PRICE_WEI) {
    throw new AccountCreationError(
      'the registration fee that endpoint quoted is far higher than it should be - check the endpoint in Advanced',
    );
  }

  if (!funding.enough) {
    throw new AccountCreationError(
      'the registration fee has not arrived on the account yet',
    );
  }

  const { txHash } = await registerFid({
    rpcUrl,
    signer: signer ?? (custody as unknown as RegistrationSigner),
    recovery: custody.address as `0x${string}`,
    fetchImpl,
  });

  const result = await finishAccountSetup({
    rpcUrl,
    custody,
    node,
    signingKeyHex,
    username,
    displayName,
    attempts,
    retryMs,
    sleep,
    fetchImpl,
    nameFetchImpl,
    ...(keyStore ? { keyStore } : {}),
  });

  return { txHash, result };
};

/**
 * Everything after registration: a signing key for this device, saved on this
 * device; the @name; the profile. Retried while the node catches up, because a
 * freshly registered FID is not instantly visible to it and a KEY_ADD for an
 * account the node has not seen is exactly the failure this loop exists to
 * avoid.
 */
export const finishAccountSetup = async ({
  rpcUrl,
  custody,
  node,
  signingKeyHex,
  username,
  displayName,
  attempts = DEFAULT_SETUP_ATTEMPTS,
  retryMs = DEFAULT_SETUP_RETRY_MS,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  fetchImpl,
  nameFetchImpl,
  keyStore = deviceKeyStore,
}: {
  rpcUrl: string;
  custody: CustodyAccount;
  node: AccountNodePort;
  signingKeyHex: string;
  username?: string;
  displayName?: string;
  attempts?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** The name registry's transport, when it differs from the chain's. */
  nameFetchImpl?: typeof fetch;
  /** Where this device keeps the key it signs with. Defaults to the real store;
   *  tests inject one so the assertion is about what was written, not a mock. */
  keyStore?: AccountKeyStore;
}): Promise<FinishSetupResult> => {
  let fid = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts && fid === 0; attempt++) {
    try {
      fid = await readFidOf({ rpcUrl, address: custody.address, fetchImpl });
    } catch (error) {
      lastError = error;
    }

    if (fid === 0) {
      await sleep(retryMs);
    }
  }

  if (fid === 0) {
    throw new AccountCreationError(
      lastError instanceof Error && lastError.message
        ? lastError.message
        : "the network hasn't given this account a number yet - give it a minute and try again",
    );
  }

  const completed: FinishSetupResult['completed'] = [];

  // The node has to know the account before it will take a key for it.
  let seen = false;
  for (let attempt = 0; attempt < attempts && !seen; attempt++) {
    try {
      seen = Boolean(await node.readUser(fid));
    } catch (error) {
      lastError = error;
    }

    if (!seen) {
      await sleep(retryMs);
    }
  }

  if (!seen) {
    throw new AccountCreationError(
      `@${username ?? fid} is registered, but the server Fiddy reads from hasn't caught up yet - reopen Fiddy in a minute`,
    );
  }

  const installed = await node.installSigner({ fid, signingKeyHex, custody });

  // The key is only usable after a reload if this device kept its copy. Write it
  // before the step is called done: an account whose key was installed and not
  // saved is an account that cannot post, and reporting "signer" for that would
  // be the exact lie this flow exists to avoid.
  try {
    await keyStore.saveAppKey(fid, signingKeyHex);
    await keyStore.saveAppNonce(fid, installed.nextNonce);
  } catch {
    throw new AccountCreationError(
      'the account exists, but this device could not save the key that posts for it - open Advanced on this browser and add one',
    );
  }

  completed.push('signer');

  // The name is the one part that can honestly stay unfinished: the account
  // works without it, and a taken name is not a reason to fail the account.
  let warning: string | undefined;

  if (username) {
    const claimed = await claimName({
      name: username,
      fid,
      custody,
      ...(nameFetchImpl ? { fetchImpl: nameFetchImpl } : {}),
    });

    if (claimed.ok) {
      completed.push('name');
    } else {
      warning = claimed.reason;
    }
  }

  try {
    await node.setProfile({ fid, signingKeyHex, username, displayName });
    completed.push('profile');
  } catch {
    warning ??=
      'the account is ready, but the name did not reach your profile yet';
  }

  return { fid, username, signingKeyHex, completed, warning };
};

/** The request preview: what the screen shows before anything is signed. */
export const previewRegistration = ({
  custody,
  price,
}: {
  custody: CustodyAccount;
  price: bigint;
}) =>
  buildRegistrationRequest({
    recovery: custody.address as `0x${string}`,
    value: price,
  });
