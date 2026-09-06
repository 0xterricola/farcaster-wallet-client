import { describe, expect, it, vi } from 'vitest';

import {
  createMetaMaskConnectClientLoader,
  MetaMaskEVMClient,
  MetaMaskSolanaClient,
} from '~/utils/metamaskConnectClient';

function createFactories(options?: { failEvmOnce?: boolean }) {
  const provider = { request: vi.fn() };
  const wallet = { accounts: [], chains: [], features: {}, name: 'MetaMask' };
  const core = { connect: vi.fn(), disconnect: vi.fn(), provider: {} };
  let shouldFail = options?.failEvmOnce ?? false;

  const createEVMClient = vi.fn(async (_options: unknown) => {
    if (shouldFail) {
      shouldFail = false;
      throw new Error('Initialization failed.');
    }
    return {
      getProvider: () => provider,
    } as unknown as MetaMaskEVMClient;
  });
  const createSolanaClient = vi.fn(async (_options: unknown) => {
    return {
      core,
      getWallet: () => wallet,
    } as unknown as MetaMaskSolanaClient;
  });

  return {
    core,
    createEVMClient,
    createSolanaClient,
    provider,
    wallet,
  };
}

describe('createMetaMaskConnectClientLoader', () => {
  it('initializes one shared headless client bundle', async () => {
    const factories = createFactories();
    const loadClients = createMetaMaskConnectClientLoader(factories);

    const [first, second] = await Promise.all([
      loadClients({
        appOrigin: 'https://wallet.example',
        solanaRpcUrl: 'https://wallet.example/solana-rpc',
      }),
      loadClients({ appOrigin: 'https://ignored.example' }),
    ]);

    expect(first).toBe(second);
    expect(first).toMatchObject({
      core: factories.core,
      evmProvider: factories.provider,
      solanaWallet: factories.wallet,
    });
    expect(factories.createEVMClient).toHaveBeenCalledTimes(1);
    expect(factories.createSolanaClient).toHaveBeenCalledTimes(1);
  });

  it('keeps Unified MetaMask out of independent wallet discovery', async () => {
    const factories = createFactories();
    const loadClients = createMetaMaskConnectClientLoader(factories);

    await loadClients({
      appOrigin: 'https://wallet.example',
      solanaRpcUrl: 'https://wallet.example/solana-rpc',
    });

    expect(factories.createEVMClient).toHaveBeenCalledWith(
      expect.objectContaining({
        analytics: { enabled: false },
        dapp: {
          iconUrl: 'https://wallet.example/favicon-v3.png',
          name: 'Farcaster Wallet Client',
          url: 'https://wallet.example',
        },
        skipAutoAnnounce: true,
      }),
    );
    expect(factories.createSolanaClient).toHaveBeenCalledWith(
      expect.objectContaining({
        analytics: { enabled: false },
        api: {
          supportedNetworks: {
            mainnet: 'https://wallet.example/solana-rpc',
          },
        },
        skipAutoRegister: true,
      }),
    );
  });

  it('configures every dashboard-supported EVM network', async () => {
    const factories = createFactories();
    const loadClients = createMetaMaskConnectClientLoader(factories);

    await loadClients({ appOrigin: 'https://wallet.example' });

    const options = factories.createEVMClient.mock.calls[0]?.[0] as
      | { api?: { supportedNetworks?: Record<string, string> } }
      | undefined;
    expect(Object.keys(options?.api?.supportedNetworks ?? {})).toEqual([
      '0x1',
      '0x38',
      '0x8f',
      '0x3e7',
      '0x1237',
      '0x2105',
      '0xa4b1',
      '0xa4ec',
    ]);
  });

  it('retries after a failed initialization', async () => {
    const factories = createFactories({ failEvmOnce: true });
    const loadClients = createMetaMaskConnectClientLoader(factories);

    await expect(
      loadClients({ appOrigin: 'https://wallet.example' }),
    ).rejects.toThrow('Initialization failed.');
    await expect(
      loadClients({ appOrigin: 'https://wallet.example' }),
    ).resolves.toMatchObject({ evmProvider: factories.provider });

    expect(factories.createEVMClient).toHaveBeenCalledTimes(2);
    expect(factories.createSolanaClient).toHaveBeenCalledTimes(1);
  });
});
