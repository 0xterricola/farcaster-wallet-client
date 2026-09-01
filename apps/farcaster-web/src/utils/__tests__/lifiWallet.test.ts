import { PublicClient, zeroAddress } from 'viem';
import { base, bsc, celo } from 'viem/chains';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BASE_NATIVE_TOKEN,
  CELO_NATIVE_TOKEN_ADDRESS,
  createLifiNativeToken,
  fetchLifiToken,
  fetchLifiWalletTokens,
  formatLifiBalance,
  isNativeWalletAsset,
  lifiAssetUsd,
  lifiBalanceKey,
  normalizeLifiAddress,
  parseLifiToken,
  readLifiAsset,
  requestLifi,
} from '~/utils/lifiWallet';

const wallet = '0x1111111111111111111111111111111111111111';
const token = {
  chainId: 8453,
  address: '0x2222222222222222222222222222222222222222' as const,
  symbol: 'TOKEN',
  name: 'Token',
  decimals: 6,
  priceUSD: '2',
  amount: '999999999999',
};

describe('native wallet asset aliases', () => {
  it('treats zero address as native on every EVM chain', () => {
    expect(isNativeWalletAsset(zeroAddress, base.id)).toBe(true);
    expect(isNativeWalletAsset(zeroAddress, celo.id)).toBe(true);
  });

  it('treats CeloToken as native only on Celo', () => {
    expect(isNativeWalletAsset(CELO_NATIVE_TOKEN_ADDRESS, celo.id)).toBe(true);
    expect(isNativeWalletAsset(CELO_NATIVE_TOKEN_ADDRESS, base.id)).toBe(false);
  });
});
const respond = (body: unknown, status = 200) => {
  const mock = vi
    .fn()
    .mockResolvedValue({ ok: status === 200, status, json: async () => body });
  vi.stubGlobal('fetch', mock);
  return mock;
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('LI.FI wallet data', () => {
  it('discovers only Base tokens and never copies indexed amounts into live balances', async () => {
    const fetch = respond({
      walletAddress: wallet,
      balances: { 8453: [token], 1: [{ ...token, chainId: 1 }] },
      limit: 1000,
    });
    const result = await fetchLifiWalletTokens(wallet);
    expect(result.tokens).toEqual([
      {
        chainId: 8453,
        address: token.address,
        symbol: 'TOKEN',
        name: 'Token',
        decimals: 6,
        priceUSD: 2,
      },
    ]);
    expect(result.tokens[0]).not.toHaveProperty('balance');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/wallets/${wallet}/balances?extended=true`),
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
  });
  it('treats a valid response without Base entries as empty', async () => {
    respond({ walletAddress: wallet, balances: {} });
    expect((await fetchLifiWalletTokens(wallet)).tokens).toEqual([]);
  });
  it.each([
    {},
    { walletAddress: wallet },
    { walletAddress: token.address, balances: {} },
    { walletAddress: wallet, balances: { 8453: {} } },
  ])(
    'does not present malformed or wrong-account responses as empty: %j',
    async (body) => {
      respond(body);
      await expect(fetchLifiWalletTokens(wallet)).rejects.toThrow();
    },
  );
  it('deduplicates contracts and reports partial responses', async () => {
    respond({
      walletAddress: wallet,
      balances: {
        8453: [
          token,
          token,
          { ...token, decimals: -1 },
          { ...token, chainId: 1 },
        ],
      },
      limit: 4,
    });
    const result = await fetchLifiWalletTokens(wallet);
    expect(result.tokens).toHaveLength(1);
    expect(result.skipped).toBe(2);
    expect(result.possiblyLimited).toBe(true);
  });
  it.each(['', 'garbage', '-2', 'Infinity'])(
    'treats price %s as unavailable, not zero',
    (priceUSD) => {
      expect(parseLifiToken({ ...token, priceUSD }).priceUSD).toBeUndefined();
    },
  );
  it('preserves genuine zero prices', () =>
    expect(parseLifiToken({ ...token, priceUSD: '0' }).priceUSD).toBe(0));
  it('normalizes native aliases without misidentifying WETH', () => {
    expect(normalizeLifiAddress('ETH')).toBe(zeroAddress);
    expect(
      normalizeLifiAddress('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'),
    ).toBe(zeroAddress);
    expect(
      normalizeLifiAddress('0x4200000000000000000000000000000000000006'),
    ).not.toBe(zeroAddress);
  });
  it('uses each chain native symbol without treating ETH as BNB', () => {
    expect(normalizeLifiAddress('BNB', 'BNB')).toBe(zeroAddress);
    expect(() => normalizeLifiAddress('ETH', 'BNB')).toThrow('BNB');
    expect(createLifiNativeToken(bsc)).toMatchObject({
      chainId: 56,
      address: zeroAddress,
      symbol: 'BNB',
      decimals: 18,
    });
  });
  it('parses and discovers only the explicitly requested chain', async () => {
    const bscToken = { ...token, chainId: 56, symbol: 'BSC-TOKEN' };
    respond({
      walletAddress: wallet,
      balances: { 8453: [token], 56: [bscToken] },
    });
    const result = await fetchLifiWalletTokens(wallet, undefined, 56, 'BNB');
    expect(result.tokens).toEqual([
      expect.objectContaining({ chainId: 56, symbol: 'BSC-TOKEN' }),
    ]);
    expect(() => parseLifiToken(token, 56, 'BNB')).toThrow('chain 56');
  });
  it('isolates wallet, token and balance cache keys by chain', () => {
    expect(lifiBalanceKey(wallet, token.address, 56, 'BNB')).not.toEqual(
      lifiBalanceKey(wallet, token.address, 8453, 'ETH'),
    );
  });
  it('rejects wrong contracts returned by token lookup', async () => {
    respond({ ...token, address: wallet });
    await expect(fetchLifiToken(token.address)).rejects.toThrow(
      'different token',
    );
  });
  it('surfaces rate limits as errors', async () => {
    respond({}, 429);
    await expect(fetchLifiWalletTokens(wallet)).rejects.toThrow(
      'rate limiting',
    );
  });
  it('forwards cancellation to the HTTP request', async () => {
    const fetch = respond({});
    const controller = new AbortController();
    controller.abort();
    await requestLifi('/token', controller.signal);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('uses exact integer units and live balances for valuation', async () => {
    const readContract = vi
      .fn()
      .mockImplementation(({ functionName }) =>
        Promise.resolve(
          functionName === 'decimals' ? 6 : 9007199254740993000001n,
        ),
      );
    const client = { chain: base, readContract } as unknown as PublicClient;
    const asset = await readLifiAsset(client, wallet, parseLifiToken(token));
    expect(formatLifiBalance(asset)).toBe('9007199254740993.000001');
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: token.address,
        functionName: 'balanceOf',
        args: [wallet],
      }),
    );
    expect(lifiAssetUsd({ ...asset, balance: 1000000n })).toBe(2);
    expect(lifiAssetUsd({ ...asset, priceUSD: undefined })).toBeUndefined();
  });
  it('keeps live zero as zero even when LI.FI indexed a positive holding', async () => {
    const client = {
      chain: base,
      readContract: vi
        .fn()
        .mockImplementation(({ functionName }) =>
          Promise.resolve(functionName === 'decimals' ? 6 : 0n),
        ),
    } as unknown as PublicClient;
    expect(
      (await readLifiAsset(client, wallet, parseLifiToken(token))).balance,
    ).toBe(0n);
  });
  it('reads native and ERC-20 balances with the requested chain RPC', async () => {
    const bscToken = parseLifiToken({ ...token, chainId: 56 }, 56, 'BNB');
    const client = {
      chain: bsc,
      readContract: vi
        .fn()
        .mockImplementation(({ functionName }) =>
          Promise.resolve(functionName === 'decimals' ? 6 : 42n),
        ),
    } as unknown as PublicClient;
    await expect(
      readLifiAsset(client, wallet, bscToken),
    ).resolves.toMatchObject({ chainId: 56, balance: 42n });
    await expect(
      readLifiAsset(
        { chain: base } as unknown as PublicClient,
        wallet,
        createLifiNativeToken(bsc),
      ),
    ).rejects.toThrow('chain 56');
  });
  it('rejects RPC errors and decimals mismatches instead of returning zero', async () => {
    const readContract = vi.fn().mockRejectedValue(new Error('offline'));
    const client = { chain: base, readContract } as unknown as PublicClient;
    await expect(
      readLifiAsset(client, wallet, parseLifiToken(token)),
    ).rejects.toThrow('offline');
    readContract.mockResolvedValue(18);
    await expect(
      readLifiAsset(client, wallet, parseLifiToken(token)),
    ).rejects.toThrow('decimals');
  });
  it('scopes every balance to chain, wallet and contract', async () => {
    expect(lifiBalanceKey(wallet, token.address)).not.toEqual(
      lifiBalanceKey(token.address, token.address),
    );
    expect(lifiBalanceKey(wallet, token.address)).not.toEqual(
      lifiBalanceKey(wallet, zeroAddress),
    );
    await expect(
      readLifiAsset(
        { chain: { id: 1 } } as PublicClient,
        wallet,
        BASE_NATIVE_TOKEN,
      ),
    ).rejects.toThrow('chain 8453');
  });
});
