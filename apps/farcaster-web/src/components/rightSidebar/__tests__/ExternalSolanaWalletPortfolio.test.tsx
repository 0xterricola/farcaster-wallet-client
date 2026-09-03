// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalSolanaWalletPortfolio } from '~/components/rightSidebar/ExternalSolanaWalletPortfolio';

const refetch = vi.fn();
const usePortfolio = vi.fn();

vi.mock('~/hooks/useSolanaTokenPortfolio', () => ({
  useSolanaTokenPortfolio: () => usePortfolio(),
}));

vi.mock('~/components/forms/buttons/DefaultButton', () => ({
  DefaultButton: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

describe('ExternalSolanaWalletPortfolio', () => {
  beforeEach(() => {
    refetch.mockReset();
    usePortfolio.mockReset();
  });

  it('shows an accessible loading state before token discovery finishes', () => {
    usePortfolio.mockReturnValue({
      data: undefined,
      isError: false,
      isFetching: true,
      isPending: true,
      refetch,
    });
    render(<ExternalSolanaWalletPortfolio address="SolanaAddress" />);
    expect(screen.getByRole('status').textContent).toContain(
      'Loading Solana tokens',
    );
  });

  it('shows recognized tokens and excludes unrecognized assets by default', () => {
    usePortfolio.mockReturnValue({
      data: [
        {
          amount: '2500000',
          decimals: 6,
          mint: 'UsdcMintAddress',
          name: 'USD Coin',
          priceUSD: 1,
          recognized: true,
          symbol: 'USDC',
        },
        {
          amount: '7',
          decimals: 0,
          mint: 'UnknownMintAddress',
          name: 'Unrecognized SPL token',
          recognized: false,
          symbol: 'Unkn…ress',
        },
      ],
      isError: false,
      isFetching: false,
      isPending: false,
      refetch,
    });
    render(<ExternalSolanaWalletPortfolio address="SolanaAddress" />);

    expect(screen.getByText('USDC')).toBeTruthy();
    expect(screen.getByText('2.5')).toBeTruthy();
    expect(screen.queryByText('Unkn…ress')).toBeNull();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Show unrecognized tokens (1)' }),
    );
    expect(screen.getAllByText('Unkn…ress')).toHaveLength(2);
    expect(screen.getByText('Unrecognized')).toBeTruthy();
  });

  it('explains a valid empty portfolio without repeating native SOL', () => {
    usePortfolio.mockReturnValue({
      data: [],
      isError: false,
      isFetching: false,
      isPending: false,
      refetch,
    });
    render(<ExternalSolanaWalletPortfolio address="SolanaAddress" />);
    expect(
      screen.getByText(/No recognized non-zero SPL/).textContent,
    ).toContain('Native SOL is shown above');
  });

  it('offers retry when token discovery fails', () => {
    usePortfolio.mockReturnValue({
      data: undefined,
      isError: true,
      isFetching: false,
      isPending: false,
      refetch,
    });
    render(<ExternalSolanaWalletPortfolio address="SolanaAddress" />);
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not load SPL tokens',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tokens' }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});
