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
import { decodeFunctionData, erc20Abi, zeroAddress } from 'viem';
import { arbitrum, base, bsc, mainnet } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalWalletSwap } from '~/components/rightSidebar/ExternalWalletSwap';

const mocks = vi.hoisted(() => ({
  fresh: vi.fn(),
  asset: vi.fn(),
  quote: vi.fn(),
  request: vi.fn(),
  guard: vi.fn(),
  receipt: vi.fn(),
  refresh: vi.fn(),
  tokens: vi.fn(),
  refetchTokens: vi.fn(),
  readContract: vi.fn(),
  wait: vi.fn(),
  queryClient: {},
  walletAddress: '0x1111111111111111111111111111111111111111',
}));
const wallet = '0x1111111111111111111111111111111111111111';
const contract = '0x2222222222222222222222222222222222222222';
const hash = `0x${'a'.repeat(64)}`;
const from = {
  chainId: 8453,
  address: zeroAddress,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  balance: 1000000000000000000n,
};
const to = {
  ...from,
  address: contract,
  symbol: 'TOKEN',
  decimals: 6,
  balance: 0n,
};
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mocks.queryClient,
}));
const provider = { request: mocks.request };
vi.mock('~/contexts/WalletProvider', () => ({
  useWallet: () => ({ address: mocks.walletAddress, provider }),
}));
vi.mock('wagmi', () => ({
  usePublicClient: () => ({
    readContract: mocks.readContract,
    waitForTransactionReceipt: mocks.wait,
  }),
  useWaitForTransactionReceipt: mocks.receipt,
}));
vi.mock('~/hooks/useLifiWallet', () => ({
  useLifiAsset: mocks.asset,
  fetchFreshLifiAsset: mocks.fresh,
  refreshLifiWallet: mocks.refresh,
  useLifiWalletTokens: mocks.tokens,
}));
vi.mock('~/utils/lifiSwap', () => ({ fetchLifiQuote: mocks.quote }));
vi.mock('~/utils/sendBaseNativeToken', () => ({
  ensureEvmWalletAccount: mocks.guard,
}));
vi.mock('~/components/forms/buttons/DefaultButton', () => ({
  DefaultButton: ({
    children,
    onClick,
    type,
    disabled,
  }: React.ComponentProps<'button'>) => (
    <button onClick={onClick} type={type} disabled={disabled}>
      {children}
    </button>
  ),
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.walletAddress = wallet;
  mocks.tokens.mockReturnValue({
    data: { tokens: [] },
    refetch: mocks.refetchTokens,
  });
  mocks.asset.mockImplementation((_wallet, token) => ({
    data: token === zeroAddress ? from : token === contract ? to : undefined,
    isError: false,
  }));
  mocks.fresh.mockImplementation((_cache, _client, _wallet, token) =>
    Promise.resolve(token === zeroAddress ? from : to),
  );
  mocks.quote.mockResolvedValue({
    tool: 'test',
    action: { fromAmount: '1000000000000' },
    estimate: { toAmount: '1000', toAmountMin: '990' },
    transactionRequest: { to: contract, data: '0xabcd', value: '0xe8d4a51000' },
  });
  mocks.request.mockReset().mockResolvedValue(hash);
  mocks.guard.mockResolvedValue(undefined);
  mocks.receipt.mockReturnValue({ data: undefined, isError: false });
  mocks.readContract.mockReset().mockResolvedValue(0n);
  mocks.wait
    .mockReset()
    .mockResolvedValue({ status: 'success', blockNumber: 123n });
});
afterEach(cleanup);

const wethAddress = '0x4200000000000000000000000000000000000006';
const spender = '0x3333333333333333333333333333333333333333';
const wethUnits = 250000000000000000n;
const weth = {
  ...from,
  address: wethAddress,
  symbol: 'WETH',
  name: 'Wrapped Ether',
  balance: 2000000000000000000n,
  verificationStatus: 'verified',
};
const wethRoute = {
  tool: 'test',
  estimate: {
    toAmount: '249000000000000000',
    toAmountMin: '247000000000000000',
    approvalAddress: spender,
  },
  transactionRequest: { to: spender, data: '0xabcd', value: '0x0' },
};
function setupWeth() {
  mocks.tokens.mockReturnValue({
    data: { tokens: [weth, { ...to, verificationStatus: 'verified' }] },
    refetch: mocks.refetchTokens,
  });
  mocks.asset.mockImplementation((_wallet, token) => ({
    data: token === wethAddress ? weth : token === zeroAddress ? from : to,
    isError: false,
  }));
  mocks.fresh.mockImplementation((_cache, _client, _wallet, token) =>
    Promise.resolve(
      token === wethAddress ? weth : token === zeroAddress ? from : to,
    ),
  );
  mocks.quote.mockResolvedValue(wethRoute);
}
async function quoteWeth() {
  fireEvent.change(screen.getByLabelText('Choose sell asset'), {
    target: { value: wethAddress },
  });
  fireEvent.change(screen.getByLabelText('Choose buy asset'), {
    target: { value: 'ETH' },
  });
  fireEvent.change(screen.getByLabelText('Amount'), {
    target: { value: '0.25' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
  await screen.findByRole('button', { name: /Approve WETH|Review swap/ });
}

describe('WETH approval sequencing', () => {
  it('waits for the approval block to become readable without repeating approval or sending the swap', async () => {
    setupWeth();
    mocks.readContract
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockRejectedValueOnce(new Error('block not found: 0x7b'))
      .mockResolvedValue(wethUnits);
    render(<ExternalWalletSwap />);
    await quoteWeth();
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Approve WETH' }));
      });
      expect(screen.getByRole('status').textContent).toContain(
        'Waiting for Base RPC to catch up',
      );
      expect(mocks.request).toHaveBeenCalledOnce();
      expect(mocks.wait).toHaveBeenCalledOnce();
      expect(screen.queryByRole('button', { name: 'Review swap' })).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(screen.getByRole('button', { name: 'Review swap' })).toBeTruthy();
      expect(mocks.request).toHaveBeenCalledOnce();
      expect(mocks.wait).toHaveBeenCalledOnce();
      expect(
        mocks.readContract.mock.calls
          .slice(-2)
          .map(([call]) => call.blockNumber),
      ).toEqual([123n, 123n]);
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('shows the approved amount, required amount and exact Base spender before approval', async () => {
    setupWeth();
    mocks.readContract.mockResolvedValue(100000000000000000n);
    render(<ExternalWalletSwap />);
    await quoteWeth();
    const details = screen.getByLabelText('Token approval').textContent;
    expect(details).toContain('Approved: 0.1 WETH');
    expect(details).toContain('Required: 0.25 WETH');
    expect(details).toContain(`Base spender: ${spender}`);
    expect(screen.getByRole('button', { name: 'Approve WETH' })).toBeTruthy();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('reads the confirmed approval block even if latest allowance is stale', async () => {
    setupWeth();
    mocks.readContract.mockImplementation(({ blockNumber }) =>
      Promise.resolve(blockNumber === 123n ? wethUnits : 0n),
    );
    render(<ExternalWalletSwap />);
    await quoteWeth();
    fireEvent.click(screen.getByRole('button', { name: 'Approve WETH' }));
    await screen.findByRole('button', { name: 'Review swap' });
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockNumber: 123n }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(
      'Approval confirmed',
    );
  });
  it('does not silently send approval when allowance falls before a Review swap click', async () => {
    setupWeth();
    mocks.readContract.mockResolvedValueOnce(wethUnits).mockResolvedValue(0n);
    render(<ExternalWalletSwap />);
    await quoteWeth();
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await screen.findByRole('button', { name: 'Approve WETH' });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Token approval').textContent).toContain(
      'Approved: 0 WETH',
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Allowance changed',
    );
  });
  it('does not silently swap when allowance grows before an Approve click', async () => {
    setupWeth();
    mocks.readContract.mockResolvedValueOnce(0n).mockResolvedValue(wethUnits);
    render(<ExternalWalletSwap />);
    await quoteWeth();
    fireEvent.click(screen.getByRole('button', { name: 'Approve WETH' }));
    await screen.findByRole('button', { name: 'Review swap' });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.wait).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain(
      'Already approved',
    );
  });
  it('blocks trading if allowance cannot be read instead of assuming zero or approval', async () => {
    setupWeth();
    mocks.readContract.mockRejectedValue(new Error('Allowance unavailable'));
    render(<ExternalWalletSwap />);
    fireEvent.change(screen.getByLabelText('Choose sell asset'), {
      target: { value: wethAddress },
    });
    fireEvent.change(screen.getByLabelText('Choose buy asset'), {
      target: { value: 'ETH' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '0.25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Allowance unavailable',
    );
    expect(
      screen.queryByRole('button', { name: /Approve WETH|Review swap/ }),
    ).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('rechecks approval for the new spender when requesting another quote', async () => {
    setupWeth();
    mocks.readContract.mockImplementation(({ args }) =>
      Promise.resolve(args[1] === spender ? wethUnits : 0n),
    );
    render(<ExternalWalletSwap />);
    await quoteWeth();
    expect(screen.getByRole('button', { name: 'Review swap' })).toBeTruthy();
    mocks.quote.mockResolvedValue({
      ...wethRoute,
      estimate: { ...wethRoute.estimate, approvalAddress: contract },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '0.2' },
    });
    expect(screen.queryByLabelText('Token approval')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByRole('button', { name: 'Approve WETH' });
    expect(screen.getByLabelText('Token approval').textContent).toContain(
      `Base spender: ${contract}`,
    );
    expect(mocks.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: [wallet, contract] }),
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('waits for the approval receipt, then rechecks allowance before requesting the swap', async () => {
    setupWeth();
    let confirmApproval!: (receipt: {
      status: string;
      blockNumber: bigint;
    }) => void;
    mocks.wait.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirmApproval = resolve;
        }),
    );
    mocks.readContract
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValue(wethUnits);
    render(<ExternalWalletSwap />);
    await quoteWeth();
    // Getting the quote itself must never ask the wallet for approval.
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve WETH' }));
    await waitFor(() => expect(mocks.wait).toHaveBeenCalledWith({ hash }));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    const approval = mocks.request.mock.calls[0][0].params[0];
    expect(approval).toMatchObject({
      chainId: '0x2105',
      from: wallet,
      to: wethAddress,
    });
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.data })).toEqual({
      functionName: 'approve',
      args: [spender, wethUnits],
    });
    expect(screen.getByRole('status').textContent).toContain(
      'Waiting for token approval',
    );
    expect(mocks.readContract).toHaveBeenCalledTimes(2);
    expect(
      (screen.getByLabelText('Choose sell asset') as HTMLSelectElement).closest(
        'fieldset',
      )?.disabled,
    ).toBe(true);
    await act(async () =>
      confirmApproval({ status: 'success', blockNumber: 123n }),
    );
    await screen.findByRole('button', { name: 'Review swap' });
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Token approval').textContent).toContain(
      'Approved: 0.25 WETH',
    );
    expect(mocks.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        blockNumber: 123n,
        address: wethAddress,
        functionName: 'allowance',
        args: [wallet, spender],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(mocks.request.mock.calls[1][0].params[0]).toMatchObject({
      chainId: '0x2105',
      from: wallet,
      to: spender,
      data: '0xabcd',
    });
    expect(mocks.readContract.mock.invocationCallOrder[3]).toBeLessThan(
      mocks.request.mock.invocationCallOrder[1],
    );
  });
  it.each([wethUnits, wethUnits + 1n])(
    'skips approval when WETH allowance is already sufficient (%s)',
    async (allowance) => {
      setupWeth();
      mocks.readContract.mockResolvedValue(allowance);
      render(<ExternalWalletSwap />);
      await quoteWeth();
      fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
      await screen.findByRole('link');
      expect(mocks.request).toHaveBeenCalledOnce();
      expect(mocks.request.mock.calls[0][0].params[0].to).toBe(spender);
      expect(mocks.wait).not.toHaveBeenCalled();
    },
  );
  it('does not request a swap after approval is rejected in the wallet', async () => {
    setupWeth();
    mocks.request.mockRejectedValueOnce(new Error('Approval rejected by user'));
    render(<ExternalWalletSwap />);
    await quoteWeth();
    fireEvent.click(screen.getByRole('button', { name: 'Approve WETH' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Approval rejected',
    );
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.wait).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('does not request a swap when approval confirmation times out', async () => {
    setupWeth();
    mocks.wait.mockRejectedValueOnce(
      new Error('Approval confirmation timed out'),
    );
    render(<ExternalWalletSwap />);
    await quoteWeth();
    fireEvent.click(screen.getByRole('button', { name: 'Approve WETH' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'timed out',
    );
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('blocks the swap if a successful receipt did not establish sufficient allowance', async () => {
    setupWeth();
    mocks.readContract.mockResolvedValue(0n);
    render(<ExternalWalletSwap />);
    await quoteWeth();
    fireEvent.click(screen.getByRole('button', { name: 'Approve WETH' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'allowance is still insufficient',
    );
    expect(mocks.request).toHaveBeenCalledOnce();
  });
  it('requires a new review if the spender changes after approval', async () => {
    setupWeth();
    render(<ExternalWalletSwap />);
    await quoteWeth();
    mocks.quote.mockResolvedValueOnce(wethRoute).mockResolvedValueOnce({
      ...wethRoute,
      estimate: { ...wethRoute.estimate, approvalAddress: contract },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve WETH' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Quote changed',
    );
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.request.mock.calls[0][0].params[0].to).toBe(wethAddress);
  });
  it('stops after approval if the connected account changes while waiting', async () => {
    setupWeth();
    let confirmApproval!: (receipt: { status: string }) => void;
    mocks.wait.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirmApproval = resolve;
        }),
    );
    const view = render(<ExternalWalletSwap />);
    await quoteWeth();
    fireEvent.click(screen.getByRole('button', { name: 'Approve WETH' }));
    await waitFor(() => expect(mocks.wait).toHaveBeenCalledOnce());
    mocks.walletAddress = contract;
    view.rerender(<ExternalWalletSwap />);
    await act(async () => confirmApproval({ status: 'success' }));
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.quote).toHaveBeenCalledTimes(2);
  });
  it('does not treat buying WETH with native ETH as spending WETH', async () => {
    setupWeth();
    mocks.quote.mockResolvedValue({
      ...wethRoute,
      transactionRequest: {
        ...wethRoute.transactionRequest,
        value: `0x${wethUnits.toString(16)}`,
      },
    });
    render(<ExternalWalletSwap />);
    fireEvent.change(screen.getByLabelText('Choose buy asset'), {
      target: { value: wethAddress },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '0.25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByRole('button', { name: 'Review swap' });
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await screen.findByRole('link');
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.wait).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.request.mock.calls[0][0].params[0].value).toBe(
      `0x${wethUnits.toString(16)}`,
    );
  });
});

describe('trade selector regressions', () => {
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  function choices(label: string) {
    return Array.from(
      (screen.getByLabelText(label) as HTMLSelectElement).options,
    );
  }
  it('offers only ETH and native Base USDC as defaults without wallet holdings', () => {
    render(<ExternalWalletSwap />);
    expect(choices('Choose buy asset').map((option) => option.value)).toEqual([
      'ETH',
      usdc,
      'custom',
    ]);
    expect(choices('Choose sell asset').map((option) => option.value)).toEqual([
      'ETH',
      'custom',
    ]);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([{ isPending: true }, { isError: true }])(
    'keeps the defaults when discovery is unavailable: %j',
    (state) => {
      mocks.tokens.mockReturnValue({ ...state, refetch: mocks.refetchTokens });
      render(<ExternalWalletSwap />);
      expect(choices('Choose buy asset').map((option) => option.value)).toEqual(
        ['ETH', usdc, 'custom'],
      );
    },
  );
  it('selects the canonical USDC contract and reads it through the shared balance hook', () => {
    render(<ExternalWalletSwap />);
    fireEvent.change(screen.getByLabelText('Choose buy asset'), {
      target: { value: usdc },
    });
    expect((screen.getByLabelText('Buy token') as HTMLInputElement).value).toBe(
      usdc,
    );
    expect(mocks.asset).toHaveBeenCalledWith(wallet, usdc, base);
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('requests an ETH to native Base USDC quote through the existing quote flow', async () => {
    const usdcAsset = {
      ...to,
      address: usdc,
      symbol: 'USDC',
      decimals: 6,
      balance: 0n,
    };
    mocks.fresh.mockImplementation((_cache, _client, _wallet, token) =>
      Promise.resolve(token === zeroAddress ? from : usdcAsset),
    );
    render(<ExternalWalletSwap />);
    fireEvent.change(screen.getByLabelText('Choose buy asset'), {
      target: { value: usdc },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '0.000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByRole('button', { name: 'Review swap' });
    expect(mocks.quote).toHaveBeenCalledWith(
      wallet,
      from,
      usdcAsset,
      1000000000000n,
      base,
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('deduplicates owned USDC by contract, irrespective of address casing or discovery label', () => {
    mocks.tokens.mockReturnValue({
      data: {
        tokens: [
          {
            ...to,
            address: usdc.toLowerCase(),
            symbol: 'wrong label',
            verificationStatus: 'unknown',
          },
        ],
      },
    });
    render(<ExternalWalletSwap />);
    expect(
      choices('Choose buy asset').filter(
        (option) => option.value.toLowerCase() === usdc.toLowerCase(),
      ),
    ).toHaveLength(1);
    expect(
      choices('Choose sell asset').find((option) => option.value === usdc)
        ?.textContent,
    ).toContain('USDC — native USDC on Base');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('does not promote same-symbol tokens or bridged USDbC to the native USDC default', () => {
    const bridged = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';
    mocks.tokens.mockReturnValue({
      data: {
        tokens: [
          {
            ...to,
            address: contract,
            symbol: 'USDC',
            verificationStatus: 'unknown',
          },
          {
            ...to,
            address: bridged,
            symbol: 'USDbC',
            verificationStatus: 'verified',
          },
          { ...to, address: usdc, chainId: 1, verificationStatus: 'verified' },
        ],
      },
    });
    render(<ExternalWalletSwap />);
    expect(choices('Choose buy asset').map((option) => option.value)).toEqual([
      'ETH',
      usdc,
      bridged,
      'custom',
    ]);
    expect(
      choices('Choose sell asset').some((option) => option.value === usdc),
    ).toBe(false);
    fireEvent.click(screen.getByRole('checkbox'));
    const lookalike = choices('Choose buy asset').find(
      (option) => option.value === contract,
    );
    expect(lookalike?.textContent).toContain('(unverified)');
    expect(lookalike?.textContent).not.toContain('native USDC');
  });
  it('selects buy and sell contracts independently without opening the wallet', () => {
    setupWeth();
    render(<ExternalWalletSwap />);
    fireEvent.change(screen.getByLabelText('Choose sell asset'), {
      target: { value: wethAddress },
    });
    fireEvent.change(screen.getByLabelText('Choose buy asset'), {
      target: { value: contract },
    });
    expect(
      (screen.getByLabelText('Sell token') as HTMLInputElement).value,
    ).toBe(wethAddress);
    expect((screen.getByLabelText('Buy token') as HTMLInputElement).value).toBe(
      contract,
    );
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('never silently switches an unverified selected contract to ETH when its list entry is hidden', () => {
    mocks.tokens.mockReturnValue({
      data: { tokens: [{ ...to, verificationStatus: 'unknown' }] },
      refetch: mocks.refetchTokens,
    });
    render(<ExternalWalletSwap />);
    const toggle = screen.getByRole('checkbox');
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('Choose sell asset'), {
      target: { value: contract },
    });
    fireEvent.click(toggle);
    expect(
      (screen.getByLabelText('Sell token') as HTMLInputElement).value,
    ).toBe(contract);
    expect(
      (screen.getByLabelText('Choose sell asset') as HTMLSelectElement).value,
    ).toBe('custom');
    expect(mocks.asset.mock.calls.slice(-2)).toEqual([
      [wallet, contract, base],
      [wallet, undefined, base],
    ]);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('ignores a late quote after account changes', async () => {
    let complete!: (quote: typeof wethRoute) => void;
    setupWeth();
    mocks.quote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = render(<ExternalWalletSwap />);
    fireEvent.change(screen.getByLabelText('Choose buy asset'), {
      target: { value: wethAddress },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '0.25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await waitFor(() => expect(mocks.quote).toHaveBeenCalledOnce());
    mocks.walletAddress = contract;
    view.rerender(<ExternalWalletSwap />);
    await act(async () => complete(wethRoute));
    expect(screen.queryByRole('button', { name: 'Review swap' })).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
async function getQuote() {
  fireEvent.change(screen.getByLabelText(/Buy token/), {
    target: { value: contract },
  });
  fireEvent.change(screen.getByLabelText('Amount'), {
    target: { value: '0.000001' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
  await screen.findByRole('button', { name: 'Review swap' });
}
describe('LI.FI swap balance integration', () => {
  it('lists all verified wallet tokens even when ETH is already entered', () => {
    mocks.tokens.mockReturnValue({
      data: {
        tokens: [
          { ...from, verificationStatus: 'verified' },
          { ...to, verificationStatus: 'verified' },
          {
            ...to,
            address: '0x4200000000000000000000000000000000000006',
            symbol: 'WETH',
            verificationStatus: 'verified',
          },
        ],
      },
      refetch: mocks.refetchTokens,
    });
    render(<ExternalWalletSwap />);
    const sell = screen.getByLabelText(
      'Choose sell asset',
    ) as HTMLSelectElement;
    expect(sell.options).toHaveLength(4);
    expect(sell.textContent).toContain('TOKEN');
    expect(sell.textContent).toContain('WETH');
    fireEvent.change(sell, { target: { value: contract } });
    expect(
      (screen.getByLabelText('Sell token') as HTMLInputElement).value,
    ).toBe(contract);
    expect(mocks.asset).toHaveBeenCalledWith(wallet, contract, base);
  });
  it('reveals unverified tokens with explicit labels and keeps them distinct by contract', () => {
    mocks.tokens.mockReturnValue({
      data: {
        tokens: [
          { ...to, verificationStatus: 'verified' },
          {
            ...to,
            address: '0x3333333333333333333333333333333333333333',
            verificationStatus: 'unknown',
          },
        ],
      },
      refetch: mocks.refetchTokens,
    });
    render(<ExternalWalletSwap />);
    const sell = screen.getByLabelText(
      'Choose sell asset',
    ) as HTMLSelectElement;
    expect(sell.options).toHaveLength(3);
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Show unverified tokens (1)' }),
    );
    expect(sell.options).toHaveLength(4);
    expect(sell.textContent).toContain('(unverified)');
    expect(screen.getByText(/may include spam/)).toBeTruthy();
    expect(sell.options[1].value).not.toBe(sell.options[2].value);
  });
  it('can refresh discovery and retain manual contract entry when discovery fails', () => {
    mocks.tokens.mockReturnValue({
      isError: true,
      refetch: mocks.refetchTokens,
    });
    render(<ExternalWalletSwap />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh token list' }));
    expect(mocks.refetchTokens).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText('Sell token'), {
      target: { value: contract },
    });
    expect(
      (screen.getByLabelText('Choose sell asset') as HTMLSelectElement).value,
    ).toBe('custom');
    expect(mocks.asset).toHaveBeenCalledWith(wallet, contract, base);
    expect(screen.getByText(/token list unavailable/)).toBeTruthy();
  });
  it('clears an existing quote when a different dropdown token is selected', async () => {
    render(<ExternalWalletSwap />);
    await getQuote();
    fireEvent.change(screen.getByLabelText('Choose sell asset'), {
      target: { value: 'custom' },
    });
    expect(screen.queryByRole('button', { name: 'Review swap' })).toBeNull();
  });
  async function tokenQuote() {
    const spender = '0x3333333333333333333333333333333333333333';
    mocks.fresh.mockImplementation((_cache, _client, _wallet, token) =>
      Promise.resolve(
        token === zeroAddress ? from : { ...to, balance: 5000000n },
      ),
    );
    mocks.quote.mockResolvedValue({
      tool: 'test',
      estimate: {
        toAmount: '1000',
        toAmountMin: '990',
        approvalAddress: spender,
      },
      transactionRequest: { to: spender, data: '0xabcd', value: '0x0' },
    });
    fireEvent.change(screen.getByLabelText(/Sell token/), {
      target: { value: contract },
    });
    fireEvent.change(screen.getByLabelText(/Buy token/), {
      target: { value: 'ETH' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '1.25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByRole('button', { name: 'Approve TOKEN' });
  }
  it('approves only the exact amount before sending a token swap', async () => {
    render(<ExternalWalletSwap />);
    await tokenQuote();
    mocks.readContract.mockResolvedValueOnce(0n).mockResolvedValue(1250000n);
    fireEvent.click(screen.getByRole('button', { name: 'Approve TOKEN' }));
    await screen.findByRole('button', { name: 'Review swap' });
    expect(mocks.request).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    const approval = mocks.request.mock.calls[0][0].params[0];
    expect(approval.chainId).toBe('0x2105');
    expect(approval.to).toBe(contract);
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.data })).toEqual({
      functionName: 'approve',
      args: ['0x3333333333333333333333333333333333333333', 1250000n],
    });
  });
  it('never sends the swap if the approval receipt reverted', async () => {
    mocks.wait.mockResolvedValue({ status: 'reverted' });
    render(<ExternalWalletSwap />);
    await tokenQuote();
    fireEvent.click(screen.getByRole('button', { name: 'Approve TOKEN' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'approval reverted',
    );
    expect(mocks.request).toHaveBeenCalledOnce();
  });
  it('only reports confirmation after a successful receipt and refreshes balances', async () => {
    const view = render(<ExternalWalletSwap />);
    await getQuote();
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await screen.findByRole('link');
    mocks.receipt.mockReturnValue({
      data: { transactionHash: hash, status: 'success' },
      isError: false,
    });
    view.rerender(<ExternalWalletSwap />);
    expect(screen.getByRole('status').textContent).toContain(
      'Swap confirmed on Base',
    );
    expect(mocks.refresh).toHaveBeenCalledWith(
      mocks.queryClient,
      wallet,
      base.id,
    );
  });
  it('blocks duplicate execution clicks', async () => {
    let resolve!: (value: string) => void;
    mocks.request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<ExternalWalletSwap />);
    await getQuote();
    const button = screen.getByRole('button', { name: 'Review swap' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    await act(async () => resolve(hash));
  });
  it('uses shared balances and gets a read-only quote', async () => {
    render(<ExternalWalletSwap />);
    await getQuote();
    expect(screen.getByText('Available on Base: 1 ETH')).toBeTruthy();
    expect(mocks.asset).toHaveBeenCalledWith(wallet, contract, base);
    expect(mocks.quote).toHaveBeenCalledWith(
      wallet,
      from,
      to,
      1000000000000n,
      base,
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('checks balances again before signing and refreshes after submission', async () => {
    render(<ExternalWalletSwap />);
    await getQuote();
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        params: [expect.objectContaining({ chainId: '0x2105', from: wallet })],
      }),
    );
    expect(mocks.refresh).toHaveBeenCalledWith(
      mocks.queryClient,
      wallet,
      base.id,
    );
    expect((await screen.findByRole('status')).textContent).toContain(
      'Waiting for confirmation',
    );
  });
  it('blocks spending when the live balance fell since the quote', async () => {
    render(<ExternalWalletSwap />);
    await getQuote();
    mocks.fresh.mockResolvedValue({ ...from, balance: 0n });
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Insufficient',
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('rejects excess fractional precision instead of rounding', async () => {
    render(<ExternalWalletSwap />);
    fireEvent.change(screen.getByLabelText(/Buy token/), {
      target: { value: contract },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '0.0000000000000000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'decimal places',
    );
    expect(mocks.quote).not.toHaveBeenCalled();
  });
  it('handles rejection without retrying the transaction', async () => {
    mocks.request.mockRejectedValue(new Error('User rejected request'));
    render(<ExternalWalletSwap />);
    await getQuote();
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'rejected',
    );
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('requires new review if the refreshed minimum worsens', async () => {
    render(<ExternalWalletSwap />);
    await getQuote();
    mocks.quote.mockResolvedValue({ estimate: { toAmountMin: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Quote changed',
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('does not sign after the view unmounts during preflight', async () => {
    let resolve!: () => void;
    mocks.guard.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const view = render(<ExternalWalletSwap />);
    await getQuote();
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    view.unmount();
    await act(async () => resolve());
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe('Ethereum swap integration', () => {
  const ethereumUsdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const ethereumNative = { ...from, chainId: mainnet.id };
  const ethereumUsdcAsset = {
    ...to,
    chainId: mainnet.id,
    address: ethereumUsdc,
    symbol: 'USDC',
    decimals: 6,
  };

  it('uses Ethereum USDC, quote validation inputs, transaction fields, and Etherscan', async () => {
    mocks.asset.mockImplementation((_wallet, token) => ({
      data: token === zeroAddress ? ethereumNative : ethereumUsdcAsset,
      isError: false,
    }));
    mocks.fresh.mockImplementation((_cache, _client, _wallet, token) =>
      Promise.resolve(
        token === zeroAddress ? ethereumNative : ethereumUsdcAsset,
      ),
    );
    mocks.quote.mockResolvedValue({
      tool: 'ethereum-test',
      action: { fromAmount: '1000000000000' },
      estimate: { toAmount: '1000', toAmountMin: '990' },
      transactionRequest: {
        to: contract,
        data: '0xabcd',
        value: '0xe8d4a51000',
        maxFeePerGas: '0x64',
        maxPriorityFeePerGas: '0x2',
      },
    });

    render(<ExternalWalletSwap chain={mainnet} />);
    const buyOptions = Array.from(
      (screen.getByLabelText('Choose buy asset') as HTMLSelectElement).options,
    );
    expect(buyOptions.map((option) => option.value)).toEqual([
      'ETH',
      ethereumUsdc,
      'custom',
    ]);
    expect(buyOptions[1].textContent).toContain('native USDC on Ethereum');
    fireEvent.change(screen.getByLabelText('Choose buy asset'), {
      target: { value: ethereumUsdc },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '0.000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByRole('button', { name: 'Review swap' });
    expect(mocks.quote).toHaveBeenCalledWith(
      wallet,
      ethereumNative,
      ethereumUsdcAsset,
      1000000000000n,
      mainnet,
    );
    expect(
      screen.getByRole('region', { name: 'Review Ethereum swap' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await screen.findByRole('link', { name: /Etherscan/ });
    expect(mocks.guard).toHaveBeenCalledWith(provider, wallet, mainnet);
    expect(mocks.request).toHaveBeenCalledWith({
      method: 'eth_sendTransaction',
      params: [
        expect.objectContaining({
          chainId: '0x1',
          from: wallet,
          maxFeePerGas: '0x64',
          maxPriorityFeePerGas: '0x2',
        }),
      ],
    });
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://etherscan.io/tx/${hash}`,
    );
    expect(mocks.refresh).toHaveBeenCalledWith(
      mocks.queryClient,
      wallet,
      mainnet.id,
    );
  });

  it('approves exactly the Ethereum token amount and confirms its allowance before swap review', async () => {
    const fundedUsdc = { ...ethereumUsdcAsset, balance: 2_000_000n };
    mocks.tokens.mockReturnValue({
      data: { tokens: [{ ...fundedUsdc, verificationStatus: 'verified' }] },
      refetch: mocks.refetchTokens,
    });
    mocks.asset.mockImplementation((_wallet, token) => ({
      data: token === zeroAddress ? ethereumNative : fundedUsdc,
      isError: false,
    }));
    mocks.fresh.mockImplementation((_cache, _client, _wallet, token) =>
      Promise.resolve(token === zeroAddress ? ethereumNative : fundedUsdc),
    );
    mocks.quote.mockResolvedValue({
      tool: 'ethereum-test',
      estimate: {
        toAmount: '1000000000000000',
        toAmountMin: '990000000000000',
        approvalAddress: spender,
      },
      transactionRequest: { to: spender, data: '0xabcd', value: '0x0' },
    });
    mocks.readContract
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValue(1_000_000n);

    render(<ExternalWalletSwap chain={mainnet} />);
    fireEvent.change(screen.getByLabelText('Choose sell asset'), {
      target: { value: ethereumUsdc },
    });
    fireEvent.change(screen.getByLabelText('Choose buy asset'), {
      target: { value: 'ETH' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByRole('button', { name: 'Approve USDC' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve USDC' }));
    await screen.findByRole('button', { name: 'Review swap' });
    expect(mocks.request).toHaveBeenCalledOnce();
    const approval = mocks.request.mock.calls[0][0].params[0];
    expect(approval).toMatchObject({
      chainId: '0x1',
      from: wallet,
      to: ethereumUsdc,
    });
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.data })).toEqual({
      functionName: 'approve',
      args: [spender, 1_000_000n],
    });
    expect(mocks.wait).toHaveBeenCalledWith({ hash });
    expect(mocks.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        blockNumber: 123n,
        address: ethereumUsdc,
        args: [wallet, spender],
      }),
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Approval confirmed',
    );
  });
});

describe('Arbitrum swap integration', () => {
  const arbitrumUsdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
  const arbitrumNative = { ...from, chainId: arbitrum.id };
  const arbitrumUsdcAsset = {
    ...to,
    chainId: arbitrum.id,
    address: arbitrumUsdc,
    symbol: 'USDC',
    decimals: 6,
  };

  it('uses Arbitrum USDC, transaction fields, and Arbiscan', async () => {
    mocks.asset.mockImplementation((_wallet, token) => ({
      data: token === zeroAddress ? arbitrumNative : arbitrumUsdcAsset,
      isError: false,
    }));
    mocks.fresh.mockImplementation((_cache, _client, _wallet, token) =>
      Promise.resolve(
        token === zeroAddress ? arbitrumNative : arbitrumUsdcAsset,
      ),
    );
    mocks.quote.mockResolvedValue({
      tool: 'arbitrum-test',
      action: { fromAmount: '1000000000000' },
      estimate: { toAmount: '1000', toAmountMin: '990' },
      transactionRequest: {
        to: contract,
        data: '0xabcd',
        value: '0xe8d4a51000',
        maxFeePerGas: '0x64',
        maxPriorityFeePerGas: '0x2',
      },
    });

    render(<ExternalWalletSwap chain={arbitrum} />);
    const buyOptions = Array.from(
      (screen.getByLabelText('Choose buy asset') as HTMLSelectElement).options,
    );
    expect(buyOptions.map((option) => option.value)).toEqual([
      'ETH',
      arbitrumUsdc,
      'custom',
    ]);
    expect(buyOptions[1].textContent).toContain('native USDC on Arbitrum One');
    fireEvent.change(screen.getByLabelText('Choose buy asset'), {
      target: { value: arbitrumUsdc },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '0.000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByRole('button', { name: 'Review swap' });
    expect(mocks.quote).toHaveBeenCalledWith(
      wallet,
      arbitrumNative,
      arbitrumUsdcAsset,
      1000000000000n,
      arbitrum,
    );
    expect(
      screen.getByRole('region', { name: 'Review Arbitrum One swap' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await screen.findByRole('link', { name: /Arbiscan/ });
    expect(mocks.guard).toHaveBeenCalledWith(provider, wallet, arbitrum);
    expect(mocks.request).toHaveBeenCalledWith({
      method: 'eth_sendTransaction',
      params: [
        expect.objectContaining({
          chainId: '0xa4b1',
          from: wallet,
          maxFeePerGas: '0x64',
          maxPriorityFeePerGas: '0x2',
        }),
      ],
    });
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://arbiscan.io/tx/${hash}`,
    );
    expect(mocks.refresh).toHaveBeenCalledWith(
      mocks.queryClient,
      wallet,
      arbitrum.id,
    );
  });
});

describe('BNB Smart Chain swap integration', () => {
  const bscUsdc = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
  const bscNative = {
    ...from,
    chainId: bsc.id,
    symbol: 'BNB',
    name: 'BNB',
  };
  const bscUsdcAsset = {
    ...to,
    chainId: bsc.id,
    address: bscUsdc,
    symbol: 'USDC',
    decimals: 18,
  };

  it('uses verified Binance-Peg USDC, BSC transaction fields, and BscScan', async () => {
    mocks.asset.mockImplementation((_wallet, token) => ({
      data: token === zeroAddress ? bscNative : bscUsdcAsset,
      isError: false,
    }));
    mocks.fresh.mockImplementation((_cache, _client, _wallet, token) =>
      Promise.resolve(token === zeroAddress ? bscNative : bscUsdcAsset),
    );
    mocks.quote.mockResolvedValue({
      tool: 'bsc-test',
      action: { fromAmount: '1000000000000' },
      estimate: {
        toAmount: '1000000000000000',
        toAmountMin: '990000000000000',
      },
      transactionRequest: {
        to: contract,
        data: '0xabcd',
        value: '0xe8d4a51000',
        gasPrice: '0x64',
      },
    });

    render(<ExternalWalletSwap chain={bsc} />);
    const buyOptions = Array.from(
      (screen.getByLabelText('Choose buy asset') as HTMLSelectElement).options,
    );
    expect(buyOptions.map((option) => option.value)).toEqual([
      'BNB',
      bscUsdc,
      'custom',
    ]);
    expect(buyOptions[1].textContent).toContain(
      'Binance-Peg USDC on BNB Smart Chain',
    );
    fireEvent.change(screen.getByLabelText('Choose buy asset'), {
      target: { value: bscUsdc },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '0.000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByRole('button', { name: 'Review swap' });
    expect(mocks.quote).toHaveBeenCalledWith(
      wallet,
      bscNative,
      bscUsdcAsset,
      1000000000000n,
      bsc,
    );
    expect(
      screen.getByRole('region', { name: 'Review BNB Smart Chain swap' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await screen.findByRole('link', { name: /BscScan/ });
    expect(mocks.guard).toHaveBeenCalledWith(provider, wallet, bsc);
    expect(mocks.request).toHaveBeenCalledWith({
      method: 'eth_sendTransaction',
      params: [
        expect.objectContaining({
          chainId: '0x38',
          from: wallet,
          gasPrice: '0x64',
        }),
      ],
    });
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://bscscan.com/tx/${hash}`,
    );
    expect(mocks.refresh).toHaveBeenCalledWith(
      mocks.queryClient,
      wallet,
      bsc.id,
    );
  });
});
