// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { arbitrum, base, bsc, mainnet } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalWalletSend } from '~/components/rightSidebar/ExternalWalletSend';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  submit: vi.fn(),
  receipt: vi.fn(),
  invalidate: vi.fn(),
  asset: vi.fn(),
  transferReader: vi.fn(),
  refetch: vi.fn(),
  reader: { nativeBalance: vi.fn(), tokenDetails: vi.fn() },
  client: {},
  provider: { request: vi.fn() },
}));
const address = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const tokenAddress = '0x3333333333333333333333333333333333333333';
const hash = `0x${'a'.repeat(64)}`;
const prepared = {
  input: { address, recipient, amount: '1.25', tokenAddress },
  call: { account: address, to: tokenAddress, value: 0n },
  units: 1_250_000n,
  decimals: 6,
  symbol: 'TOKEN',
  balance: 5_000_000n,
  estimatedFee: 1_000_000_000_000n,
  preparedAt: 0,
};

vi.mock('~/contexts/WalletProvider', () => ({
  useWallet: () => ({ provider: mocks.provider }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.client,
  useWaitForTransactionReceipt: mocks.receipt,
}));
vi.mock('~/hooks/useLifiWallet', () => ({
  useLifiTransferReader: mocks.transferReader,
  useLifiAsset: mocks.asset,
  refreshLifiWallet: mocks.invalidate,
  useLifiWalletTokens: () => ({
    data: {
      tokens: [
        {
          address: tokenAddress,
          symbol: 'TOKEN',
          chainId: 8453,
          verificationStatus: 'verified',
        },
      ],
    },
    isError: false,
    isPending: false,
  }),
}));
vi.mock('~/utils/baseWalletTransfer', () => ({
  createBaseTransferReader: () => mocks.reader,
  prepareEvmTransfer: mocks.prepare,
  submitEvmTransfer: mocks.submit,
}));
vi.mock('~/components/forms/buttons/DefaultButton', () => ({
  DefaultButton: ({
    children,
    disabled,
    type,
    onClick,
  }: React.ComponentProps<'button'>) => (
    <button type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.asset.mockImplementation((_wallet: string, token: string) => ({
    data:
      token === tokenAddress
        ? { symbol: 'TOKEN', decimals: 6, balance: 5000001n }
        : { symbol: 'ETH', decimals: 18, balance: 1230000000000000000n },
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
  }));
  mocks.reader.nativeBalance
    .mockReset()
    .mockResolvedValue(1230000000000000000n);
  mocks.reader.tokenDetails
    .mockReset()
    .mockResolvedValue({ symbol: 'TOKEN', decimals: 6, balance: 5000001n });
  mocks.transferReader.mockReturnValue(mocks.reader);
  mocks.prepare.mockResolvedValue(prepared);
  mocks.submit.mockResolvedValue(hash);
  mocks.receipt.mockReturnValue({ data: undefined, isError: false });
});
afterEach(cleanup);

async function review() {
  fireEvent.change(screen.getByLabelText('Asset'), {
    target: { value: tokenAddress },
  });
  fireEvent.change(screen.getByLabelText('Recipient'), {
    target: { value: recipient },
  });
  fireEvent.change(screen.getByLabelText('Amount'), {
    target: { value: '1.25' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review send' }));
  await screen.findByRole('button', { name: 'Confirm in wallet' });
}

describe('ExternalWalletSend', () => {
  it('shows the native balance before entering an amount', async () => {
    render(<ExternalWalletSend address={address} />);
    await screen.findByText('Available on Base: 1.23 ETH');
    expect(mocks.asset).toHaveBeenCalledWith(
      address,
      '0x0000000000000000000000000000000000000000',
      base,
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('shows the selected token balance with exact decimals', async () => {
    render(<ExternalWalletSend address={address} />);
    await screen.findByText('Available on Base: 1.23 ETH');
    fireEvent.change(screen.getByLabelText('Asset'), {
      target: { value: tokenAddress },
    });
    expect(screen.queryByText('Available on Base: 1.23 ETH')).toBeNull();
    await screen.findByText('Available on Base: 5.000001 TOKEN');
    expect(mocks.asset).toHaveBeenCalledWith(address, tokenAddress, base);
  });
  it('shows balance errors as unavailable and offers a shared refresh', async () => {
    mocks.asset.mockReturnValue({ isError: true, refetch: mocks.refetch });
    render(<ExternalWalletSend address={address} />);
    await screen.findByText('Could not load balance on Base. Try refreshing.');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh balance' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
  it('shows a loading state while the shared cache reads a balance', () => {
    mocks.asset.mockReturnValue({ isError: false, data: undefined });
    render(<ExternalWalletSend address={address} />);
    expect(screen.getByText('Loading balance on Base…')).toBeTruthy();
  });
  it('does not retain the previous account balance after changing accounts', async () => {
    const { rerender } = render(<ExternalWalletSend address={address} />);
    await screen.findByText('Available on Base: 1.23 ETH');
    mocks.asset.mockReturnValue({
      data: { symbol: 'ETH', decimals: 18, balance: 0n },
    });
    rerender(<ExternalWalletSend address={recipient} />);
    expect(screen.queryByText('Available on Base: 1.23 ETH')).toBeNull();
    await screen.findByText('Available on Base: 0 ETH');
    expect(mocks.asset).toHaveBeenLastCalledWith(
      recipient,
      '0x0000000000000000000000000000000000000000',
      base,
    );
  });
  it('prepares the selected token read-only before offering wallet confirmation', async () => {
    render(<ExternalWalletSend address={address} />);
    expect(
      screen.queryByRole('button', { name: 'Confirm in wallet' }),
    ).toBeNull();
    await review();
    expect(mocks.prepare).toHaveBeenCalledWith(
      mocks.reader,
      {
        address,
        recipient,
        amount: '1.25',
        tokenAddress,
      },
      base,
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(
      screen.getByRole('region', { name: 'Review Base transfer' }).textContent,
    ).toContain('1.25 TOKEN');
  });
  it('invalidates the review after editing an amount', async () => {
    render(<ExternalWalletSend address={address} />);
    await review();
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '2' },
    });
    expect(
      screen.queryByRole('button', { name: 'Confirm in wallet' }),
    ).toBeNull();
  });
  it('shows live-check failures without offering confirmation', async () => {
    mocks.prepare.mockRejectedValue(new Error('Insufficient TOKEN balance.'));
    render(<ExternalWalletSend address={address} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review send' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Insufficient',
    );
    expect(
      screen.queryByRole('button', { name: 'Confirm in wallet' }),
    ).toBeNull();
  });
  it('handles wallet rejection without claiming submission', async () => {
    mocks.submit.mockRejectedValue(new Error('User rejected request'));
    render(<ExternalWalletSend address={address} />);
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm in wallet' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'rejected',
    );
    expect(
      screen.queryByRole('link', { name: 'View transaction on BaseScan' }),
    ).toBeNull();
  });
  it('does not send twice when confirmation is clicked repeatedly', async () => {
    let resolve!: (hash: string) => void;
    mocks.submit.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<ExternalWalletSend address={address} />);
    await review();
    const button = screen.getByRole('button', { name: 'Confirm in wallet' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    await act(async () => resolve(hash));
  });
  it('does not claim confirmation just because a hash was returned', async () => {
    render(<ExternalWalletSend address={address} />);
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm in wallet' }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Waiting for confirmation',
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://basescan.org/tx/${hash}`,
    );
  });
  it.each([
    ['success', 'Transaction confirmed on Base.'],
    ['reverted', 'Transaction reverted on Base.'],
  ])('reports receipt status %s accurately', async (status, message) => {
    render(<ExternalWalletSend address={address} />);
    await review();
    mocks.receipt.mockReturnValue({
      data: { status, transactionHash: hash },
      isError: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm in wallet' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(message),
    );
  });
  it('reports unavailable confirmation without labelling the transfer failed', async () => {
    render(<ExternalWalletSend address={address} />);
    await review();
    mocks.receipt.mockReturnValue({ data: undefined, isError: true });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm in wallet' }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Confirmation unavailable',
    );
  });
  it('does not label a cancellation receipt as a confirmed transfer', async () => {
    render(<ExternalWalletSend address={address} />);
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm in wallet' }));
    await screen.findByRole('status');
    mocks.receipt.mockReturnValue({
      data: { status: 'success', transactionHash: hash },
      isError: false,
    });
    act(() =>
      mocks.receipt.mock.lastCall?.[0].onReplaced({ reason: 'cancelled' }),
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Transaction cancelled.',
    );
  });
  it('ignores an old preparation result after changing accounts', async () => {
    let resolve!: (value: typeof prepared) => void;
    mocks.prepare.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { rerender } = render(
      <ExternalWalletSend key={address} address={address} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review send' }));
    rerender(<ExternalWalletSend key={recipient} address={recipient} />);
    await act(async () => resolve(prepared));
    expect(
      screen.queryByRole('button', { name: 'Confirm in wallet' }),
    ).toBeNull();
  });

  it('uses Ethereum data, receipts, review text, and explorer links', async () => {
    render(<ExternalWalletSend address={address} chain={mainnet} />);
    expect(mocks.transferReader).toHaveBeenCalledWith(mainnet);
    expect(mocks.asset).toHaveBeenCalledWith(
      address,
      '0x0000000000000000000000000000000000000000',
      mainnet,
    );
    expect(mocks.receipt).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: mainnet.id }),
    );
    await review();
    expect(mocks.prepare).toHaveBeenCalledWith(
      mocks.reader,
      expect.objectContaining({ address, recipient, tokenAddress }),
      mainnet,
    );
    expect(
      screen.getByRole('region', { name: 'Review Ethereum transfer' })
        .textContent,
    ).toContain('Estimated fee:');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm in wallet' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'View transaction on Etherscan' })
        .getAttribute('href'),
    ).toBe(`https://etherscan.io/tx/${hash}`);
  });

  it('uses Arbitrum data, receipts, review text, and explorer links', async () => {
    render(<ExternalWalletSend address={address} chain={arbitrum} />);
    expect(mocks.transferReader).toHaveBeenCalledWith(arbitrum);
    expect(mocks.asset).toHaveBeenCalledWith(
      address,
      '0x0000000000000000000000000000000000000000',
      arbitrum,
    );
    expect(mocks.receipt).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: arbitrum.id }),
    );
    await review();
    expect(mocks.prepare).toHaveBeenCalledWith(
      mocks.reader,
      expect.objectContaining({ address, recipient, tokenAddress }),
      arbitrum,
    );
    expect(
      screen.getByRole('region', { name: 'Review Arbitrum One transfer' })
        .textContent,
    ).toContain('Estimated fee:');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm in wallet' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'View transaction on Arbiscan' })
        .getAttribute('href'),
    ).toBe(`https://arbiscan.io/tx/${hash}`);
  });

  it('uses BSC data, BNB fees, receipts, and BscScan links', async () => {
    mocks.asset.mockReturnValue({
      data: { symbol: 'BNB', decimals: 18, balance: 1230000000000000000n },
      isError: false,
      isFetching: false,
      refetch: mocks.refetch,
    });
    render(<ExternalWalletSend address={address} chain={bsc} />);
    expect(mocks.transferReader).toHaveBeenCalledWith(bsc);
    expect(mocks.asset).toHaveBeenCalledWith(
      address,
      '0x0000000000000000000000000000000000000000',
      bsc,
    );
    expect(mocks.receipt).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: bsc.id }),
    );
    expect(
      screen.getByText('Available on BNB Smart Chain: 1.23 BNB'),
    ).toBeTruthy();
    await review();
    expect(mocks.prepare).toHaveBeenCalledWith(
      mocks.reader,
      expect.objectContaining({ address, recipient, tokenAddress }),
      bsc,
    );
    const reviewPanel = screen.getByRole('region', {
      name: 'Review BNB Smart Chain transfer',
    });
    expect(reviewPanel.textContent).toContain('Estimated fee:');
    expect(reviewPanel.textContent).toContain('BNB');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm in wallet' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'View transaction on BscScan' })
        .getAttribute('href'),
    ).toBe(`https://bscscan.com/tx/${hash}`);
  });
});
