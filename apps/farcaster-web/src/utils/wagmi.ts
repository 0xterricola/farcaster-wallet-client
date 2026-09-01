import { walletConnect } from '@wagmi/connectors';
import { robinhood } from 'farcaster-client-data';
import { bsc, degen, monadTestnet, unichain } from 'viem/chains';
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
  monadTestnet,
  celo,
  sepolia,
  mainnet,
  bsc,
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

const transports = chains.reduce(
  (acc, chain) => {
    const rpcUrl =
      chain.id === mainnet.id
        ? ethereumRpcUrl
        : chain.id === arbitrum.id
          ? arbitrumRpcUrl
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
