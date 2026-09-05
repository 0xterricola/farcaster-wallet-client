// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalSolanaWalletSwap } from '~/components/rightSidebar/ExternalSolanaWalletSwap';
import { SOLANA_NATIVE_MINT, SOLANA_USDC_MINT } from '~/utils/solanaSwap';

const fetchQuote = vi.fn();
const decodeTransaction = vi.fn(
  (_data: string, _wallet: string) => new Uint8Array([1, 2, 3]),
);
const simulateTransaction = vi.fn();
const submitTransaction = vi.fn();
const waitForConfirmation = vi.fn();
const invalidateQueries = vi.fn();
const useBalance = vi.fn();
const usePortfolio = vi.fn();

vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock('~/hooks/useSolanaBalance', () => ({
  useSolanaBalance: () => useBalance(),
}));
vi.mock('~/hooks/useSolanaTokenPortfolio', () => ({
  useSolanaTokenPortfolio: () => usePortfolio(),
}));
vi.mock('~/utils/solanaSwap', async (original) => ({
  ...(await original<typeof import('~/utils/solanaSwap')>()),
  decodeLifiSolanaTransaction: (data: string, wallet: string) =>
    decodeTransaction(data, wallet),
  fetchLifiSolanaQuote: (...args: unknown[]) => fetchQuote(...args),
}));
vi.mock('~/utils/solanaTransfer', async (original) => ({
  ...(await original<typeof import('~/utils/solanaTransfer')>()),
  simulateSolanaTransaction: (...args: unknown[]) =>
    simulateTransaction(...args),
  submitSignedSolanaTransaction: (...args: unknown[]) =>
    submitTransaction(...args),
  waitForSolanaConfirmation: (...args: unknown[]) =>
    waitForConfirmation(...args),
}));
vi.mock('~/components/forms/buttons/DefaultButton', () => ({
  DefaultButton: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

const usdc = {
  amount: '2500000',
  decimals: 6,
  mint: SOLANA_USDC_MINT,
  name: 'USD Coin',
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  recognized: true,
  symbol: 'USDC',
  tokenAccounts: [],
};

beforeEach(() => {
  fetchQuote.mockReset();
  decodeTransaction.mockClear();
  simulateTransaction.mockReset();
  submitTransaction.mockReset();
  waitForConfirmation.mockReset();
  invalidateQueries.mockReset();
  submitTransaction.mockResolvedValue('signature');
  useBalance.mockReturnValue({ data: 25_000_000 });
  usePortfolio.mockReturnValue({ data: [usdc] });
});

afterEach(() => vi.restoreAllMocks());

function renderSwap(signTransaction = vi.fn()) {
  render(
    <ExternalSolanaWalletSwap
      address="wallet"
      onBack={vi.fn()}
      signTransaction={signTransaction}
    />,
  );
  return signTransaction;
}

const embeddedToken = {
  amount: '0',
  decimals: 6,
  mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6m2qGxvAEP6vLh5S',
  name: 'Bonk',
  symbol: 'BONK',
};

function quotedSwap(overrides: Record<string, unknown> = {}) {
  return {
    amount: 10_000_000n,
    quote: {
      action: {},
      estimate: {
        gasCosts: [
          {
            amount: '39669',
            token: { address: SOLANA_NATIVE_MINT, decimals: 9 },
          },
        ],
        toAmount: '996569',
        toAmountMin: '991586',
      },
      tool: 'fly',
      transactionRequest: { data: btoa('transaction') },
      ...overrides,
    },
  };
}

describe('ExternalSolanaWalletSwap', () => {
  it('prefills an embedded token even when it is not in the wallet portfolio', () => {
    render(
      <ExternalSolanaWalletSwap
        address="wallet"
        initialBuyToken={embeddedToken}
        onBack={vi.fn()}
        signTransaction={vi.fn()}
      />,
    );
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[1].value).toBe(embeddedToken.mint);
    expect(screen.getByRole('option', { name: 'BONK' })).toBeTruthy();
    expect(fetchQuote).not.toHaveBeenCalled();
  });

  it('offers SOL and recognized SPL assets with USDC as the default output', () => {
    renderSwap();
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[0].value).toBe(SOLANA_NATIVE_MINT);
    expect(selects[1].value).toBe(SOLANA_USDC_MINT);
    expect(screen.getByText('Available: 0.025 SOL')).toBeTruthy();
  });

  it('shows the verified quote output, minimum, route, and fee', async () => {
    fetchQuote.mockResolvedValue(quotedSwap());
    renderSwap();
    fireEvent.change(screen.getByPlaceholderText('0'), {
      target: { value: '0.01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));

    await waitFor(() => expect(screen.getByText('Review quote')).toBeTruthy());
    expect(screen.getByText('0.996569 USDC')).toBeTruthy();
    expect(screen.getByText('0.991586 USDC')).toBeTruthy();
    expect(screen.getByText('fly')).toBeTruthy();
    expect(screen.getByText('0.000039669 SOL')).toBeTruthy();
    expect(fetchQuote).toHaveBeenCalledWith(
      'wallet',
      expect.objectContaining({ mint: SOLANA_NATIVE_MINT }),
      expect.objectContaining({ mint: SOLANA_USDC_MINT }),
      '0.01',
    );
  });

  it('surfaces quote failures without showing a review', async () => {
    fetchQuote.mockRejectedValue(new Error('LI.FI request failed (400).'));
    renderSwap();
    fireEvent.change(screen.getByPlaceholderText('0'), {
      target: { value: '0.01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'LI.FI request failed (400).',
    );
  });

  it('refreshes, simulates, signs, submits, and confirms a reviewed quote', async () => {
    fetchQuote.mockResolvedValue(quotedSwap());
    const signTransaction = renderSwap(
      vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
    );
    fireEvent.change(screen.getByPlaceholderText('0'), {
      target: { value: '0.01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByText('Review quote');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));

    await waitFor(() =>
      expect(screen.getByText('Swap confirmed.')).toBeTruthy(),
    );
    expect(fetchQuote).toHaveBeenCalledTimes(1);
    expect(decodeTransaction).toHaveBeenCalledWith(
      btoa('transaction'),
      'wallet',
    );
    expect(simulateTransaction).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(signTransaction).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(submitTransaction).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]));
    expect(waitForConfirmation).toHaveBeenCalledWith('signature');
    expect(
      screen.getByRole('link', { name: 'View swap on Solana Explorer' }),
    ).toBeTruthy();
  });

  it('requires acknowledgement when network cost exceeds output value', async () => {
    fetchQuote.mockResolvedValue(
      quotedSwap({
        estimate: {
          gasCosts: [
            {
              amount: '21872',
              amountUSD: '0.0022',
              token: { address: SOLANA_NATIVE_MINT, decimals: 9 },
            },
          ],
          toAmount: '18164',
          toAmountMin: '18074',
          toAmountUSD: '0.0018',
        },
      }),
    );
    renderSwap();
    fireEvent.change(screen.getByPlaceholderText('0'), {
      target: { value: '0.01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));

    const warning = await screen.findByText('High network cost:');
    expect(warning).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Swap anyway' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I understand and still want to swap.',
      }),
    );
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('returns to review when a refreshed quote becomes uneconomical', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    fetchQuote.mockResolvedValueOnce(quotedSwap()).mockResolvedValueOnce(
      quotedSwap({
        estimate: {
          gasCosts: [{ amountUSD: '0.003' }],
          toAmount: '996569',
          toAmountMin: '991586',
          toAmountUSD: '0.002',
        },
      }),
    );
    const signTransaction = renderSwap();
    fireEvent.change(screen.getByPlaceholderText('0'), {
      target: { value: '0.01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByText('Review quote');
    now.mockReturnValue(17_000);
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));

    expect(await screen.findByText('High network cost:')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Network costs now exceed',
    );
    expect(
      screen
        .getByRole('button', { name: 'Swap anyway' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('reviews a changed stale quote once and then executes without a refresh loop', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    fetchQuote.mockResolvedValueOnce(quotedSwap()).mockResolvedValueOnce(
      quotedSwap({
        estimate: {
          toAmount: '995000',
          toAmountMin: '990000',
        },
      }),
    );
    const signTransaction = renderSwap(
      vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
    );
    fireEvent.change(screen.getByPlaceholderText('0'), {
      target: { value: '0.01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByText('Review quote');
    now.mockReturnValue(17_000);
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Quote updated',
    );
    expect(screen.getByText('0.99 USDC')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));

    await waitFor(() =>
      expect(screen.getByText('Swap confirmed.')).toBeTruthy(),
    );
    expect(fetchQuote).toHaveBeenCalledTimes(2);
    expect(signTransaction).toHaveBeenCalledOnce();
  });

  it('returns to editable trade inputs when the wallet rejects signing', async () => {
    fetchQuote.mockResolvedValue(quotedSwap());
    renderSwap(vi.fn().mockRejectedValue({ code: 4001 }));
    fireEvent.change(screen.getByPlaceholderText('0'), {
      target: { value: '0.01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByText('Review quote');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Transaction rejected in your wallet.',
    );
    expect(screen.queryByText('Review quote')).toBeNull();
    for (const select of screen.getAllByRole('combobox')) {
      expect(select.hasAttribute('disabled')).toBe(false);
    }
    expect(screen.getByRole('button', { name: 'Get quote' })).toBeTruthy();
  });
});
