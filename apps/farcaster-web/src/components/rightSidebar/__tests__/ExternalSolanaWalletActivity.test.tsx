// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalSolanaWalletActivity } from '~/components/rightSidebar/ExternalSolanaWalletActivity';
import { SolanaActivity } from '~/utils/solanaActivity';

const refetch = vi.fn();
const useActivity = vi.fn();

vi.mock('~/hooks/useSolanaActivity', () => ({
  useSolanaActivity: () => useActivity(),
}));

const activity = (overrides: Partial<SolanaActivity> = {}): SolanaActivity => ({
  counterparty: undefined,
  receivedAsset: undefined,
  sentAsset: undefined,
  signature: 'Sig1111111111111111111111111111111111111111111111111111111111111',
  slot: 100,
  status: 'success',
  timestamp: 1_700_000_000,
  type: 'unknown',
  ...overrides,
});

describe('ExternalSolanaWalletActivity', () => {
  beforeEach(() => {
    refetch.mockReset();
    useActivity.mockReset();
  });

  it('shows a loading state before the first page resolves', () => {
    useActivity.mockReturnValue({
      data: undefined,
      error: undefined,
      isError: false,
      isFetching: true,
      isPending: true,
      refetch,
    });
    render(<ExternalSolanaWalletActivity address="SolanaAddress" />);
    expect(screen.getByRole('status').textContent).toContain(
      'Loading Solana activity',
    );
  });

  it('shows a send, a receive, and a swap with distinct labels', () => {
    useActivity.mockReturnValue({
      data: [
        activity({
          sentAsset: {
            amount: '100000000',
            decimals: 9,
            mint: undefined,
          },
          type: 'send',
        }),
        activity({
          receivedAsset: {
            amount: '2500000',
            decimals: 6,
            mint: 'UsdcMintAddress',
          },
          signature: 'Sig2',
          type: 'receive',
        }),
        activity({
          receivedAsset: {
            amount: '2500000',
            decimals: 6,
            mint: 'UsdcMintAddress',
          },
          sentAsset: {
            amount: '100000000',
            decimals: 9,
            mint: undefined,
          },
          signature: 'Sig3',
          type: 'swap',
        }),
      ],
      error: undefined,
      isError: false,
      isFetching: false,
      isPending: false,
      refetch,
    });
    render(<ExternalSolanaWalletActivity address="SolanaAddress" />);

    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.getByText('0.1 SOL')).toBeTruthy();
    expect(screen.getByText('Received')).toBeTruthy();
    expect(screen.getByText('2.5 Usdc…ress')).toBeTruthy();
    expect(screen.getByText('Swap')).toBeTruthy();
    expect(screen.getByText('0.1 SOL → 2.5 Usdc…ress')).toBeTruthy();
  });

  it('explains an empty history without implying something is broken', () => {
    useActivity.mockReturnValue({
      data: [],
      error: undefined,
      isError: false,
      isFetching: false,
      isPending: false,
      refetch,
    });
    render(<ExternalSolanaWalletActivity address="SolanaAddress" />);
    expect(
      screen.getByText('No recent activity found on Solana Mainnet.'),
    ).toBeTruthy();
  });

  it('offers retry when activity fails to load', () => {
    useActivity.mockReturnValue({
      data: undefined,
      error: new Error('Solana RPC returned an error.'),
      isError: true,
      isFetching: false,
      isPending: false,
      refetch,
    });
    render(<ExternalSolanaWalletActivity address="SolanaAddress" />);
    expect(screen.getByRole('alert').textContent).toContain(
      'Solana RPC returned an error.',
    );
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('marks a failed transaction distinctly from a confirmed one', () => {
    useActivity.mockReturnValue({
      data: [activity({ status: 'failed', type: 'send' })],
      error: undefined,
      isError: false,
      isFetching: false,
      isPending: false,
      refetch,
    });
    render(<ExternalSolanaWalletActivity address="SolanaAddress" />);
    expect(screen.getByText('Failed')).toBeTruthy();
  });
});
