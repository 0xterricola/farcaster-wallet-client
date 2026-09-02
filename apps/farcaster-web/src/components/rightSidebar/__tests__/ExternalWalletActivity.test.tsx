// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Address, Hash } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalWalletActivity } from '~/components/rightSidebar/ExternalWalletActivity';
import {
  recordPendingWalletActivity,
  WalletActivity,
} from '~/utils/walletActivity';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('~/hooks/useWalletActivity', () => ({
  useWalletActivity: mocks.query,
}));

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const activity = (
  character: string,
  timestamp: number,
  type: WalletActivity['type'] = 'send',
): WalletActivity => ({
  chainId: base.id,
  address: wallet,
  hash: `0x${character.repeat(64)}` as Hash,
  type,
  status: 'confirmed',
  timestamp,
  fromAsset: { symbol: 'ETH', value: '1000000000000000', decimals: 18 },
  ...(type === 'swap'
    ? {
        toAsset: { symbol: 'USDC', value: '2500000', decimals: 6 },
      }
    : {}),
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.query.mockReturnValue({
    data: [],
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
  });
});

afterEach(cleanup);

describe('ExternalWalletActivity', () => {
  it('shows a chain-specific loading state', () => {
    mocks.query.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      isFetching: true,
      refetch: mocks.refetch,
    });
    render(<ExternalWalletActivity address={wallet} chain={base} />);
    expect(screen.getByRole('status').textContent).toContain(
      'Loading Base activity',
    );
  });

  it('shows only five recent transactions with transaction and address links', () => {
    mocks.query.mockReturnValue({
      data: [
        activity('a', 6),
        activity('b', 5, 'swap'),
        activity('c', 4, 'receive'),
        activity('d', 3, 'approval'),
        activity('e', 2, 'contract'),
        activity('f', 1),
      ],
      isPending: false,
      isError: false,
      isFetching: false,
      refetch: mocks.refetch,
    });
    render(<ExternalWalletActivity address={wallet} chain={base} />);
    expect(screen.getAllByRole('link')).toHaveLength(6);
    expect(screen.getByText('0.001 ETH → 2.5 USDC')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: /View all on Basescan/ })
        .getAttribute('href'),
    ).toBe(`https://basescan.org/address/${wallet}`);
  });

  it('keeps locally submitted activity visible when the indexer fails', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    recordPendingWalletActivity({
      chainId: base.id,
      address: wallet,
      hash: `0x${'a'.repeat(64)}` as Hash,
      type: 'send',
      fromAsset: { symbol: 'ETH', value: '1', decimals: 18 },
    });
    mocks.query.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      isFetching: false,
      error: new Error('Complete explorer history is temporarily unavailable.'),
      refetch: mocks.refetch,
    });
    render(<ExternalWalletActivity address={wallet} chain={base} />);
    expect(screen.getByRole('alert').textContent).toContain(
      'Showing activity saved by this client',
    );
    expect(screen.getByText('Pending')).toBeTruthy();
  });

  it('shows the empty state and supports manual refresh', () => {
    render(<ExternalWalletActivity address={wallet} chain={base} />);
    expect(screen.getByText('No recent activity found on Base.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
