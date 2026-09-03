import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  DetectedSolanaAccount,
  DetectedSolanaWallet,
  SOLANA_CONNECT_FEATURE,
  SOLANA_DISCONNECT_FEATURE,
  SOLANA_EVENTS_FEATURE,
  SOLANA_MAINNET_CHAIN,
  SOLANA_SIGN_TRANSACTION_FEATURE,
  useDetectedSolanaWallets,
} from '~/hooks/useDetectedSolanaWallets';
import { createSolanaWalletConnectWallet } from '~/utils/solanaWalletConnect';

const SOLANA_WALLET_KEY = 'solana_wallet_name';
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as
  | string
  | undefined;

type SolanaWalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

type ConnectFeature = {
  connect: (input?: { silent?: boolean }) => Promise<{
    accounts: readonly DetectedSolanaAccount[];
  }>;
};

type DisconnectFeature = {
  disconnect: () => Promise<void>;
};

type EventsFeature = {
  on: (
    event: 'change',
    listener: (properties: {
      accounts?: readonly DetectedSolanaAccount[];
    }) => void,
  ) => () => void;
};

type SignTransactionFeature = {
  signTransaction: (
    ...inputs: readonly {
      account: DetectedSolanaAccount;
      chain: typeof SOLANA_MAINNET_CHAIN;
      transaction: Uint8Array;
    }[]
  ) => Promise<readonly { signedTransaction: Uint8Array }[]>;
};

type SolanaWalletContextValue = {
  address: string | undefined;
  connect: (wallet: DetectedSolanaWallet) => Promise<boolean>;
  detectedWallets: readonly DetectedSolanaWallet[];
  disconnect: () => Promise<void>;
  error: string | undefined;
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
  status: SolanaWalletStatus;
  wallet: DetectedSolanaWallet | undefined;
};

const SolanaWalletContext = createContext<SolanaWalletContextValue | null>(
  null,
);

function mainnetAccount(
  accounts: readonly DetectedSolanaAccount[],
): DetectedSolanaAccount | undefined {
  return accounts.find((account) =>
    account.chains.includes(SOLANA_MAINNET_CHAIN),
  );
}

function feature<T>(wallet: DetectedSolanaWallet, name: string): T | undefined {
  const value = wallet.features[name];
  return value && typeof value === 'object' ? (value as T) : undefined;
}

function connectionError(error: unknown): string {
  return error instanceof Error ? error.message : 'Solana connection failed.';
}

function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const browserWallets = useDetectedSolanaWallets();
  // Stable across re-renders (created once per mounted provider) so the
  // underlying WalletConnect session/modal are not recreated on every
  // render -- they hold state (a pending or active session) that must
  // persist for the life of the app, the same way a real browser extension
  // wallet's own connection state persists independently of React.
  const solanaWalletConnectWallet = useMemo(
    () =>
      walletConnectProjectId
        ? createSolanaWalletConnectWallet(walletConnectProjectId)
        : undefined,
    [],
  );
  const detectedWallets = useMemo(
    () =>
      solanaWalletConnectWallet
        ? [...browserWallets, solanaWalletConnectWallet]
        : browserWallets,
    [browserWallets, solanaWalletConnectWallet],
  );
  const [wallet, setWallet] = useState<DetectedSolanaWallet>();
  const [account, setAccount] = useState<DetectedSolanaAccount>();
  const [address, setAddress] = useState<string>();
  const [status, setStatus] = useState<SolanaWalletStatus>('disconnected');
  const [error, setError] = useState<string>();

  const setConnectedAccount = useCallback(
    (
      nextWallet: DetectedSolanaWallet,
      accounts: readonly DetectedSolanaAccount[],
    ) => {
      const account = mainnetAccount(accounts);
      setWallet(nextWallet);
      setAccount(account);
      setAddress(account?.address);
      setStatus(account ? 'connected' : 'disconnected');
      setError(undefined);
      return Boolean(account);
    },
    [],
  );

  const connect = useCallback(
    async (nextWallet: DetectedSolanaWallet) => {
      const connectFeature = feature<ConnectFeature>(
        nextWallet,
        SOLANA_CONNECT_FEATURE,
      );
      if (!connectFeature?.connect) {
        setStatus('error');
        setError('This wallet does not expose a compatible connect method.');
        return false;
      }

      setWallet(nextWallet);
      setStatus('connecting');
      setError(undefined);
      try {
        const result = await connectFeature.connect();
        if (!setConnectedAccount(nextWallet, result.accounts)) {
          setStatus('error');
          setError('This wallet did not return a Solana Mainnet account.');
          return false;
        }
        localStorage.setItem(SOLANA_WALLET_KEY, nextWallet.name);
        return true;
      } catch (connectFailure) {
        setStatus('error');
        setError(connectionError(connectFailure));
        return false;
      }
    },
    [setConnectedAccount],
  );

  const disconnect = useCallback(async () => {
    const disconnectFeature = wallet
      ? feature<DisconnectFeature>(wallet, SOLANA_DISCONNECT_FEATURE)
      : undefined;
    try {
      await disconnectFeature?.disconnect?.();
    } finally {
      localStorage.removeItem(SOLANA_WALLET_KEY);
      setWallet(undefined);
      setAccount(undefined);
      setAddress(undefined);
      setStatus('disconnected');
      setError(undefined);
    }
  }, [wallet]);

  const signTransaction = useCallback(
    async (transaction: Uint8Array) => {
      if (!wallet || !account || status !== 'connected') {
        throw new Error('Connect a Solana wallet before signing.');
      }
      const signing = feature<SignTransactionFeature>(
        wallet,
        SOLANA_SIGN_TRANSACTION_FEATURE,
      );
      if (!signing?.signTransaction) {
        throw new Error('This wallet cannot sign Solana transactions.');
      }
      const [result] = await signing.signTransaction({
        account,
        chain: SOLANA_MAINNET_CHAIN,
        transaction,
      });
      if (!result?.signedTransaction?.length) {
        throw new Error('The wallet did not return a signed transaction.');
      }
      return result.signedTransaction;
    },
    [account, status, wallet],
  );

  useEffect(() => {
    if (wallet || !detectedWallets.length) {
      return;
    }
    const rememberedName = localStorage.getItem(SOLANA_WALLET_KEY);
    const rememberedWallet = detectedWallets.find(
      (candidate) => candidate.name === rememberedName,
    );
    if (!rememberedWallet) {
      return;
    }

    // Wallet Standard exposes already-authorized accounts without prompting.
    // Never call connect during restoration because wallets may ignore the
    // silent option and unexpectedly display an approval request.
    setConnectedAccount(rememberedWallet, rememberedWallet.accounts);
  }, [detectedWallets, setConnectedAccount, wallet]);

  useEffect(() => {
    if (!wallet) {
      return;
    }
    const eventsFeature = feature<EventsFeature>(wallet, SOLANA_EVENTS_FEATURE);
    if (!eventsFeature?.on) {
      return;
    }
    return eventsFeature.on('change', (properties) => {
      if (properties.accounts) {
        setConnectedAccount(wallet, properties.accounts);
      }
    });
  }, [setConnectedAccount, wallet]);

  const value = useMemo<SolanaWalletContextValue>(
    () => ({
      address,
      connect,
      detectedWallets,
      disconnect,
      error,
      signTransaction,
      status,
      wallet,
    }),
    [
      address,
      connect,
      detectedWallets,
      disconnect,
      error,
      signTransaction,
      status,
      wallet,
    ],
  );

  return (
    <SolanaWalletContext.Provider value={value}>
      {children}
    </SolanaWalletContext.Provider>
  );
}

function useSolanaWallet(): SolanaWalletContextValue {
  const context = useContext(SolanaWalletContext);
  if (!context) {
    throw new Error('useSolanaWallet must be used within SolanaWalletProvider');
  }
  return context;
}

export { SolanaWalletProvider, useSolanaWallet };
