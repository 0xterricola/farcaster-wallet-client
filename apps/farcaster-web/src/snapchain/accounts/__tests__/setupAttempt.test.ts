/**
 * A setup that can be left, and picked back up.
 *
 * The four things this file has to prove, in the order a person meets them:
 *
 *   1. the attempt is on this device BEFORE any money moves, and a reopen finds
 *      it — with the same address, the same words and the same device key, so a
 *      retry does not mint a second signing key on the node;
 *   2. the step acted on is read from the chain, so an account whose fee already
 *      bought an FID is finished rather than registered a second time;
 *   3. start over takes an installed key back off the node and keeps nothing
 *      that would let the attempt write again;
 *   4. a set-aside attempt is still in the book, still selected, and still one
 *      press from being resumed.
 *
 * The chain and the node are fakes that answer by fact: the chain switches to
 * "registered" only when a registration is actually sent, and the node is told
 * when it is allowed to see the account.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: vi.fn(
    async ({ key, fallback }: { key: string; fallback: unknown }) =>
      store.has(key) ? store.get(key) : fallback,
  ),
  setItem: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  }),
  deleteItem: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

import {
  AccountCreationAborted,
  type AccountKeyStore,
  type AccountNodePort,
  createOrResumeAccountSetup,
  finishAccountSetup,
  type FundingState,
} from '~/snapchain/accounts/createAccount';
import {
  attemptWasStartedOver,
  markAttemptStartedOver,
  newAttemptId,
  setupStepFrom,
  startedSetupAccount,
} from '~/snapchain/accounts/createAttempt';
import {
  isSettingUp,
  loadCurrentAccount,
  loadLocalAccounts,
  removeLocalAccount,
  saveLocalAccount,
} from '~/snapchain/accounts/localAccounts';
import { ID_GATEWAY_ADDRESS } from '~/snapchain/accounts/optimism';
import type { CustodyAccount } from '~/snapchain/accounts/phrase';
import {
  resumesSetup,
  setSetupAside,
  setupSetAside,
} from '~/snapchain/accounts/setupAside';

const PRICE_WEI = 81_402_795_512_410n;
const PRICE_HEX = `0x${PRICE_WEI.toString(16)}`;
const CUSTODY_ADDRESS =
  '0x4444444444444444444444444444444444444444' as `0x${string}`;
const TX_HASH = `0x${'ef'.repeat(32)}`;
const DEVICE_KEY = `0x${'22'.repeat(32)}`;

const custody = () =>
  ({
    address: CUSTODY_ADDRESS,
    signTransaction: vi.fn(async () => `0x${'ab'.repeat(100)}`),
    signTypedData: vi.fn(async () => `0x${'cd'.repeat(65)}`),
  }) as unknown as CustodyAccount;

/** A chain that answers by contract, and only mints a FID when one is sent. */
const chain = ({
  chainId = '0xa',
  balanceWei = PRICE_WEI * 10n,
  fidNow = 0,
  fidAfterRegistration = 4242,
}: {
  chainId?: string;
  balanceWei?: bigint;
  fidNow?: number;
  fidAfterRegistration?: number;
} = {}) => {
  const state = { fid: fidNow, sent: [] as string[] };

  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    let result = '0x';

    switch (body.method) {
      case 'eth_chainId':
        result = chainId;
        break;
      case 'eth_getBalance':
        result = `0x${balanceWei.toString(16)}`;
        break;
      case 'eth_call': {
        const call = body.params[0] as { to?: string };
        result =
          call.to === ID_GATEWAY_ADDRESS
            ? PRICE_HEX
            : `0x${state.fid.toString(16).padStart(64, '0')}`;
        break;
      }
      case 'eth_getTransactionCount':
        result = '0x0';
        break;
      case 'eth_estimateGas':
        result = '0x30d40';
        break;
      case 'eth_gasPrice':
        result = '0xf5201';
        break;
      case 'eth_maxPriorityFeePerGas':
        result = '0x0';
        break;
      case 'eth_sendRawTransaction':
        state.sent.push(String(body.params[0]));
        state.fid = fidAfterRegistration;
        result = TX_HASH;
        break;
      default:
        result = '0x0';
    }

    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
    });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, state };
};

const fakeNode = ({ nextNonce = 8 }: { nextNonce?: number } = {}) => {
  const installSigner = vi.fn(async () => ({ nextNonce }));
  const removeSigner = vi.fn(async () => undefined);
  const readUser = vi.fn(async (fid: number) => ({ fid }));
  const setProfile = vi.fn(async () => undefined);

  return {
    port: {
      installSigner,
      removeSigner,
      readUser,
      setProfile,
    } as AccountNodePort,
    installSigner,
    removeSigner,
    readUser,
    setProfile,
  };
};

/** The device's own key store, so the assertion is about what was written. */
const keyStore = () => {
  const saved: { fid: number; key: string }[] = [];
  const store_: AccountKeyStore = {
    saveAppKey: vi.fn(async (fid: number, key: string) => {
      saved.push({ fid, key });
    }),
    saveAppNonce: vi.fn(async () => undefined),
  };

  return { keyStore: store_, saved };
};

const instantSleep = vi.fn(async () => undefined);

/** The unfinished entry this device keeps, exactly as the sheet writes it. */
const startedAttempt = (attemptId = newAttemptId()) =>
  startedSetupAccount({
    account: {
      id: CUSTODY_ADDRESS.toLowerCase(),
      custodyAddress: CUSTODY_ADDRESS,
      phrase: 'apple banana cherry',
      username: 'newperson',
      displayName: 'New Person',
    },
    attemptId,
    signingKeyHex: DEVICE_KEY,
    startedAt: 1_700_000_000_000,
  });

beforeEach(() => {
  store.clear();
});

describe('an attempt is written down before any money moves', () => {
  it('is the selected, unfinished account a reload reads back', async () => {
    const attempt = startedAttempt();

    await saveLocalAccount(attempt);

    const reopened = await loadCurrentAccount();

    expect(reopened?.id).toBe(attempt.id);
    expect(isSettingUp(reopened)).toBe(true);
    expect(reopened?.setup).toEqual({
      attemptId: attempt.setup?.attemptId,
      startedAt: 1_700_000_000_000,
      signingKeyHex: DEVICE_KEY,
      lastStep: 'fund',
    });
    // The address the person is being asked to pay, and the words that own it,
    // both survive a reload now. Before this entry existed there was no
    // unfinished account at all, so there was nothing to read back.
    expect(reopened?.custodyAddress).toBe(CUSTODY_ADDRESS);
    expect(reopened?.phrase).toBe('apple banana cherry');
  });

  it('says where the chain has got to, never where a progress flag had', () => {
    expect(setupStepFrom(fundingState({ fid: 0, enough: false }))).toBe(
      'waiting',
    );
    expect(setupStepFrom(fundingState({ fid: 0, enough: true }))).toBe(
      'funded',
    );
    // A FID means the fee already bought the account: finish it, never register
    // a second one.
    expect(setupStepFrom(fundingState({ fid: 4242, enough: false }))).toBe(
      'registered',
    );
    expect(setupStepFrom({ kind: 'wrong-chain', chainId: 1 })).toBe('blocked');
    expect(setupStepFrom({ kind: 'unavailable', reason: 'no rpc' })).toBe(
      'blocked',
    );
  });

  it('reopens mid-fund and finishes the account instead of registering twice', async () => {
    const attempt = startedAttempt();
    await saveLocalAccount(attempt);

    const reopened = (await loadCurrentAccount())!;
    // The chain now says the fee bought the account while the sheet was closed.
    const { fetchImpl, state } = chain({ fidNow: 4242 });
    const node = fakeNode();
    const keys = keyStore();

    const answer = await createOrResumeAccountSetup({
      rpcUrl: 'http://rpc.test',
      custody: custody(),
      node: node.port,
      signingKeyHex: reopened.setup!.signingKeyHex,
      username: reopened.username,
      displayName: reopened.displayName,
      fetchImpl,
      sleep: instantSleep,
      keyStore: keys.keyStore,
      shouldContinue: () => true,
    });

    expect(answer.resumed).toBe(true);
    expect(answer.result.fid).toBe(4242);
    // Nothing was signed, so nothing was spent twice.
    expect(state.sent).toEqual([]);
    // And the key it installed is the one this attempt was written down with: a
    // retry does not mint a second live posting key.
    expect(node.installSigner).toHaveBeenCalledWith(
      expect.objectContaining({ fid: 4242, signingKeyHex: DEVICE_KEY }),
    );
    expect(keys.saved).toEqual([{ fid: 4242, key: DEVICE_KEY }]);
  });
});

describe('start over', () => {
  it('takes an installed key back off the node and keeps no copy here', async () => {
    const node = fakeNode();
    const keys = keyStore();
    let abandoned = false;

    // The person presses start over while the KEY_ADD is in flight.
    node.installSigner.mockImplementation(async () => {
      abandoned = true;
      return { nextNonce: 8 };
    });

    await expect(
      finishAccountSetup({
        rpcUrl: 'http://rpc.test',
        custody: custody(),
        node: node.port,
        signingKeyHex: DEVICE_KEY,
        fetchImpl: chain({ fidNow: 4242 }).fetchImpl,
        sleep: instantSleep,
        keyStore: keys.keyStore,
        shouldContinue: () => !abandoned,
      }),
    ).rejects.toBeInstanceOf(AccountCreationAborted);

    expect(node.removeSigner).toHaveBeenCalledWith({
      fid: 4242,
      signingKeyHex: DEVICE_KEY,
      nextNonce: 8,
    });
    // An abandoned attempt keeps nothing: no local key, no name, no profile.
    expect(keys.saved).toEqual([]);
    expect(node.setProfile).not.toHaveBeenCalled();
  });

  it('refuses to write for an attempt that was started over earlier', async () => {
    const attemptId = newAttemptId();
    markAttemptStartedOver(attemptId);

    const { fetchImpl, state } = chain({ fidNow: 0 });
    const node = fakeNode();
    const keys = keyStore();

    await expect(
      createOrResumeAccountSetup({
        rpcUrl: 'http://rpc.test',
        custody: custody(),
        node: node.port,
        signingKeyHex: DEVICE_KEY,
        fetchImpl,
        sleep: instantSleep,
        keyStore: keys.keyStore,
        shouldContinue: () => !attemptWasStartedOver(attemptId),
      }),
    ).rejects.toBeInstanceOf(AccountCreationAborted);

    expect(attemptWasStartedOver(attemptId)).toBe(true);
    // A registration that would have landed after the press changes nothing: it
    // is never sent, no key is installed, and no account is written back.
    expect(state.sent).toEqual([]);
    expect(node.installSigner).not.toHaveBeenCalled();
    expect(keys.saved).toEqual([]);
  });

  it('starts the same account again with a fresh attempt id', async () => {
    const first = startedAttempt();
    await saveLocalAccount(first);

    markAttemptStartedOver(first.setup!.attemptId);
    await removeLocalAccount(first.id);

    await expect(loadLocalAccounts()).resolves.toEqual([]);
    await expect(loadCurrentAccount()).resolves.toBeUndefined();

    // Starting over is not a bar on the same words being set up again: a new
    // attempt has a new id and writes freely.
    const second = startedAttempt();
    expect(second.setup?.attemptId).not.toBe(first.setup?.attemptId);
    expect(attemptWasStartedOver(second.setup!.attemptId)).toBe(false);
  });
});

describe('setting an unfinished setup aside', () => {
  it('leaves it in the book, selected, and one press from coming back', async () => {
    const attempt = startedAttempt();
    await saveLocalAccount(attempt);

    const reopened = (await loadCurrentAccount())!;
    expect(resumesSetup(reopened)).toBe(true);

    // "Add account" while this one is mid-setup.
    setSetupAside(reopened);

    expect(resumesSetup(reopened)).toBe(false);
    expect(setupSetAside()).toBe(reopened.id);
    // Still here: setting aside is not forgetting.
    await expect(loadLocalAccounts()).resolves.toHaveLength(1);
    expect((await loadCurrentAccount())?.id).toBe(reopened.id);

    // "Finish setting up …" brings it back.
    setSetupAside(null);
    expect(resumesSetup(reopened)).toBe(true);
  });

  it('sets nothing aside for an account that is done, or for nothing at all', () => {
    const finished = { ...startedAttempt(), setup: undefined };

    setSetupAside(finished);
    expect(setupSetAside()).toBeNull();

    setSetupAside(startedAttempt());
    setSetupAside(finished);
    expect(setupSetAside()).toBeNull();

    setSetupAside(startedAttempt());
    expect(setupSetAside()).not.toBeNull();
    setSetupAside(undefined);
    expect(setupSetAside()).toBeNull();
    expect(resumesSetup(finished)).toBe(false);
  });
});

/** A `FundingState` with the fields the step decision reads. */
function fundingState({
  fid = 0,
  balance = 0n,
  enough = false,
  price = PRICE_WEI,
}: {
  fid?: number;
  balance?: bigint;
  enough?: boolean;
  price?: bigint;
}): FundingState {
  return {
    kind: 'ready',
    fid,
    price,
    balance,
    needed: price,
    enough,
  };
}
