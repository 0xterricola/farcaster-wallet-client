// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { Address, PublicClient, zeroAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchFreshLifiAsset,
  refreshLifiWallet,
  useLifiAsset,
  useLifiWalletTokens,
} from '~/hooks/useLifiWallet';
import { LifiAsset, lifiBalanceKey } from '~/utils/lifiWallet';

const mocks = vi.hoisted(() => ({
  client: {},
  metadata: vi.fn(),
  discover: vi.fn(),
  read: vi.fn(),
}));
vi.mock('wagmi', () => ({ usePublicClient: () => mocks.client }));
vi.mock('~/utils/lifiWallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/lifiWallet')>()),
  fetchLifiToken: mocks.metadata,
  fetchLifiWalletTokens: mocks.discover,
  readLifiAsset: mocks.read,
}));
const wallet = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const token = {
  chainId: 8453,
  address: '0x3333333333333333333333333333333333333333' as const,
  symbol: 'TOKEN',
  name: 'Token',
  decimals: 6,
};
let queryClient: QueryClient;
function View({
  name,
  address = wallet,
  contract = token.address,
}: {
  name: string;
  address?: Address;
  contract?: Address;
}) {
  const { data, isError } = useLifiAsset(address, contract);
  return (
    <p data-testid={name}>
      {isError ? 'unavailable' : data ? data.balance.toString() : 'loading'}
    </p>
  );
}
function mount(children: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  });
  mocks.metadata.mockResolvedValue(token);
  mocks.discover.mockResolvedValue({ tokens: [token], skipped: 0 });
  mocks.read.mockReset().mockResolvedValue({ ...token, balance: 123n });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
describe('shared LI.FI wallet cache', () => {
  it('shows failed balance refreshes as unavailable, not a fabricated zero', async () => {
    mount(
      <>
        <View name="portfolio" />
        <View name="swap" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('swap').textContent).toBe('123'),
    );
    mocks.read.mockRejectedValue(new Error('RPC unavailable'));
    await act(async () => {
      await refreshLifiWallet(queryClient, wallet);
    });
    await waitFor(() =>
      expect(screen.getByTestId('swap').textContent).toBe('unavailable'),
    );
    expect(screen.getByTestId('portfolio').textContent).toBe('unavailable');
    expect(
      queryClient.getQueryData(lifiBalanceKey(wallet, token.address)),
    ).toMatchObject({ balance: '123' });
  });
  it('does not let a cancelled background read overwrite the fresh preflight balance', async () => {
    mount(
      <>
        <View name="portfolio" />
        <View name="swap" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('swap').textContent).toBe('123'),
    );
    let resolveOld!: (value: LifiAsset) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    let background!: Promise<void>;
    act(() => {
      background = refreshLifiWallet(queryClient, wallet);
    });
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    mocks.read.mockResolvedValue({ ...token, balance: 0n });
    await act(async () => {
      const fresh = await fetchFreshLifiAsset(
        queryClient,
        mocks.client as PublicClient,
        wallet,
        token.address,
      );
      expect(fresh.balance).toBe(0n);
      await background;
    });
    await waitFor(() =>
      expect(screen.getByTestId('swap').textContent).toBe('0'),
    );
    await act(async () => {
      resolveOld({ ...token, balance: 999n });
    });
    expect(screen.getByTestId('portfolio').textContent).toBe('0');
    expect(screen.getByTestId('swap').textContent).toBe('0');
    expect(
      queryClient.getQueryData(lifiBalanceKey(wallet, token.address)),
    ).toMatchObject({ balance: '0' });
  });
  it('ignores a late balance for the previously selected token', async () => {
    let resolveOld!: (value: LifiAsset) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const view = mount(<View name="send" />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    mocks.metadata.mockResolvedValue({ ...token, address: other });
    mocks.read.mockResolvedValue({ ...token, address: other, balance: 456n });
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <View name="send" contract={other} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('send').textContent).toBe('456'),
    );
    await act(async () => {
      resolveOld({ ...token, balance: 999n });
    });
    expect(screen.getByTestId('send').textContent).toBe('456');
  });
  it('deduplicates balances across portfolio, send and swap consumers', async () => {
    mount(
      <>
        <View name="portfolio" />
        <View name="send" />
        <View name="swap" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('swap').textContent).toBe('123'),
    );
    expect(screen.getByTestId('portfolio').textContent).toBe('123');
    expect(screen.getByTestId('send').textContent).toBe('123');
    expect(mocks.read).toHaveBeenCalledOnce();
    const cached = queryClient.getQueryData(
      lifiBalanceKey(wallet, token.address),
    );
    expect(() => JSON.stringify(cached)).not.toThrow();
    expect(cached).toMatchObject({ balance: '123' });
  });
  it('publishes preflight balances back to every consumer', async () => {
    mount(
      <>
        <View name="portfolio" />
        <View name="send" />
        <View name="swap" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('send').textContent).toBe('123'),
    );
    mocks.read.mockResolvedValue({ ...token, balance: 0n });
    await act(async () => {
      await fetchFreshLifiAsset(
        queryClient,
        mocks.client as PublicClient,
        wallet,
        token.address,
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId('portfolio').textContent).toBe('0'),
    );
    expect(screen.getByTestId('send').textContent).toBe('0');
    expect(screen.getByTestId('swap').textContent).toBe('0');
  });
  it('isolates late responses from a previously selected account', async () => {
    let resolve!: (value: LifiAsset) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = mount(<View name="send" />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <View name="send" address={other} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('send').textContent).toBe('123'),
    );
    await act(async () => resolve({ ...token, balance: 999n }));
    expect(screen.getByTestId('send').textContent).toBe('123');
  });
  it('refreshes all active wallet balances after confirmation', async () => {
    mount(<View name="portfolio" />);
    await waitFor(() =>
      expect(screen.getByTestId('portfolio').textContent).toBe('123'),
    );
    mocks.read.mockResolvedValue({ ...token, balance: 500n });
    await act(async () => {
      await refreshLifiWallet(queryClient, wallet);
    });
    await waitFor(() =>
      expect(screen.getByTestId('portfolio').textContent).toBe('500'),
    );
  });
  it('does not seed spendable amounts from the discovery API', async () => {
    function Discovery() {
      const { data } = useLifiWalletTokens(wallet);
      return <p>{data ? 'discovered' : 'loading'}</p>;
    }
    mount(<Discovery />);
    await screen.findByText('discovered');
    expect(
      queryClient.getQueryData(lifiBalanceKey(wallet, token.address)),
    ).toBeUndefined();
    expect(mocks.discover).toHaveBeenCalledWith(wallet, expect.anything());
  });
  it('keeps ETH and ERC-20 balances separate', async () => {
    mocks.read.mockImplementation((_client, _wallet, metadata) =>
      Promise.resolve({
        ...metadata,
        balance: metadata.address === zeroAddress ? 10n : 20n,
      }),
    );
    mount(
      <>
        <View name="native" contract={zeroAddress} />
        <View name="token" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('token').textContent).toBe('20'),
    );
    expect(screen.getByTestId('native').textContent).toBe('10');
  });
});
