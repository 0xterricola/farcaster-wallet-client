// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { zeroAddress } from 'viem';
import { arbitrum, base, bsc, celo, mainnet } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalWalletPortfolio } from '~/components/rightSidebar/ExternalWalletPortfolio';
import { CELO_NATIVE_TOKEN_ADDRESS } from '~/utils/lifiWallet';

const mocks = vi.hoisted(() => ({
  tokens: vi.fn(),
  assets: vi.fn(),
  refresh: vi.fn(),
  client: {},
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mocks.client,
}));
vi.mock('~/hooks/useLifiWallet', () => ({
  useLifiWalletTokens: mocks.tokens,
  useLifiAssets: mocks.assets,
  refreshLifiWallet: mocks.refresh,
}));
vi.mock('~/components/forms/buttons/DefaultButton', () => ({
  DefaultButton: ({
    children,
    onClick,
    disabled,
  }: React.ComponentProps<'button'>) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
const wallet = '0x1111111111111111111111111111111111111111';
const token = {
  chainId: 8453,
  address: '0x2222222222222222222222222222222222222222',
  symbol: 'TOKEN',
  name: 'Token',
  decimals: 6,
  priceUSD: 2,
  verificationStatus: 'verified',
};
const result = (tokens = [token]) => ({
  data: { tokens },
  isPending: false,
  isError: false,
  isFetching: false,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tokens.mockReturnValue(result());
  mocks.assets.mockImplementation((_wallet, addresses: string[]) =>
    addresses.map((address) => ({
      data: { ...token, address, balance: 1000000n },
      isError: false,
      isFetching: false,
    })),
  );
});
afterEach(cleanup);
describe('LI.FI portfolio', () => {
  it('shows an accessible spinner before discovery without a misleading empty state', () => {
    mocks.tokens.mockReturnValue({ isPending: true, isFetching: true });
    render(<ExternalWalletPortfolio address={wallet} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Loading Base tokens');
    expect(
      status.querySelector('svg')?.classList.contains('animate-spin'),
    ).toBe(true);
    expect(status.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(
      status
        .querySelector('svg')
        ?.classList.contains('motion-reduce:animate-none'),
    ).toBe(true);
    expect(
      screen
        .getByRole('region', { name: 'Base token portfolio' })
        .getAttribute('aria-busy'),
    ).toBe('true');
    expect(
      (screen.getByRole('button', { name: 'Refreshing…' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByText(/No non-zero/)).toBeNull();
  });
  it('keeps a loading indicator until discovered token balances are available', () => {
    mocks.assets.mockReturnValue([{ isFetching: true }]);
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.getByRole('status').textContent).toContain(
      'Checking token balances',
    );
    expect(screen.getByText('Checking balance…')).toBeTruthy();
    expect(screen.queryByText('$2.00')).toBeNull();
    expect(screen.queryByText(/No non-zero/)).toBeNull();
  });
  it('replaces the loading state with token rows when balances arrive', () => {
    mocks.tokens.mockReturnValue({ isPending: true, isFetching: true });
    const view = render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.getByRole('status')).toBeTruthy();
    mocks.tokens.mockReturnValue(result());
    view.rerender(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      screen
        .getByRole('region', { name: 'Base token portfolio' })
        .getAttribute('aria-busy'),
    ).toBe('false');
    expect(screen.getByText('$2.00')).toBeTruthy();
  });
  it('keeps existing balances visible while refreshing and prevents duplicate refresh clicks', () => {
    mocks.tokens.mockReturnValue({ ...result(), isFetching: true });
    render(<ExternalWalletPortfolio address={wallet} />);
    const button = screen.getByRole('button', { name: 'Refreshing…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      button.querySelector('svg')?.classList.contains('animate-spin'),
    ).toBe(true);
    expect(screen.getByText('$2.00')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain(
      'Updating token balances',
    );
    fireEvent.click(button);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('shows an error rather than spinning indefinitely after discovery fails', () => {
    mocks.tokens.mockReturnValue({ isPending: true, isError: true });
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'Refresh tokens',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it('keeps the data-source explanation in a collapsed disclosure', () => {
    render(<ExternalWalletPortfolio address={wallet} />);
    const details = screen.getByText('About these balances').closest('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(
      'Token discovery and estimated prices by LI.FI',
    );
    expect(details?.textContent).toContain('Native ETH is shown above');
  });
  it('uses the connected wallet without requiring Farcaster authentication', () => {
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(mocks.tokens).toHaveBeenCalledWith(wallet, base);
    expect(mocks.assets).toHaveBeenCalledWith(wallet, [token.address], base);
    expect(screen.getByText('$2.00')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });
  it('does not duplicate native ETH in token rows', () => {
    mocks.tokens.mockReturnValue(
      result([{ ...token, address: zeroAddress, symbol: 'ETH' }, token]),
    );
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.queryByText('ETH', { exact: true })).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
  it('does not duplicate CeloToken because it shares the native CELO balance', () => {
    mocks.tokens.mockReturnValue(
      result([
        {
          ...token,
          chainId: celo.id,
          address: CELO_NATIVE_TOKEN_ADDRESS,
          symbol: 'CELO',
        },
        { ...token, chainId: celo.id },
      ]),
    );
    render(<ExternalWalletPortfolio address={wallet} chain={celo} />);
    expect(screen.queryByText('CELO', { exact: true })).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
  it('hides verified zero balances even if the indexed API listed the token', () => {
    mocks.assets.mockReturnValue([
      { data: { ...token, balance: 0n }, isError: false },
    ]);
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.getByText(/No non-zero Base/)).toBeTruthy();
  });
  it('does not turn a failed balance read into zero or show an old valuation', () => {
    mocks.assets.mockReturnValue([
      { data: { ...token, balance: 1000000n }, isError: true },
    ]);
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.getByText('Balance unavailable')).toBeTruthy();
    expect(screen.queryByText('$2.00')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });
  it('separates unverified tokens and warns when revealed', () => {
    mocks.tokens.mockReturnValue(
      result([{ ...token, verificationStatus: 'unknown' }]),
    );
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.queryByRole('listitem')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('TOKEN')).toBeTruthy();
    expect(screen.getByText(/may include spam/)).toBeTruthy();
  });
  it('shows discovery failures separately from an empty portfolio', () => {
    mocks.tokens.mockReturnValue({ isError: true });
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.getByRole('alert').textContent).toContain('LI.FI');
    expect(screen.queryByText(/No non-zero/)).toBeNull();
  });
  it('shows discovery loading', () => {
    mocks.tokens.mockReturnValue({ isPending: true });
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
  });
  it('refreshes the shared wallet cache', () => {
    render(<ExternalWalletPortfolio address={wallet} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tokens' }));
    expect(mocks.refresh).toHaveBeenCalledWith(mocks.client, wallet, base.id);
  });

  it('uses the selected chain for Ethereum discovery, reads, labels, and links', () => {
    render(<ExternalWalletPortfolio address={wallet} chain={mainnet} />);
    expect(mocks.tokens).toHaveBeenCalledWith(wallet, mainnet);
    expect(mocks.assets).toHaveBeenCalledWith(wallet, [token.address], mainnet);
    expect(
      screen.getByRole('region', { name: 'Ethereum token portfolio' }),
    ).toBeTruthy();
    expect(screen.getByText('Tokens on Ethereum')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://etherscan.io/token/${token.address}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tokens' }));
    expect(mocks.refresh).toHaveBeenCalledWith(
      mocks.client,
      wallet,
      mainnet.id,
    );
  });
  it('uses the selected chain for Arbitrum discovery, reads, labels, and links', () => {
    render(<ExternalWalletPortfolio address={wallet} chain={arbitrum} />);
    expect(mocks.tokens).toHaveBeenCalledWith(wallet, arbitrum);
    expect(mocks.assets).toHaveBeenCalledWith(
      wallet,
      [token.address],
      arbitrum,
    );
    expect(
      screen.getByRole('region', { name: 'Arbitrum One token portfolio' }),
    ).toBeTruthy();
    expect(screen.getByText('Tokens on Arbitrum One')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://arbiscan.io/token/${token.address}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tokens' }));
    expect(mocks.refresh).toHaveBeenCalledWith(
      mocks.client,
      wallet,
      arbitrum.id,
    );
  });
  it('uses BSC for BNB and BEP-20 portfolio reads and BscScan links', () => {
    render(<ExternalWalletPortfolio address={wallet} chain={bsc} />);
    expect(mocks.tokens).toHaveBeenCalledWith(wallet, bsc);
    expect(mocks.assets).toHaveBeenCalledWith(wallet, [token.address], bsc);
    expect(
      screen.getByRole('region', { name: 'BNB Smart Chain token portfolio' }),
    ).toBeTruthy();
    expect(screen.getByText('Tokens on BNB Smart Chain')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://bscscan.com/token/${token.address}`,
    );
    expect(screen.getByText(/Native BNB is shown above/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tokens' }));
    expect(mocks.refresh).toHaveBeenCalledWith(mocks.client, wallet, bsc.id);
  });
  it('uses Celo for CELO and token portfolio reads and Celoscan links', () => {
    render(<ExternalWalletPortfolio address={wallet} chain={celo} />);
    expect(mocks.tokens).toHaveBeenCalledWith(wallet, celo);
    expect(mocks.assets).toHaveBeenCalledWith(wallet, [token.address], celo);
    expect(
      screen.getByRole('region', { name: 'Celo token portfolio' }),
    ).toBeTruthy();
    expect(screen.getByText('Tokens on Celo')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://celoscan.io/token/${token.address}`,
    );
    expect(screen.getByText(/Native CELO is shown above/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tokens' }));
    expect(mocks.refresh).toHaveBeenCalledWith(mocks.client, wallet, celo.id);
  });
  it('warns when discovery is partial', () => {
    mocks.tokens.mockReturnValue({
      ...result(),
      data: { tokens: [token], skipped: 1 },
    });
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.getByText(/partial token list/)).toBeTruthy();
  });
  it('loads at most 20 rows before show more', () => {
    mocks.tokens.mockReturnValue(
      result(
        Array.from({ length: 21 }, (_, i) => ({
          ...token,
          address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        })),
      ),
    );
    render(<ExternalWalletPortfolio address={wallet} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(21);
  });
});
