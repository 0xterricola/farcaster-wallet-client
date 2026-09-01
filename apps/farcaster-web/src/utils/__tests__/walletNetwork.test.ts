import { arbitrum, base, mainnet } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import {
  addEthereumChainParameters,
  classifyWalletNetworkError,
  DASHBOARD_CHAINS,
  DEFAULT_WALLET_CHAIN_ID,
  parseWalletChainId,
  readWalletChainId,
  SELECTABLE_WALLET_CHAINS,
  walletChainCapabilities,
  walletNetworkName,
} from '~/utils/walletNetwork';

describe('wallet network configuration', () => {
  it('enables dashboard data for Base, Ethereum, and Arbitrum', () => {
    expect(DEFAULT_WALLET_CHAIN_ID).toBe(8453);
    expect([...DASHBOARD_CHAINS.keys()]).toEqual([8453, 1, 42161]);
    expect([...SELECTABLE_WALLET_CHAINS.keys()]).toEqual([8453, 1, 42161]);
  });

  it('keeps each network action behind explicit capabilities', () => {
    expect(walletChainCapabilities(base.id)).toEqual({
      read: true,
      send: true,
      swap: true,
    });
    expect(walletChainCapabilities(mainnet.id)).toEqual({
      read: true,
      send: true,
      swap: true,
    });
    expect(walletChainCapabilities(arbitrum.id)).toEqual({
      read: true,
      send: true,
      swap: false,
    });
    expect(walletChainCapabilities(123456)).toEqual({
      read: false,
      send: false,
      swap: false,
    });
  });

  it('builds exact add-chain parameters from the trusted chain definition', () => {
    expect(addEthereumChainParameters(base)).toEqual({
      chainId: '0x2105',
      chainName: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org'],
    });
  });

  it.each([
    [1, 'Ethereum'],
    [56, 'BNB Smart Chain'],
    [143, 'Monad'],
    [8453, 'Base'],
    [999, 'HyperEVM'],
    [4663, 'Robinhood Chain'],
    [42161, 'Arbitrum One'],
    [42220, 'Celo'],
  ])('recognizes planned network %s as %s', (chainId, name) => {
    expect(walletNetworkName(chainId)).toBe(name);
  });

  it('uses a debuggable label for an unknown chain', () => {
    expect(walletNetworkName(123456)).toBe('Chain 123456');
  });
});

describe('wallet chain ID parsing', () => {
  it.each([
    ['0x2105', 8453],
    ['8453', 8453],
    [8453, 8453],
    [8453n, 8453],
    ['0X2105', 8453],
  ])('parses %s', (input, expected) => {
    expect(parseWalletChainId(input)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    '',
    'Base',
    '0x',
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid value %s', (input) =>
    expect(parseWalletChainId(input)).toBeUndefined(),
  );

  it('reads and validates the provider chain ID', async () => {
    const provider = { request: async () => '0x2105' };
    await expect(readWalletChainId(provider as never)).resolves.toBe(8453);
  });

  it('rejects a malformed provider response', async () => {
    const provider = { request: async () => 'surprise' };
    await expect(readWalletChainId(provider as never)).rejects.toThrow(
      'invalid chain ID',
    );
  });
});

describe('wallet network error classification', () => {
  it.each([
    [{ code: 4001 }, 'rejected'],
    [{ cause: { message: 'User denied the request' } }, 'rejected'],
    [{ code: 4902 }, 'network_not_added'],
    [{ details: 'Unrecognized chain ID' }, 'network_not_added'],
    [{ code: -32601 }, 'method_unsupported'],
    [{ message: 'Wallet does not support this method' }, 'method_unsupported'],
    [{ message: 'Transport offline' }, 'switch_failed'],
  ] as const)('classifies %#', (error, kind) => {
    expect(classifyWalletNetworkError(error, 8453)).toMatchObject({
      kind,
      requestedChainId: 8453,
    });
  });

  it('handles cyclic causes safely', () => {
    const error: { message: string; cause?: unknown } = { message: 'offline' };
    error.cause = error;
    expect(classifyWalletNetworkError(error, 8453).kind).toBe('switch_failed');
  });
});
