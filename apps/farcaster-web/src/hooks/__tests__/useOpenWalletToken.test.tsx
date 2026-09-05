// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOpenWalletToken } from '~/hooks/useOpenWalletToken';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openWalletTradeIntent: vi.fn(),
  preferredWallet: 'injected' as string | undefined,
}));

vi.mock('~/components/EmbeddedWallet', () => ({
  useOptionalEmbeddedWalletBridge: () => ({ navigate: mocks.navigate }),
}));
vi.mock('~/contexts/MinimizableWindowProvider', () => ({
  useMinimizableWindowContext: () => ({
    openWalletTradeIntent: mocks.openWalletTradeIntent,
  }),
}));
vi.mock('~/contexts/WalletProvider', () => ({
  useWallet: () => ({ preferredWallet: mocks.preferredWallet }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preferredWallet = 'injected';
});

describe('useOpenWalletToken', () => {
  it('routes supported tokens into the external wallet trade screen', () => {
    const { result } = renderHook(() => useOpenWalletToken());
    expect(
      result.current({
        ca: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        chain: 'base',
        via: 'cast_embed',
      }),
    ).toBe(true);
    expect(mocks.openWalletTradeIntent).toHaveBeenCalledWith({
      family: 'evm',
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('keeps Farcaster Wallet token navigation unchanged', () => {
    mocks.preferredWallet = 'warpcast';
    const { result } = renderHook(() => useOpenWalletToken());
    expect(
      result.current({
        ca: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        chain: 'base',
        via: 'cast_embed',
      }),
    ).toBe(true);
    expect(mocks.navigate).toHaveBeenCalledWith({
      path: 'Token',
      params: {
        ca: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        chain: 'base',
        via: 'cast_embed',
      },
    });
    expect(mocks.openWalletTradeIntent).not.toHaveBeenCalled();
  });

  it('does not guess how to route unsupported external-wallet chains', () => {
    const { result } = renderHook(() => useOpenWalletToken());
    expect(
      result.current({
        ca: '0x4200000000000000000000000000000000000042',
        chain: 'optimism',
        via: 'cast_embed',
      }),
    ).toBe(false);
    expect(mocks.openWalletTradeIntent).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
