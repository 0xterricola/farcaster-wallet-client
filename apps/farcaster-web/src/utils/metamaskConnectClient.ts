type CreateEVMClient =
  (typeof import('@metamask/connect-evm'))['createEVMClient'];
type CreateSolanaClient =
  (typeof import('@metamask/connect-solana'))['createSolanaClient'];

export type MetaMaskEVMClient = Awaited<ReturnType<CreateEVMClient>>;
export type MetaMaskSolanaClient = Awaited<ReturnType<CreateSolanaClient>>;

export type MetaMaskConnectClients = Readonly<{
  core: MetaMaskSolanaClient['core'];
  evm: MetaMaskEVMClient;
  evmProvider: ReturnType<MetaMaskEVMClient['getProvider']>;
  solana: MetaMaskSolanaClient;
  solanaWallet: ReturnType<MetaMaskSolanaClient['getWallet']>;
}>;

export type MetaMaskConnectClientOptions = Readonly<{
  appOrigin?: string;
  solanaRpcUrl?: string;
}>;

type MetaMaskClientFactories = Readonly<{
  createEVMClient: CreateEVMClient;
  createSolanaClient: CreateSolanaClient;
}>;

const APP_NAME = 'Farcaster Wallet Client';

function browserOrigin(): string {
  return typeof window === 'undefined'
    ? 'https://farcaster.xyz'
    : window.location.origin;
}

function evmSupportedNetworks() {
  return {
    '0x1':
      import.meta.env.VITE_ETHEREUM_RPC_URL ||
      'https://ethereum-rpc.publicnode.com',
    '0x38':
      import.meta.env.VITE_BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org',
    '0x8f': import.meta.env.VITE_MONAD_RPC_URL || 'https://rpc.monad.xyz',
    '0x3e7':
      import.meta.env.VITE_HYPEREVM_RPC_URL ||
      'https://rpc.hyperliquid.xyz/evm',
    '0x1237':
      import.meta.env.VITE_ROBINHOOD_RPC_URL ||
      'https://rpc.mainnet.chain.robinhood.com',
    '0x2105': 'https://mainnet.base.org',
    '0xa4b1':
      import.meta.env.VITE_ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    '0xa4ec': import.meta.env.VITE_CELO_RPC_URL || 'https://forno.celo.org',
  } as const;
}

/**
 * Builds a retryable singleton loader. EVM is initialized first and Solana
 * then joins the MetaMask Connect multichain singleton created by the SDK.
 */
export function createMetaMaskConnectClientLoader(
  factories: MetaMaskClientFactories,
) {
  let clientsPromise: Promise<MetaMaskConnectClients> | undefined;

  return (
    options: MetaMaskConnectClientOptions = {},
  ): Promise<MetaMaskConnectClients> => {
    clientsPromise ??= (async () => {
      const appOrigin = options.appOrigin ?? browserOrigin();
      const dapp = {
        iconUrl: `${appOrigin}/favicon-v3.png`,
        name: APP_NAME,
        url: appOrigin,
      };
      const analytics = { enabled: false } as const;

      const evm = await factories.createEVMClient({
        analytics,
        api: { supportedNetworks: evmSupportedNetworks() },
        dapp,
        skipAutoAnnounce: true,
      });
      const solana = await factories.createSolanaClient({
        analytics,
        api: {
          supportedNetworks: {
            mainnet: options.solanaRpcUrl ?? `${appOrigin}/~wallet/solana-rpc`,
          },
        },
        dapp,
        skipAutoRegister: true,
      });

      return {
        core: solana.core,
        evm,
        evmProvider: evm.getProvider(),
        solana,
        solanaWallet: solana.getWallet(),
      };
    })().catch((error) => {
      // A cancelled or failed initialization must not poison every future
      // attempt with the same rejected promise.
      clientsPromise = undefined;
      throw error;
    });

    return clientsPromise;
  };
}

const loadMetaMaskConnectClients = createMetaMaskConnectClientLoader({
  createEVMClient: async (options) => {
    const { createEVMClient } = await import('@metamask/connect-evm');
    return createEVMClient(options);
  },
  createSolanaClient: async (options) => {
    const { createSolanaClient } = await import('@metamask/connect-solana');
    return createSolanaClient(options);
  },
});

export function getMetaMaskConnectClients(
  options?: MetaMaskConnectClientOptions,
): Promise<MetaMaskConnectClients> {
  return loadMetaMaskConnectClients(options);
}
