// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useWalletNetworkController } from '~/hooks/useWalletNetworkController';

function walletProvider(initialChain = '0x2105') {
  let chain = initialChain;
  const listeners = new Set<(chainId: unknown) => void>();
  const request = vi.fn(async ({ method, params }) => {
    if (method === 'eth_chainId') {
      return chain;
    }
    if (method === 'wallet_switchEthereumChain') {
      chain = params[0].chainId;
      listeners.forEach((listener) => listener(chain));
      return null;
    }
    if (method === 'wallet_addEthereumChain') {
      return null;
    }
    throw new Error(`Unexpected method ${method}`);
  });
  return {
    request,
    on: vi.fn((_event, listener) => listeners.add(listener)),
    removeListener: vi.fn((_event, listener) => listeners.delete(listener)),
    emit(chainId: unknown) {
      chain = String(chainId);
      listeners.forEach((listener) => listener(chainId));
    },
  };
}

afterEach(cleanup);

describe('shared wallet network controller', () => {
  it('starts disconnected without inventing a wallet network', () => {
    const { result } = renderHook(() => useWalletNetworkController());
    expect(result.current).toMatchObject({
      actualChainId: undefined,
      selectedChainId: 8453,
      previousWorkingChainId: undefined,
      status: 'disconnected',
    });
  });

  it('reads Base from the wallet and remembers it as the last working network', async () => {
    const provider = walletProvider();
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.actualChainId).toBe(8453);
    expect(result.current.previousWorkingChainId).toBe(8453);
    expect(provider.on).toHaveBeenCalledWith(
      'chainChanged',
      expect.any(Function),
    );
  });

  it('follows confirmed Ethereum once its read-only dashboard is enabled', async () => {
    const provider = walletProvider('0x1');
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toMatchObject({
      actualChainId: 1,
      selectedChainId: 1,
      previousWorkingChainId: 1,
    });
  });

  it('follows confirmed BNB Smart Chain once its dashboard is enabled', async () => {
    const provider = walletProvider('0x38');
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toMatchObject({
      actualChainId: 56,
      selectedChainId: 56,
      previousWorkingChainId: 56,
    });
  });

  it('follows confirmed Celo once its read-only dashboard is enabled', async () => {
    const provider = walletProvider('0xa4ec');
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toMatchObject({
      actualChainId: 42220,
      selectedChainId: 42220,
      previousWorkingChainId: 42220,
    });
  });

  it('follows confirmed Monad once its read-only dashboard is enabled', async () => {
    const provider = walletProvider('0x8f');
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toMatchObject({
      actualChainId: 143,
      selectedChainId: 143,
      previousWorkingChainId: 143,
    });
  });

  it('follows confirmed HyperEVM once its read-only dashboard is enabled', async () => {
    const provider = walletProvider('0x3e7');
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toMatchObject({
      actualChainId: 999,
      selectedChainId: 999,
      previousWorkingChainId: 999,
    });
  });

  it('switches from Base to Ethereum and adopts it only after confirmation', async () => {
    const provider = walletProvider();
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await expect(result.current.switchNetwork(1)).resolves.toBe(true);
    });
    expect(provider.request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x1' }],
    });
    expect(result.current).toMatchObject({
      actualChainId: 1,
      selectedChainId: 1,
      previousWorkingChainId: 1,
      status: 'ready',
    });
  });

  it('keeps Base selected when an Ethereum switch is rejected', async () => {
    const provider = walletProvider();
    provider.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_chainId') {
        return '0x2105';
      }
      if (method === 'wallet_switchEthereumChain') {
        throw { code: 4001 };
      }
      return null;
    });
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await expect(result.current.switchNetwork(1)).resolves.toBe(false);
    });
    expect(result.current).toMatchObject({
      actualChainId: 8453,
      selectedChainId: 8453,
      status: 'error',
      error: expect.objectContaining({ kind: 'rejected' }),
    });
  });

  it('detects a network change initiated by the wallet or a miniapp', async () => {
    const provider = walletProvider();
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => provider.emit('0x1e240'));
    expect(result.current).toMatchObject({
      actualChainId: 123456,
      selectedChainId: 8453,
      previousWorkingChainId: 8453,
      status: 'mismatch',
    });
  });

  it('checks the wallet network again without requesting a switch', async () => {
    const provider = walletProvider('0x1e240');
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('mismatch'));
    act(() => provider.emit('0x2105'));
    await act(async () => {
      await expect(result.current.refreshNetwork()).resolves.toBe(true);
    });
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'wallet_switchEthereumChain' }),
    );
    expect(result.current.status).toBe('ready');
  });

  it('reports a failed wallet network check', async () => {
    const provider = walletProvider('0x1e240');
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('mismatch'));
    provider.request.mockRejectedValueOnce(new Error('transport unavailable'));
    await act(async () => {
      await expect(result.current.refreshNetwork()).resolves.toBe(false);
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe(
      'Could not read the connected wallet network.',
    );
  });

  it('switches back to Base and verifies the wallet result', async () => {
    const provider = walletProvider('0x1e240');
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('mismatch'));
    await act(async () => {
      await expect(result.current.switchNetwork(8453)).resolves.toBe(true);
    });
    expect(provider.request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x2105' }],
    });
    expect(result.current.status).toBe('ready');
  });

  it('keeps the actual network and reports user rejection separately', async () => {
    const provider = walletProvider('0x38');
    provider.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_chainId') {
        return '0x38';
      }
      throw { code: 4001 };
    });
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.actualChainId).toBe(56));
    await act(async () => {
      await expect(result.current.switchNetwork(8453)).resolves.toBe(false);
    });
    expect(result.current.actualChainId).toBe(56);
    expect(result.current.error?.kind).toBe('rejected');
    expect(result.current.status).toBe('error');
  });

  it('accepts a confirmed switch even if the wallet reports an error afterward', async () => {
    const provider = walletProvider('0x38');
    let switched = false;
    provider.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_chainId') {
        return switched ? '0x2105' : '0x38';
      }
      if (method === 'wallet_switchEthereumChain') {
        switched = true;
        throw new Error('Wallet transport closed');
      }
      return null;
    });
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.actualChainId).toBe(56));
    await act(async () => {
      await expect(result.current.switchNetwork(8453)).resolves.toBe(true);
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeUndefined();
  });

  it('distinguishes a network that has not been added', async () => {
    const provider = walletProvider('0x38');
    provider.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_chainId') {
        return '0x38';
      }
      throw { code: 4902 };
    });
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.actualChainId).toBe(56));
    await act(async () => {
      await result.current.switchNetwork(8453);
    });
    expect(result.current.error?.kind).toBe('network_not_added');
  });

  it('adds Base with complete metadata and confirms the subsequent switch', async () => {
    const provider = walletProvider('0x38');
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.actualChainId).toBe(56));
    await act(async () => {
      await expect(result.current.addNetwork(8453)).resolves.toBe(true);
    });
    expect(provider.request).toHaveBeenCalledWith({
      method: 'wallet_addEthereumChain',
      params: [
        expect.objectContaining({
          chainId: '0x2105',
          chainName: 'Base',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        }),
      ],
    });
    expect(result.current.status).toBe('ready');
  });

  it('refuses unimplemented dashboard chains without prompting the wallet', async () => {
    const provider = walletProvider();
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await expect(result.current.switchNetwork(123456)).resolves.toBe(false);
    });
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'wallet_switchEthereumChain' }),
    );
    expect(result.current.actualChainId).toBe(8453);
  });

  it('allows only one network prompt at a time', async () => {
    let finish!: (value: string | null) => void;
    const provider = walletProvider('0x38');
    provider.request.mockImplementation(({ method }) => {
      if (method === 'eth_chainId') {
        return Promise.resolve('0x38');
      }
      return new Promise<string | null>((resolve) => {
        finish = resolve;
      });
    });
    const { result } = renderHook(() =>
      useWalletNetworkController(provider as never),
    );
    await waitFor(() => expect(result.current.actualChainId).toBe(56));
    let first!: Promise<boolean>;
    act(() => {
      first = result.current.switchNetwork(8453);
    });
    await waitFor(() => expect(result.current.status).toBe('switching'));
    await expect(result.current.switchNetwork(8453)).resolves.toBe(false);
    expect(
      provider.request.mock.calls.filter(
        ([request]) => request.method === 'wallet_switchEthereumChain',
      ),
    ).toHaveLength(1);
    await act(async () => {
      finish(null);
      await first;
    });
  });

  it('ignores a late chain response from a disconnected provider', async () => {
    let resolve!: (value: string) => void;
    const old = walletProvider();
    old.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const current = walletProvider('0x1e240');
    const view = renderHook(
      ({ provider }) => useWalletNetworkController(provider as never),
      { initialProps: { provider: old } },
    );
    view.rerender({ provider: current });
    await waitFor(() => expect(view.result.current.actualChainId).toBe(123456));
    await act(async () => resolve('0x2105'));
    expect(view.result.current.actualChainId).toBe(123456);
    expect(old.removeListener).toHaveBeenCalled();
  });

  it('ignores a switch that finishes after another wallet becomes active', async () => {
    let finish!: () => void;
    const old = walletProvider('0x38');
    old.request.mockImplementation(({ method }) => {
      if (method === 'eth_chainId') {
        return Promise.resolve('0x38');
      }
      return new Promise<null>((resolve) => {
        finish = () => resolve(null);
      });
    });
    const current = walletProvider('0x1e240');
    const view = renderHook(
      ({ provider }) => useWalletNetworkController(provider as never),
      { initialProps: { provider: old } },
    );
    await waitFor(() => expect(view.result.current.actualChainId).toBe(56));
    let switching!: Promise<boolean>;
    act(() => {
      switching = view.result.current.switchNetwork(8453);
    });
    await waitFor(() => expect(view.result.current.status).toBe('switching'));
    view.rerender({ provider: current });
    await waitFor(() => expect(view.result.current.status).toBe('mismatch'));
    await act(async () => {
      finish();
      await switching;
    });
    expect(view.result.current.actualChainId).toBe(123456);
    expect(view.result.current.error).toBeUndefined();
  });
});
