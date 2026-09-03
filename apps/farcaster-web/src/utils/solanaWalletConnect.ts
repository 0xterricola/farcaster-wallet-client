// Imported for its type only. The real module is loaded lazily inside
// getModal() -- see the comment there for why: merely importing it eagerly
// has a side effect that crashes under jsdom.
import type { WalletConnectModal } from '@walletconnect/modal';
import { UniversalProvider } from '@walletconnect/universal-provider';

import {
  DetectedSolanaAccount,
  DetectedSolanaWallet,
  SOLANA_CONNECT_FEATURE,
  SOLANA_DISCONNECT_FEATURE,
  SOLANA_EVENTS_FEATURE,
  SOLANA_MAINNET_CHAIN,
  SOLANA_SIGN_TRANSACTION_FEATURE,
} from '~/hooks/useDetectedSolanaWallets';

// WalletConnect's Solana namespace identifies the network by its genesis
// block hash per CAIP-2, not the human-readable 'solana:mainnet' string the
// Wallet Standard side of this app uses elsewhere. The two are not
// interchangeable: this constant is only ever sent to WalletConnect itself.
const SOLANA_MAINNET_CAIP2 =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SOLANA_SIGN_TRANSACTION_METHOD = 'solana_signTransaction';
const SOLANA_SIGN_MESSAGE_METHOD = 'solana_signMessage';

export const WALLET_CONNECT_WALLET_NAME = 'WalletConnect';

// Same icon already used for the EVM WalletConnect option.
export const WALLET_CONNECT_ICON =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjgiIGhlaWdodD0iMjgiIHZpZXdCb3g9IjAgMCAyOCAyOCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4lMEE8cmVjdCB3aWR0aD0iMjgiIGhlaWdodD0iMjgiIGZpbGw9IiMzQjk5RkMiLz4lMEE8cGF0aCBkPSJNOC4zODk2OSAxMC4zNzM5QzExLjQ4ODIgNy4yNzUzOCAxNi41MTE4IDcuMjc1MzggMTkuNjEwMyAxMC4zNzM5TDE5Ljk4MzIgMTAuNzQ2OEMyMC4xMzgyIDEwLjkwMTcgMjAuMTM4MiAxMS4xNTI5IDE5Ljk4MzIgMTEuMzA3OEwxOC43MDc2IDEyLjU4MzVDMTguNjMwMSAxMi42NjA5IDE4LjUwNDUgMTIuNjYwOSAxOC40MjcxIDEyLjU4MzVMMTcuOTEzOSAxMi4wNzAzQzE1Ljc1MjMgOS45MDg3IDEyLjI0NzcgOS45MDg3IDEwLjA4NjEgMTIuMDcwM0w5LjUzNjU1IDEyLjYxOThDOS40NTkwOSAxMi42OTczIDkuMzMzNSAxMi42OTczIDkuMjU2MDQgMTIuNjE5OEw3Ljk4MDM5IDExLjM0NDJDNy44MjU0NyAxMS4xODkzIDcuODI1NDcgMTAuOTM4MSA3Ljk4MDM5IDEwLjc4MzJMOC4zODk2OSAxMC4zNzM5Wk0yMi4yNDg1IDEzLjAxMkwyMy4zODM4IDE0LjE0NzRDMjMuNTM4NyAxNC4zMDIzIDIzLjUzODcgMTQuNTUzNSAyMy4zODM4IDE0LjcwODRMMTguMjY0NSAxOS44Mjc3QzE4LjEwOTYgMTkuOTgyNyAxNy44NTg0IDE5Ljk4MjcgMTcuNzAzNSAxOS44Mjc3QzE3LjcwMzUgMTkuODI3NyAxNy43MDM1IDE5LjgyNzcgMTcuNzAzNSAxOS44Mjc3TDE0LjA3MDIgMTYuMTk0NEMxNC4wMzE0IDE2LjE1NTcgMTMuOTY4NiAxNi4xNTU3IDEzLjkyOTkgMTYuMTk0NEMxMy45Mjk5IDE2LjE5NDQgMTMuOTI5OSAxNi4xOTQ0IDEzLjkyOTkgMTYuMTk0NEwxMC4yOTY2IDE5LjgyNzdDMTAuMTQxNyAxOS45ODI3IDkuODkwNTMgMTkuOTgyNyA5LjczNTYxIDE5LjgyNzhDOS43MzU2IDE5LjgyNzggOS43MzU2IDE5LjgyNzcgOS43MzU2IDE5LjgyNzdMNC42MTYxOSAxNC43MDgzQzQuNDYxMjcgMTQuNTUzNCA0LjQ2MTI3IDE0LjMwMjIgNC42MTYxOSAxNC4xNDczTDUuNzUxNTIgMTMuMDEyQzUuOTA2NDUgMTIuODU3IDYuMTU3NjMgMTIuODU3IDYuMzEyNTUgMTMuMDEyTDkuOTQ1OTUgMTYuNjQ1NEM5Ljk4NDY4IDE2LjY4NDEgMTAuMDQ3NSAxNi42ODQxIDEwLjA4NjIgMTYuNjQ1NEMxMC4wODYyIDE2LjY0NTQgMTAuMDg2MiAxNi42NDU0IDEwLjA4NjIgMTYuNjQ1NEwxMy43MTk0IDEzLjAxMkMxMy44NzQzIDEyLjg1NyAxNC4xMjU1IDEyLjg1NyAxNC4yODA1IDEzLjAxMkMxNC4yODA1IDEzLjAxMiAxNC4yODA1IDEzLjAxMiAxNC4yODA1IDEzLjAxMkwxNy45MTM5IDE2LjY0NTRDMTcuOTUyNiAxNi42ODQxIDE4LjAxNTQgMTYuNjg0MSAxOC4wNTQxIDE2LjY0NTRMMjEuNjg3NCAxMy4wMTJDMjEuODQyNCAxMi44NTcxIDIyLjA5MzYgMTIuODU3MSAyMi4yNDg1IDEzLjAxMloiIGZpbGw9IndoaXRlIi8+JTBBPC9zdmc+';

type SolanaSignTransactionResponse = {
  readonly signature?: string;
  readonly transaction?: string;
};

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function accountsFromSession(
  provider: InstanceType<typeof UniversalProvider>,
): readonly DetectedSolanaAccount[] {
  const caip10Accounts = provider.session?.namespaces.solana?.accounts ?? [];
  const addresses = new Set<string>();
  for (const caip10 of caip10Accounts) {
    // CAIP-10 format: 'solana:<chain-reference>:<address>'.
    const address = caip10.split(':')[2];
    if (address) {
      addresses.add(address);
    }
  }
  return [...addresses].map((address) => ({
    address,
    chains: [SOLANA_MAINNET_CHAIN],
  }));
}

// Wraps a single WalletConnect session behind the same Wallet Standard
// `features` shape every browser-extension wallet in this app already
// implements, so SolanaWalletProvider needs no WalletConnect-specific code
// at all -- it is just another DetectedSolanaWallet to it.
//
// Known limitation (tracked for a follow-up slice): reconnecting an existing
// WalletConnect session on page load is inherently asynchronous (checking a
// persisted session with the relay), unlike a Wallet Standard extension's
// already-authorized accounts, which are available synchronously. This
// wallet's `accounts` therefore starts empty on every page load even if a
// session already exists; SolanaWalletProvider's silent-restore effect will
// not pick it back up automatically yet.
export function createSolanaWalletConnectWallet(
  projectId: string,
): DetectedSolanaWallet {
  let providerPromise:
    | Promise<InstanceType<typeof UniversalProvider>>
    | undefined;
  let modalPromise: Promise<WalletConnectModal> | undefined;

  const appOrigin =
    typeof window === 'undefined' ? undefined : window.location.origin;

  // Loaded on demand, not at module scope: @walletconnect/modal pulls in
  // @walletconnect/modal-core, which calls window.matchMedia as a side
  // effect of merely being imported. Browsers all have matchMedia, so this
  // is invisible there, but it crashes under jsdom in tests that import
  // this module (directly or via SolanaWalletProvider) without ever
  // attempting a connection. Deferring the import to first use means the
  // cost -- and the matchMedia dependency -- is only paid when someone
  // actually opens the WalletConnect flow.
  function getModal(): Promise<WalletConnectModal> {
    modalPromise ??= import('@walletconnect/modal').then(
      ({ WalletConnectModal }) =>
        new WalletConnectModal({
          projectId,
          chains: [SOLANA_MAINNET_CAIP2],
        }),
    );
    return modalPromise;
  }

  function getProvider() {
    providerPromise ??= UniversalProvider.init({
      projectId,
      metadata: {
        name: 'Farcaster Wallet Client',
        description: 'Farcaster client with external wallet support',
        url: appOrigin ?? 'https://farcaster.xyz',
        icons: appOrigin ? [`${appOrigin}/favicon-v3.png`] : [],
      },
    });
    return providerPromise;
  }

  const connect = async () => {
    const provider = await getProvider();
    if (provider.session) {
      return { accounts: accountsFromSession(provider) };
    }

    const walletConnectModal = await getModal();
    const showModal = (uri: string) =>
      void walletConnectModal.openModal({ uri });
    provider.on('display_uri', showModal);
    try {
      await provider.connect({
        namespaces: {
          solana: {
            chains: [SOLANA_MAINNET_CAIP2],
            events: [],
            methods: [
              SOLANA_SIGN_TRANSACTION_METHOD,
              SOLANA_SIGN_MESSAGE_METHOD,
            ],
          },
        },
      });
    } finally {
      provider.off('display_uri', showModal);
      walletConnectModal.closeModal();
    }

    if (!provider.session) {
      throw new Error('WalletConnect session was not established.');
    }
    return { accounts: accountsFromSession(provider) };
  };

  const disconnect = async () => {
    const provider = await getProvider();
    if (provider.session) {
      await provider.disconnect();
    }
  };

  const signTransaction = async (
    ...inputs: readonly { transaction: Uint8Array }[]
  ) => {
    const provider = await getProvider();
    const { session } = provider;
    if (!session) {
      throw new Error('Connect a Solana wallet before signing.');
    }
    const results: { signedTransaction: Uint8Array }[] = [];
    for (const { transaction } of inputs) {
      const response =
        await provider.client.request<SolanaSignTransactionResponse>({
          chainId: SOLANA_MAINNET_CAIP2,
          request: {
            method: SOLANA_SIGN_TRANSACTION_METHOD,
            params: { transaction: base64Encode(transaction) },
          },
          topic: session.topic,
        });
      // Different wallets have shipped two competing response shapes for
      // this method: some return the full signed transaction, others only a
      // detached signature. We can only submit the former; treat the latter
      // as unsupported rather than guessing at reconstructing a transaction.
      if (!response?.transaction) {
        throw new Error(
          'This wallet did not return a signed transaction in a supported format.',
        );
      }
      results.push({ signedTransaction: base64Decode(response.transaction) });
    }
    return results;
  };

  const on = (
    _event: 'change',
    listener: (properties: {
      accounts?: readonly DetectedSolanaAccount[];
    }) => void,
  ) => {
    let unsubscribed = false;
    const cleanups: (() => void)[] = [];

    void getProvider().then((provider) => {
      if (unsubscribed) {
        return;
      }
      const handleChange = () =>
        listener({ accounts: accountsFromSession(provider) });
      const handleDelete = () => listener({ accounts: [] });
      provider.on('session_update', handleChange);
      provider.on('session_delete', handleDelete);
      cleanups.push(() => {
        provider.off('session_update', handleChange);
        provider.off('session_delete', handleDelete);
      });
    });

    return () => {
      unsubscribed = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  };

  return {
    accounts: [],
    chains: [SOLANA_MAINNET_CHAIN],
    features: {
      [SOLANA_CONNECT_FEATURE]: { connect },
      [SOLANA_DISCONNECT_FEATURE]: { disconnect },
      [SOLANA_EVENTS_FEATURE]: { on },
      [SOLANA_SIGN_TRANSACTION_FEATURE]: { signTransaction },
    },
    icon: WALLET_CONNECT_ICON,
    name: WALLET_CONNECT_WALLET_NAME,
    version: '1.0.0',
  };
}
