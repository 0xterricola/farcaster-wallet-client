import { walletConnect } from '@wagmi/connectors';
import { hyperevm, robinhood } from 'farcaster-client-data';
import { bsc, degen, monad, monadTestnet, unichain } from 'viem/chains';
import { Config, createConfig, http, Transport } from 'wagmi';
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  celo,
  gnosis,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  sepolia,
  zora,
} from 'wagmi/chains';

const chains = [
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  degen,
  gnosis,
  optimism,
  optimismSepolia,
  polygon,
  zora,
  unichain,
  monad,
  monadTestnet,
  celo,
  sepolia,
  mainnet,
  bsc,
  hyperevm,
  robinhood,
] as const;

// viem's default Ethereum RPC currently rejects browser CORS requests. Keep a
// browser-compatible public default while allowing deployments to bring their
// own authenticated or self-hosted endpoint.
const ethereumRpcUrl =
  import.meta.env.VITE_ETHEREUM_RPC_URL ||
  'https://ethereum-rpc.publicnode.com';

// Arbitrum's official RPC allows browser requests. Keep it explicit so the
// wallet dashboard does not silently inherit a changing viem default.
const arbitrumRpcUrl =
  import.meta.env.VITE_ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';

// Use BNB Chain's browser-tested official endpoint rather than the package's
// third-party default. Deployments can replace it with their own public RPC.
const bscRpcUrl =
  import.meta.env.VITE_BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org';

// Celo's documented best-effort endpoint accepts browser requests. Keep an
// override for deployments that need a dedicated provider or higher limits.
const celoRpcUrl =
  import.meta.env.VITE_CELO_RPC_URL || 'https://forno.celo.org';

// Monad's mainnet endpoint accepts browser requests. Keep an override for
// deployments that need a dedicated provider or higher limits.
const monadRpcUrl =
  import.meta.env.VITE_MONAD_RPC_URL || 'https://rpc.monad.xyz';

// HyperEVM's mainnet endpoint accepts browser requests. Keep an override for
// deployments that need a dedicated provider or higher limits.
const hyperevmRpcUrl =
  import.meta.env.VITE_HYPEREVM_RPC_URL || 'https://rpc.hyperliquid.xyz/evm';

// Robinhood Chain's mainnet endpoint accepts browser requests. Keep an override
// for deployments that need a dedicated provider or higher limits.
const robinhoodRpcUrl =
  import.meta.env.VITE_ROBINHOOD_RPC_URL ||
  'https://rpc.mainnet.chain.robinhood.com';

const transports = chains.reduce(
  (acc, chain) => {
    const rpcUrl =
      chain.id === mainnet.id
        ? ethereumRpcUrl
        : chain.id === arbitrum.id
          ? arbitrumRpcUrl
          : chain.id === bsc.id
            ? bscRpcUrl
            : chain.id === celo.id
              ? celoRpcUrl
              : chain.id === monad.id
                ? monadRpcUrl
                : chain.id === hyperevm.id
                  ? hyperevmRpcUrl
                  : chain.id === robinhood.id
                    ? robinhoodRpcUrl
                    : undefined;
    acc[chain.id] = http(rpcUrl);
    return acc;
  },
  {} as Record<number, Transport>,
);

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
const appOrigin =
  typeof window === 'undefined'
    ? ['https:', '//farcaster.xyz'].join('')
    : window.location.origin;

const connectors = walletConnectProjectId
  ? [
      walletConnect({
        projectId: walletConnectProjectId,
        metadata: {
          name: 'Farcaster Wallet Client',
          description: 'Farcaster client with external wallet support',
          url: appOrigin,
          icons: [`${appOrigin}/favicon-v3.png`],
        },
        showQrModal: true,
      }),
    ]
  : [];

const wagmiConfig: Config = createConfig({
  chains,
  transports,
  connectors,
});

export { wagmiConfig };
