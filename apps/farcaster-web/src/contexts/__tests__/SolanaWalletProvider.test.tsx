// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import React, { act, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SolanaWalletProvider,
  useSolanaWallet,
} from '~/contexts/SolanaWalletProvider';
import { DetectedSolanaWallet } from '~/hooks/useDetectedSolanaWallets';
import { WALLET_CONNECT_WALLET_NAME } from '~/utils/solanaWalletConnect';

const mockUseDetectedSolanaWallets =
  vi.fn<() => readonly DetectedSolanaWallet[]>();

vi.mock('~/hooks/useDetectedSolanaWallets', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('~/hooks/useDetectedSolanaWallets')
  >()),
  useDetectedSolanaWallets: () => mockUseDetectedSolanaWallets(),
}));

function makeWallet({
  accounts = [],
  connectAccounts = [
    { address: 'SolanaAddress123', chains: ['solana:mainnet'] },
  ],
  name = 'Test Solana Wallet',
}: {
  accounts?: readonly {
    address: string;
    chains: readonly string[];
  }[];
  connectAccounts?: readonly {
    address: string;
    chains: readonly string[];
  }[];
  name?: string;
} = {}) {
  const connect = vi.fn().mockResolvedValue({ accounts: connectAccounts });
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const signTransaction = vi
    .fn()
    .mockResolvedValue([{ signedTransaction: new Uint8Array([4, 5, 6]) }]);
  const wallet: DetectedSolanaWallet = {
    accounts,
    chains: ['solana:mainnet'],
    features: {
      'solana:signTransaction': { signTransaction, version: '1.0.0' },
      'standard:connect': { connect, version: '1.0.0' },
      'standard:disconnect': { disconnect, version: '1.0.0' },
    },
    icon: 'data:image/png;base64,AA==',
    name,
    version: '1.0.0',
  };
  return { connect, disconnect, signTransaction, wallet };
}

function Wrapper({ children }: { children: ReactNode }) {
  return <SolanaWalletProvider>{children}</SolanaWalletProvider>;
}

describe('SolanaWalletProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseDetectedSolanaWallets.mockReset();
    mockUseDetectedSolanaWallets.mockReturnValue([]);
  });

  it('connects a Solana wallet without requiring any EVM state', async () => {
    const { connect, wallet } = makeWallet();
    mockUseDetectedSolanaWallets.mockReturnValue([wallet]);
    const view = renderHook(() => useSolanaWallet(), { wrapper: Wrapper });

    await act(async () => {
      expect(await view.result.current.connect(wallet)).toBe(true);
    });

    expect(connect).toHaveBeenCalledOnce();
    expect(view.result.current.address).toBe('SolanaAddress123');
    expect(view.result.current.status).toBe('connected');
    expect(localStorage.getItem('solana_wallet_name')).toBe(wallet.name);
  });

  it('restores an already-authorized account without opening a prompt', async () => {
    const account = {
      address: 'RestoredSolanaAddress',
      chains: ['solana:mainnet'],
    };
    const { connect, wallet } = makeWallet({ accounts: [account] });
    localStorage.setItem('solana_wallet_name', wallet.name);
    mockUseDetectedSolanaWallets.mockReturnValue([wallet]);

    const view = renderHook(() => useSolanaWallet(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(view.result.current.address).toBe(account.address);
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('silently restores a persisted WalletConnect session', async () => {
    const account = {
      address: 'RestoredWalletConnectAddress',
      chains: ['solana:mainnet'],
    };
    const { connect, wallet } = makeWallet({
      connectAccounts: [account],
      name: WALLET_CONNECT_WALLET_NAME,
    });
    localStorage.setItem('solana_wallet_name', wallet.name);
    mockUseDetectedSolanaWallets.mockReturnValue([wallet]);

    const view = renderHook(() => useSolanaWallet(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(view.result.current.address).toBe(account.address);
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ silent: true });
  });

  it('clears a remembered WalletConnect wallet when no session remains', async () => {
    const { connect, wallet } = makeWallet({
      connectAccounts: [],
      name: WALLET_CONNECT_WALLET_NAME,
    });
    localStorage.setItem('solana_wallet_name', wallet.name);
    mockUseDetectedSolanaWallets.mockReturnValue([wallet]);

    renderHook(() => useSolanaWallet(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(localStorage.getItem('solana_wallet_name')).toBeNull();
    });
    expect(connect).toHaveBeenCalledWith({ silent: true });
  });

  it('keeps the remembered WalletConnect wallet after a temporary restore error', async () => {
    const { connect, wallet } = makeWallet({
      name: WALLET_CONNECT_WALLET_NAME,
    });
    connect.mockRejectedValueOnce(new Error('Relay unavailable'));
    localStorage.setItem('solana_wallet_name', wallet.name);
    mockUseDetectedSolanaWallets.mockReturnValue([wallet]);

    renderHook(() => useSolanaWallet(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(connect).toHaveBeenCalledWith({ silent: true });
    });
    expect(localStorage.getItem('solana_wallet_name')).toBe(wallet.name);
  });

  it('disconnects only the selected Solana wallet', async () => {
    const { disconnect, wallet } = makeWallet();
    mockUseDetectedSolanaWallets.mockReturnValue([wallet]);
    const view = renderHook(() => useSolanaWallet(), { wrapper: Wrapper });

    await act(async () => {
      await view.result.current.connect(wallet);
    });
    expect(view.result.current.status).toBe('connected');

    await act(async () => {
      await view.result.current.disconnect();
    });

    expect(disconnect).toHaveBeenCalledOnce();
    expect(view.result.current.address).toBeUndefined();
    expect(view.result.current.status).toBe('disconnected');
    expect(localStorage.getItem('solana_wallet_name')).toBeNull();
  });

  it('signs through the connected Wallet Standard account', async () => {
    const { signTransaction, wallet } = makeWallet();
    mockUseDetectedSolanaWallets.mockReturnValue([wallet]);
    const view = renderHook(() => useSolanaWallet(), { wrapper: Wrapper });
    await act(async () => {
      await view.result.current.connect(wallet);
    });

    await expect(
      view.result.current.signTransaction(new Uint8Array([1, 2, 3])),
    ).resolves.toEqual(new Uint8Array([4, 5, 6]));
    expect(signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ address: 'SolanaAddress123' }),
        chain: 'solana:mainnet',
        transaction: new Uint8Array([1, 2, 3]),
      }),
    );
  });

  it('rejects a connection that does not return a mainnet account', async () => {
    const { wallet } = makeWallet({
      connectAccounts: [
        { address: 'DevnetAddress', chains: ['solana:devnet'] },
      ],
    });
    mockUseDetectedSolanaWallets.mockReturnValue([wallet]);
    const view = renderHook(() => useSolanaWallet(), { wrapper: Wrapper });

    await act(async () => {
      expect(await view.result.current.connect(wallet)).toBe(false);
    });

    expect(view.result.current.address).toBeUndefined();
    expect(view.result.current.status).toBe('error');
    expect(view.result.current.error).toContain('Solana Mainnet');
  });
});
