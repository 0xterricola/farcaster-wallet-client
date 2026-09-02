// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalSolanaWalletSend } from '~/components/rightSidebar/ExternalSolanaWalletSend';

const {
  prepareSolanaTransfer,
  submitSignedSolanaTransaction,
  waitForSolanaConfirmation,
} = vi.hoisted(() => ({
  prepareSolanaTransfer: vi.fn(),
  submitSignedSolanaTransaction: vi.fn(),
  waitForSolanaConfirmation: vi.fn(),
}));

vi.mock('~/hooks/useSolanaBalance', () => ({
  useSolanaBalance: () => ({ data: 2_000_000_000 }),
}));

vi.mock('~/hooks/useSolanaTokenPortfolio', () => ({
  useSolanaTokenPortfolio: () => ({
    data: [
      {
        amount: '2500000',
        decimals: 6,
        mint: 'UsdcMint',
        name: 'USD Coin',
        programId: 'TokenProgram',
        recognized: true,
        symbol: 'USDC',
        tokenAccounts: [{ address: 'UsdcAccount', amount: '2500000' }],
      },
    ],
  }),
}));

vi.mock('~/utils/solanaTransfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/solanaTransfer')>()),
  prepareSolanaTransfer,
  submitSignedSolanaTransaction,
  waitForSolanaConfirmation,
}));

vi.mock('~/components/forms/buttons/DefaultButton', () => ({
  DefaultButton: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

function view(signTransaction = vi.fn()) {
  render(
    <ExternalSolanaWalletSend
      address="11111111111111111111111111111111"
      onBack={vi.fn()}
      signTransaction={signTransaction}
    />,
    { wrapper: Wrapper },
  );
  return { signTransaction };
}

function enterTransfer() {
  fireEvent.change(screen.getByPlaceholderText('Solana wallet address'), {
    target: { value: 'RecipientAddress' },
  });
  fireEvent.change(screen.getByPlaceholderText('0'), {
    target: { value: '0.25' },
  });
}

describe('ExternalSolanaWalletSend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareSolanaTransfer.mockResolvedValue({
      amountBaseUnits: 250_000_000n,
      feeLamports: 5_000,
      recipientMinimumLamports: 0,
      rentLamports: 0,
      transaction: new Uint8Array([1, 2, 3]),
    });
    submitSignedSolanaTransaction.mockResolvedValue('SolanaSignature');
    waitForSolanaConfirmation.mockResolvedValue(undefined);
  });

  it('offers native SOL and recognized SPL tokens', () => {
    view();
    expect(screen.getByRole('option', { name: 'SOL' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'USDC' })).toBeTruthy();
    expect(screen.getByText('Available: 2 SOL')).toBeTruthy();
  });

  it('prepares an exact transfer before asking the wallet to sign', async () => {
    view();
    enterTransfer();
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));

    await waitFor(() => expect(prepareSolanaTransfer).toHaveBeenCalledOnce());
    expect(screen.getByText('0.000005 SOL')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('signs, submits with preflight, and confirms before reporting success', async () => {
    const signTransaction = vi
      .fn()
      .mockResolvedValue(new Uint8Array([4, 5, 6]));
    view(signTransaction);
    enterTransfer();
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    await screen.findByRole('button', { name: 'Send' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(waitForSolanaConfirmation).toHaveBeenCalled());
    expect(signTransaction).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(submitSignedSolanaTransaction).toHaveBeenCalledWith(
      new Uint8Array([4, 5, 6]),
    );
    expect(
      screen.getByRole('link', {
        name: 'View transaction on Solana Explorer',
      }),
    ).toBeTruthy();
  });

  it('shows preparation errors without opening the wallet', async () => {
    const signTransaction = vi.fn();
    prepareSolanaTransfer.mockRejectedValue(
      new Error('Insufficient SOL for the amount and network costs.'),
    );
    view(signTransaction);
    enterTransfer();
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));

    expect(
      await screen.findByText(
        'Insufficient SOL for the amount and network costs.',
      ),
    ).toBeTruthy();
    expect(signTransaction).not.toHaveBeenCalled();
  });
});
