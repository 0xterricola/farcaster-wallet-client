/**
 * Creating an account, end to end, against a mocked chain and a mocked node.
 *
 * This is the test the card asked for: the whole flow, with every effect
 * observable. The chain is a JSON-RPC responder that starts with no FID for the
 * new address and starts answering with one after the registration is sent; the
 * node is a fake that refuses to see the account until it is told to, so the
 * "a node that has not caught up yet" path is exercised rather than assumed.
 *
 * What is asserted is what a person would care about: that no money is spent
 * before it has arrived, that the bytes signed are a registration for the price
 * that was read, that the signing key is installed only once the node knows the
 * account, that the key this device installed is still on the device when the
 * flow calls the account ready (an account that cannot post is not ready), and
 * that a taken @name leaves a working account rather than a broken one.
 */

import { encodeFunctionData } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The device's own storage, as this suite sees it. `appKeyStorage` writes
 * through `~/utils/storageUtils`, so the assertions below are about the exact
 * keys a reload would read back — not about a mock's call log.
 */
const deviceStore = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: vi.fn(
    async ({ key, fallback }: { key: string; fallback: unknown }) =>
      deviceStore.has(key) ? deviceStore.get(key) : fallback,
  ),
  setItem: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
    deviceStore.set(key, value);
  }),
  deleteItem: vi.fn(async (key: string) => {
    deviceStore.delete(key);
  }),
}));

import {
  type AccountKeyStore,
  type AccountNodePort,
  createAccountOnChain,
  finishAccountSetup,
  GAS_BUFFER_WEI,
  readFundingState,
} from '~/snapchain/accounts/createAccount';
import {
  ID_GATEWAY_ADDRESS,
  ID_REGISTRY_ADDRESS,
  type RegistrationSigner,
} from '~/snapchain/accounts/optimism';
import type { CustodyAccount } from '~/snapchain/accounts/phrase';
import { FNAME_REGISTRY_URL } from '~/snapchain/accounts/username';

const LIVE_PRICE_WEI = 81_402_795_512_410n;
const PRICE_HEX = `0x${LIVE_PRICE_WEI.toString(16)}`;
const CUSTODY_ADDRESS =
  '0x3333333333333333333333333333333333333333' as `0x${string}`;
const TX_HASH = `0x${'ef'.repeat(32)}`;
const RAW_TX = `0x${'ab'.repeat(100)}`;

const custody = () => {
  const signTransaction = vi.fn(
    async (_transaction: unknown) => RAW_TX as `0x${string}`,
  );
  const account = {
    address: CUSTODY_ADDRESS,
    signTransaction,
    signTypedData: vi.fn(async () => `0x${'cd'.repeat(65)}` as `0x${string}`),
  } as unknown as CustodyAccount;

  return { account, signTransaction };
};

/** A chain that answers by contract, and remembers the one transaction sent. */
const chain = ({
  chainId = '0xa',
  balanceWei = LIVE_PRICE_WEI * 10n,
  fidAfterRegistration = 4242,
  fidNow = 0,
}: {
  chainId?: string;
  balanceWei?: bigint;
  fidAfterRegistration?: number;
  fidNow?: number;
} = {}) => {
  const state = {
    fid: fidNow,
    sent: [] as string[],
    calls: [] as { to?: string; data?: string }[],
  };

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
        const call = body.params[0] as { to?: string; data?: string };
        state.calls.push(call);
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
      case 'eth_sendRawTransaction': {
        state.sent.push(String(body.params[0]));
        // The chain now knows the FID it just minted.
        state.fid = fidAfterRegistration;
        result = TX_HASH;
        break;
      }
      default:
        result = '0x0';
    }

    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
    });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, state };
};

/** The node: quiet about the account until it is told otherwise. */
const fakeNode = ({
  seesFid = true,
  profileWriteFails = false,
  nextNonce = 8,
}: {
  seesFid?: boolean;
  profileWriteFails?: boolean;
  /** What the node reports after the KEY_ADD merged, plus the next nonce. */
  nextNonce?: number;
} = {}) => {
  const installSigner = vi.fn(async () => ({ nextNonce }));
  const setProfile = vi.fn(async () => {
    if (profileWriteFails) {
      throw new Error('node said no');
    }
  });
  const readUser = vi.fn(async (fid: number) =>
    seesFid ? { fid, username: undefined } : undefined,
  );

  return {
    port: { installSigner, readUser, setProfile } as AccountNodePort,
    installSigner,
    readUser,
    setProfile,
  };
};

const fnameFetch = ({
  takenBy,
  claimStatus = 200,
}: { takenBy?: number; claimStatus?: number } = {}) => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];

  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/transfers/current')) {
      return takenBy === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ transfer: { to: takenBy } }), {
            status: 200,
          });
    }

    posts.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });

    return new Response('{}', { status: claimStatus });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, posts };
};

const instantSleep = vi.fn(async () => undefined);

/** The key this device generated for itself, as the flow passes it around. */
const DEVICE_KEY = `0x${'11'.repeat(32)}`;

beforeEach(() => {
  deviceStore.clear();
});

describe('what the screen is told while someone sends money', () => {
  it('says how much is needed and whether it has arrived', async () => {
    const { fetchImpl } = chain({ balanceWei: 1_000n });

    await expect(
      readFundingState({
        rpcUrl: 'http://rpc.test',
        address: CUSTODY_ADDRESS,
        fetchImpl,
      }),
    ).resolves.toEqual({
      kind: 'ready',
      fid: 0,
      price: LIVE_PRICE_WEI,
      balance: 1_000n,
      needed: LIVE_PRICE_WEI + GAS_BUFFER_WEI,
      enough: false,
    });
  });

  it('names a wrong-network endpoint instead of signing into it', async () => {
    const { fetchImpl } = chain({ chainId: '0x1' });

    await expect(
      readFundingState({
        rpcUrl: 'http://rpc.test',
        address: CUSTODY_ADDRESS,
        fetchImpl,
      }),
    ).resolves.toEqual({ kind: 'wrong-chain', chainId: 1 });
  });

  it('reports an unreachable endpoint as such, never as "free"', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });

    const state = await readFundingState({
      rpcUrl: 'http://rpc.test',
      address: CUSTODY_ADDRESS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state.kind).toBe('unavailable');
  });
});

describe('registering', () => {
  it('refuses to sign until the fee has actually arrived', async () => {
    const { fetchImpl } = chain({ balanceWei: LIVE_PRICE_WEI - 1n });
    const { account, signTransaction } = custody();
    const node = fakeNode();

    await expect(
      createAccountOnChain({
        rpcUrl: 'http://rpc.test',
        custody: account,
        fetchImpl,
        node: node.port,
        signingKeyHex: `0x${'11'.repeat(32)}`,
        sleep: instantSleep,
      }),
    ).rejects.toThrow(/has not arrived on the account yet/);

    expect(signTransaction).not.toHaveBeenCalled();
    expect(node.installSigner).not.toHaveBeenCalled();
  });

  it('signs a registration for the price it read, from the account itself', async () => {
    const { fetchImpl } = chain();
    const { account, signTransaction } = custody();
    const node = fakeNode();
    const names = fnameFetch();

    const out = await createAccountOnChain({
      rpcUrl: 'http://rpc.test',
      custody: account,
      fetchImpl,
      nameFetchImpl: names.fetchImpl,
      node: node.port,
      signingKeyHex: `0x${'11'.repeat(32)}`,
      username: 'fiddy',
      displayName: 'Fiddy',
      sleep: instantSleep,
    });

    expect(out.txHash).toBe(TX_HASH);
    expect(out.result.fid).toBe(4242);
    expect(out.result.completed).toEqual(['signer', 'name', 'profile']);
    expect(out.result.warning).toBeUndefined();

    const signed = signTransaction.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;

    expect(signed.to).toBe(ID_GATEWAY_ADDRESS);
    expect(signed.value).toBe(LIVE_PRICE_WEI);
    expect(signed.data).toBe(
      encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'register',
            stateMutability: 'payable',
            inputs: [
              { name: 'recovery', type: 'address' },
              { name: 'extraStorage', type: 'uint256' },
            ],
            outputs: [
              { name: 'fid', type: 'uint256' },
              { name: 'overpayment', type: 'uint256' },
            ],
          },
        ] as const,
        functionName: 'register',
        args: [CUSTODY_ADDRESS, 0n],
      }),
    );

    // The signing key installed is the one this device generated, for this FID.
    expect(node.installSigner).toHaveBeenCalledWith(
      expect.objectContaining({
        fid: 4242,
        signingKeyHex: `0x${'11'.repeat(32)}`,
      }),
    );
    expect(node.setProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        fid: 4242,
        username: 'fiddy',
        displayName: 'Fiddy',
      }),
    );
    expect(names.posts[0]?.body).toMatchObject({
      name: 'fiddy',
      to: 4242,
      fid: 4242,
    });

    // And the key that was installed is also kept here, because that is the only
    // place the write path looks for it: an account whose key was installed and
    // not stored is an account this browser cannot post from.
    expect(deviceStore.get('snapchain_app_key_4242')).toBe(
      `0x${'11'.repeat(32)}`,
    );
  });

  it('never trusts a signature-supplying signer that is not the custody account', async () => {
    const { fetchImpl } = chain();
    const { account } = custody();
    const other: RegistrationSigner = {
      address: '0x4444444444444444444444444444444444444444' as `0x${string}`,
      signTransaction: vi.fn(
        async (_transaction: unknown) => RAW_TX as `0x${string}`,
      ),
    };
    const node = fakeNode();

    await createAccountOnChain({
      rpcUrl: 'http://rpc.test',
      custody: account,
      signer: other,
      fetchImpl,
      node: node.port,
      signingKeyHex: `0x${'11'.repeat(32)}`,
      sleep: instantSleep,
    });

    // The recovery address still names the account, not whoever paid.
    const signed = (other.signTransaction as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;

    expect(signed.data).toContain(CUSTODY_ADDRESS.slice(2));
  });

  it('says so plainly when this address already has an account', async () => {
    const { fetchImpl } = chain({ fidNow: 4242 });
    const { account } = custody();

    await expect(
      createAccountOnChain({
        rpcUrl: 'http://rpc.test',
        custody: account,
        fetchImpl,
        node: fakeNode().port,
        signingKeyHex: `0x${'11'.repeat(32)}`,
        sleep: instantSleep,
      }),
    ).rejects.toThrow(/already registered/);
  });
});

describe('after registration', () => {
  it('waits for the node to see the account before adding a key to it', async () => {
    const { fetchImpl } = chain({ fidNow: 4242 });
    const { account } = custody();
    const node = fakeNode({ seesFid: false });

    await expect(
      finishAccountSetup({
        rpcUrl: 'http://rpc.test',
        custody: account,
        node: node.port,
        signingKeyHex: `0x${'11'.repeat(32)}`,
        attempts: 3,
        retryMs: 0,
        sleep: instantSleep,
        fetchImpl,
      }),
    ).rejects.toThrow(/hasn't caught up yet/);

    expect(node.installSigner).not.toHaveBeenCalled();
    expect(node.readUser).toHaveBeenCalledTimes(3);
  });

  it('keeps a working account when the @name is taken', async () => {
    const { fetchImpl } = chain({ fidNow: 4242 });
    const { account } = custody();
    const node = fakeNode();
    const names = fnameFetch({ takenBy: 99 });

    const result = await finishAccountSetup({
      rpcUrl: 'http://rpc.test',
      custody: account,
      node: node.port,
      signingKeyHex: `0x${'11'.repeat(32)}`,
      username: 'fiddy',
      displayName: 'Fiddy',
      sleep: instantSleep,
      fetchImpl,
      nameFetchImpl: names.fetchImpl,
    });

    expect(result.fid).toBe(4242);
    expect(result.completed).toEqual(['signer', 'profile']);
    expect(result.warning).toBe('@fiddy is already taken');
    expect(names.posts).toHaveLength(0);
  });

  it('says the profile did not land rather than pretending it did', async () => {
    const { fetchImpl } = chain({ fidNow: 4242 });
    const { account } = custody();
    const node = fakeNode({ profileWriteFails: true });

    const result = await finishAccountSetup({
      rpcUrl: 'http://rpc.test',
      custody: account,
      node: node.port,
      signingKeyHex: `0x${'11'.repeat(32)}`,
      displayName: 'Fiddy',
      sleep: instantSleep,
      fetchImpl,
    });

    expect(result.completed).toEqual(['signer']);
    expect(result.warning).toMatch(/did not reach your profile yet/);
  });

  it("reports a refused name claim in the registry's own words", async () => {
    const { fetchImpl } = chain({ fidNow: 4242 });
    const { account } = custody();
    const names = fnameFetch({ claimStatus: 400 });

    const result = await finishAccountSetup({
      rpcUrl: 'http://rpc.test',
      custody: account,
      node: fakeNode().port,
      signingKeyHex: `0x${'11'.repeat(32)}`,
      username: 'fiddy',
      sleep: instantSleep,
      fetchImpl,
      nameFetchImpl: names.fetchImpl,
    });

    // The account works: the posting key is on it and the profile was written.
    // Only the @name is missing, and that is what the warning says.
    expect(result.completed).toEqual(['signer', 'profile']);
    expect(result.warning).toMatch(/name registry refused/);
  });

  it("queries the IdRegistry for the FID it just registered, not the node's word", async () => {
    const { fetchImpl, state } = chain({ fidNow: 4242 });
    const { account } = custody();

    await finishAccountSetup({
      rpcUrl: 'http://rpc.test',
      custody: account,
      node: fakeNode().port,
      signingKeyHex: `0x${'11'.repeat(32)}`,
      sleep: instantSleep,
      fetchImpl,
    });

    const registryCalls = state.calls.filter(
      (call) => call.to === ID_REGISTRY_ADDRESS,
    );

    expect(registryCalls.length).toBeGreaterThan(0);
  });

  it('keeps the posting key on this device, so the account still posts after a reload', async () => {
    const { fetchImpl } = chain({ fidNow: 4242 });
    const { account } = custody();
    const node = fakeNode({ nextNonce: 8 });

    const result = await finishAccountSetup({
      rpcUrl: 'http://rpc.test',
      custody: account,
      node: node.port,
      signingKeyHex: DEVICE_KEY,
      sleep: instantSleep,
      fetchImpl,
    });

    expect(result.completed).toContain('signer');

    // Read back the way a reload does — through the store the write path uses,
    // by the keys it derives from the FID.
    expect(deviceStore.get('snapchain_app_key_4242')).toBe(DEVICE_KEY);
    expect(deviceStore.get('snapchain_app_nonce_4242')).toBe(8);
  });

  it('stores the nonce the node reported after the KEY_ADD, not the one it started at', async () => {
    const { fetchImpl } = chain({ fidNow: 4242 });
    const { account } = custody();
    const keyStore: AccountKeyStore = {
      saveAppKey: vi.fn(async () => undefined),
      saveAppNonce: vi.fn(async () => undefined),
    };

    await finishAccountSetup({
      rpcUrl: 'http://rpc.test',
      custody: account,
      node: fakeNode({ nextNonce: 12 }).port,
      signingKeyHex: DEVICE_KEY,
      sleep: instantSleep,
      fetchImpl,
      keyStore,
    });

    expect(keyStore.saveAppKey).toHaveBeenCalledWith(4242, DEVICE_KEY);
    expect(keyStore.saveAppNonce).toHaveBeenCalledWith(4242, 12);
  });

  it('does not call the account ready when this device could not save the key', async () => {
    const { fetchImpl } = chain({ fidNow: 4242 });
    const { account } = custody();
    const keyStore: AccountKeyStore = {
      saveAppKey: vi.fn(async () => {
        throw new Error('storage is full');
      }),
      saveAppNonce: vi.fn(async () => undefined),
    };

    await expect(
      finishAccountSetup({
        rpcUrl: 'http://rpc.test',
        custody: account,
        node: fakeNode().port,
        signingKeyHex: DEVICE_KEY,
        sleep: instantSleep,
        fetchImpl,
        keyStore,
      }),
    ).rejects.toThrow(/could not save the key that posts for it/);
  });
});

describe('the name registry endpoint', () => {
  it('is the one the client reaches', () => {
    expect(FNAME_REGISTRY_URL).toBe('https://fnames.farcaster.xyz');
  });
});
