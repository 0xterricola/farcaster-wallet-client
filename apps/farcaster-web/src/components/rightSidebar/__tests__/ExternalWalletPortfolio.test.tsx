// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ApiEthFungibleTokenPosition } from 'farcaster-client-data';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalWalletPortfolio } from '~/components/rightSidebar/ExternalWalletPortfolio';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  signedIn: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('farcaster-client-hooks', () => ({
  useWalletPositionsQuery: mocks.query,
}));
vi.mock('~/hooks/data/useIsSignedIn', () => ({
  useIsSignedIn: mocks.signedIn,
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

const address = '0x1111111111111111111111111111111111111111';
const otherAddress = '0x2222222222222222222222222222222222222222';
const position = (overrides: Partial<ApiEthFungibleTokenPosition> = {}) =>
  ({
    id: 'token',
    chain: 'base',
    symbol: 'TEST',
    address,
    decimals: 6,
    quantity: { int: '1000000', float: 1 },
    value: 2,
    ...overrides,
  }) as ApiEthFungibleTokenPosition;
const result = (positions: ApiEthFungibleTokenPosition[]) => ({
  data: { positions },
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: mocks.refetch,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signedIn.mockReturnValue(true);
  mocks.query.mockReturnValue(result([position()]));
});
afterEach(cleanup);

describe('ExternalWalletPortfolio', () => {
  it('excludes native ETH from rows and hidden-token counts, but keeps WETH', () => {
    mocks.query.mockReturnValue(
      result([
        position({
          id: 'native',
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          hidden: true,
        }),
        position({
          id: 'wrapped',
          symbol: 'WETH',
          address: '0x4200000000000000000000000000000000000006',
          hidden: true,
        }),
      ]),
    );
    render(<ExternalWalletPortfolio address={address} />);
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Show hidden tokens (1)' }),
    );
    expect(screen.queryByText('ETH', { exact: true })).toBeNull();
    expect(screen.getByText('WETH')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows a clear empty-token state for an ETH-only wallet', () => {
    mocks.query.mockReturnValue(
      result([
        position({
          symbol: 'ETH',
          address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        }),
      ]),
    );
    render(<ExternalWalletPortfolio address={address} />);
    expect(
      screen.getByText(
        'No Base token holdings to show. Native ETH is shown above.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('requests holdings by connected address without previous-account placeholders', () => {
    render(<ExternalWalletPortfolio address={address} />);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { address },
        enabled: true,
        keepPreviousData: false,
      }),
    );
    expect(screen.getByText('TEST')).toBeTruthy();
    expect(screen.getByText('$2.00')).toBeTruthy();
  });

  it('excludes other networks and reveals hidden tokens only when selected', () => {
    mocks.query.mockReturnValue(
      result([
        position(),
        position({ id: 'hidden', symbol: 'HIDDEN', hidden: true }),
        position({ id: 'other', symbol: 'OTHER-CHAIN', chain: 'ethereum' }),
      ]),
    );
    render(<ExternalWalletPortfolio address={address} />);
    expect(screen.queryByText('HIDDEN')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('HIDDEN')).toBeTruthy();
    expect(screen.queryByText('OTHER-CHAIN')).toBeNull();
  });

  it('shows a loading state when there is no data yet', () => {
    mocks.query.mockReturnValue({
      ...result([]),
      data: undefined,
      isPending: true,
      isFetching: true,
    });
    render(<ExternalWalletPortfolio address={address} />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
  });

  it('shows an empty state and refreshes on request', () => {
    mocks.query.mockReturnValue(result([]));
    render(<ExternalWalletPortfolio address={address} />);
    expect(
      screen.getByText(
        'No Base token holdings to show. Native ETH is shown above.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tokens' }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a failed lookup from an empty portfolio', () => {
    mocks.query.mockReturnValue({
      ...result([]),
      data: undefined,
      isError: true,
    });
    render(<ExternalWalletPortfolio address={address} />);
    expect(screen.getByRole('alert').textContent).toContain('Could not load');
    expect(
      screen.queryByText(
        'No Base token holdings to show. Native ETH is shown above.',
      ),
    ).toBeNull();
  });

  it('warns when cached balances could not be refreshed', () => {
    mocks.query.mockReturnValue({ ...result([position()]), isError: true });
    render(<ExternalWalletPortfolio address={address} />);
    expect(screen.getByRole('alert').textContent).toContain('out of date');
    expect(screen.getByText('TEST')).toBeTruthy();
  });

  it('does not fetch or display cached holdings when signed out', () => {
    mocks.signedIn.mockReturnValue(false);
    render(<ExternalWalletPortfolio address={address} />);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.queryByText('TEST')).toBeNull();
  });

  it('changes the query address and clears the old view when switching wallets', () => {
    const { rerender } = render(
      <ExternalWalletPortfolio key={address} address={address} />,
    );
    mocks.query.mockReturnValue({
      ...result([]),
      data: undefined,
      isPending: true,
    });
    rerender(
      <ExternalWalletPortfolio key={otherAddress} address={otherAddress} />,
    );
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { address: otherAddress } }),
    );
    expect(screen.queryByText('TEST')).toBeNull();
  });

  it('treats token claim links as plain untrusted text', () => {
    mocks.query.mockReturnValue(
      result([position({ symbol: 'Claim https://example.invalid' })]),
    );
    render(<ExternalWalletPortfolio address={address} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(
      `https://basescan.org/token/${address}`,
    );
  });

  it('limits long lists until the user requests more tokens', () => {
    mocks.query.mockReturnValue(
      result(
        Array.from({ length: 25 }, (_, i) =>
          position({ id: String(i), symbol: `TOKEN-${i}` }),
        ),
      ),
    );
    render(<ExternalWalletPortfolio address={address} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: /Show more tokens/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
  });
});
