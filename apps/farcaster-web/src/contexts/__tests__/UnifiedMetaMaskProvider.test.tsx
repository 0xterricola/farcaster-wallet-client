// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UnifiedMetaMaskProvider,
  useUnifiedMetaMask,
} from '~/contexts/UnifiedMetaMaskProvider';
import { getMetaMaskConnectClients } from '~/utils/metamaskConnectClient';
import { connectUnifiedMetaMask } from '~/utils/metamaskConnection';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/utils/metamaskConnectClient', () => ({
  getMetaMaskConnectClients: vi.fn(),
}));

vi.mock('~/utils/metamaskConnection', async () => {
  const actual = await vi.importActual<
    typeof import('~/utils/metamaskConnection')
  >('~/utils/metamaskConnection');
  return {
    ...actual,
    connectUnifiedMetaMask: vi.fn(),
  };
});

const getClientsMock = vi.mocked(getMetaMaskConnectClients);
const connectUnifiedMock = vi.mocked(connectUnifiedMetaMask);

let container: HTMLDivElement;
let root: Root;
let latest!: ReturnType<typeof useUnifiedMetaMask>;

const core = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  provider: { getSession: vi.fn() },
};
const connectSolanaWallet = vi.fn();
const clients = {
  core,
  evm: {},
  evmProvider: { request: vi.fn() },
  solana: {},
  solanaWallet: {
    features: {
      'standard:connect': { connect: connectSolanaWallet },
    },
    name: 'MetaMask',
  },
};

function Consumer() {
  latest = useUnifiedMetaMask();
  return null;
}

async function renderProvider() {
  await act(async () => {
    root.render(
      <UnifiedMetaMaskProvider>
        <Consumer />
      </UnifiedMetaMaskProvider>,
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  connectSolanaWallet.mockResolvedValue({
    accounts: [{ address: 'SolanaAddress' }],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getClientsMock.mockResolvedValue(clients as never);
});

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  if (container) {
    container.remove();
  }
});

describe('UnifiedMetaMaskProvider', () => {
  it('stays lazy when no Unified session was remembered', async () => {
    await renderProvider();

    expect(latest.status).toBe('disconnected');
    expect(getClientsMock).not.toHaveBeenCalled();
  });

  it('publishes both providers only after an atomic connection succeeds', async () => {
    connectUnifiedMock.mockResolvedValue({
      ok: true,
      evmAddress: '0xabc',
      solanaAddress: 'SolanaAddress',
    });
    await renderProvider();

    await act(async () => {
      await expect(latest.connect()).resolves.toBe(true);
    });

    expect(latest).toMatchObject({
      status: 'connected',
      evmAddress: '0xabc',
      evmProvider: clients.evmProvider,
      solanaAddress: 'SolanaAddress',
      solanaWallet: clients.solanaWallet,
    });
    expect(localStorage.getItem('unified_metamask_connected')).toBe('true');
    expect(connectSolanaWallet).toHaveBeenCalledWith({ silent: true });
  });

  it('does not publish addresses until the Solana signer is hydrated', async () => {
    connectUnifiedMock.mockResolvedValue({
      ok: true,
      evmAddress: '0xabc',
      solanaAddress: 'SolanaAddress',
    });
    connectSolanaWallet.mockResolvedValue({ accounts: [] });
    await renderProvider();

    await act(async () => {
      await expect(latest.connect()).resolves.toBe(false);
    });

    expect(latest).toMatchObject({
      status: 'error',
      evmAddress: undefined,
      solanaAddress: undefined,
    });
    expect(latest.error).toContain('signer did not become ready');
    expect(core.disconnect).toHaveBeenCalled();
    expect(localStorage.getItem('unified_metamask_connected')).toBeNull();
  });

  it('does not publish a partial connection', async () => {
    connectUnifiedMock.mockResolvedValue({
      ok: false,
      code: 'missing-solana-account',
      message: 'Enable Solana in MetaMask and try again.',
    });
    await renderProvider();

    await act(async () => {
      await expect(latest.connect()).resolves.toBe(false);
    });

    expect(latest).toMatchObject({
      status: 'error',
      error: 'Enable Solana in MetaMask and try again.',
      evmAddress: undefined,
      solanaAddress: undefined,
    });
    expect(localStorage.getItem('unified_metamask_connected')).toBeNull();
  });

  it('restores both sides from persisted SDK session truth', async () => {
    localStorage.setItem('unified_metamask_connected', 'true');
    core.provider.getSession.mockResolvedValue({
      sessionScopes: {
        'eip155:8453': { accounts: ['eip155:8453:0xabc'] },
        'solana:mainnet': {
          accounts: ['solana:mainnet:SolanaAddress'],
        },
      },
    });

    await renderProvider();

    expect(latest).toMatchObject({
      status: 'connected',
      evmAddress: '0xabc',
      solanaAddress: 'SolanaAddress',
    });
    expect(connectSolanaWallet).toHaveBeenCalledWith({ silent: true });
  });

  it('disconnects the complete shared session and clears both sides', async () => {
    connectUnifiedMock.mockResolvedValue({
      ok: true,
      evmAddress: '0xabc',
      solanaAddress: 'SolanaAddress',
    });
    await renderProvider();
    await act(async () => {
      await latest.connect();
      await latest.disconnect();
    });

    expect(core.disconnect).toHaveBeenCalled();
    expect(latest).toMatchObject({
      status: 'disconnected',
      evmAddress: undefined,
      solanaAddress: undefined,
    });
  });
});
