import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { useUnifiedMetaMask } from '~/contexts/UnifiedMetaMaskProvider';
import {
  DetectedSolanaAccount,
  DetectedSolanaWallet,
  SOLANA_CONNECT_FEATURE,
  SOLANA_DISCONNECT_FEATURE,
  SOLANA_EVENTS_FEATURE,
  SOLANA_MAINNET_CHAIN,
  SOLANA_SIGN_MESSAGE_FEATURE,
  SOLANA_SIGN_TRANSACTION_FEATURE,
  useDetectedSolanaWallets,
} from '~/hooks/useDetectedSolanaWallets';
import { shouldReleaseIndependentConnection } from '~/utils/metamaskConnection';
import {
  createSolanaWalletConnectWallet,
  WALLET_CONNECT_WALLET_NAME,
} from '~/utils/solanaWalletConnect';

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

type SignMessageFeature = {
  signMessage: (
    ...inputs: readonly {
      account: DetectedSolanaAccount;
      message: Uint8Array;
    }[]
  ) => Promise<readonly { signature: Uint8Array }[]>;
};

type SolanaWalletContextValue = {
  address: string | undefined;
  connect: (wallet: DetectedSolanaWallet) => Promise<boolean>;
  detectedWallets: readonly DetectedSolanaWallet[];
  disconnect: () => Promise<void>;
  error: string | undefined;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
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
  const {
    disconnect: disconnectUnified,
    solanaAddress: unifiedSolanaAddress,
    solanaWallet: unifiedSolanaWallet,
    status: unifiedStatus,
  } = useUnifiedMetaMask();
  const isUnifiedOccupied =
    unifiedStatus === 'connecting' || unifiedStatus === 'connected';
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
  const unifiedWallet = unifiedSolanaWallet as DetectedSolanaWallet | undefined;
  const unifiedAccount = unifiedWallet?.accounts.find(
    (candidate) => candidate.address === unifiedSolanaAddress,
  );
  const activeWallet = isUnifiedOccupied ? unifiedWallet : wallet;
  const activeAccount = isUnifiedOccupied ? unifiedAccount : account;
  const activeAddress = isUnifiedOccupied ? unifiedSolanaAddress : address;
  const activeStatus: SolanaWalletStatus = isUnifiedOccupied
    ? unifiedStatus === 'connected' && unifiedAccount
      ? 'connected'
      : unifiedStatus === 'connecting'
        ? 'connecting'
        : 'error'
    : status;
  const shouldReleaseIndependentSolana = shouldReleaseIndependentConnection(
    unifiedStatus,
    status,
  );

  // A remembered browser or WalletConnect session can restore after Unified
  // starts. Clear it while Unified owns the Solana pipe so it cannot reappear
  // when the shared session disconnects.
  useEffect(() => {
    if (!shouldReleaseIndependentSolana || !wallet) {
      return;
    }
    const disconnectFeature = feature<DisconnectFeature>(
      wallet,
      SOLANA_DISCONNECT_FEATURE,
    );
    localStorage.removeItem(SOLANA_WALLET_KEY);
    setWallet(undefined);
    setAccount(undefined);
    setAddress(undefined);
    setStatus('disconnected');
    setError(undefined);
    if (disconnectFeature?.disconnect) {
      void disconnectFeature.disconnect().catch(() => undefined);
    }
  }, [shouldReleaseIndependentSolana, wallet]);

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
      if (isUnifiedOccupied) {
        setError(
          'Disconnect Unified MetaMask before choosing an independent Solana wallet.',
        );
        return false;
      }
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
    [isUnifiedOccupied, setConnectedAccount],
  );

  const disconnect = useCallback(async () => {
    if (isUnifiedOccupied) {
      await disconnectUnified();
      return;
    }
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
  }, [disconnectUnified, isUnifiedOccupied, wallet]);

  const signTransaction = useCallback(
    async (transaction: Uint8Array) => {
      if (!activeWallet || !activeAccount || activeStatus !== 'connected') {
        throw new Error('Connect a Solana wallet before signing.');
      }
      const signing = feature<SignTransactionFeature>(
        activeWallet,
        SOLANA_SIGN_TRANSACTION_FEATURE,
      );
      if (!signing?.signTransaction) {
        throw new Error('This wallet cannot sign Solana transactions.');
      }
      const [result] = await signing.signTransaction({
        account: activeAccount,
        chain: SOLANA_MAINNET_CHAIN,
        transaction,
      });
      if (!result?.signedTransaction?.length) {
        throw new Error('The wallet did not return a signed transaction.');
      }
      return result.signedTransaction;
    },
    [activeAccount, activeStatus, activeWallet],
  );

  const signMessage = useCallback(
    async (message: Uint8Array) => {
      if (!activeWallet || !activeAccount || activeStatus !== 'connected') {
        throw new Error('Connect a Solana wallet before signing.');
      }
      const signing = feature<SignMessageFeature>(
        activeWallet,
        SOLANA_SIGN_MESSAGE_FEATURE,
      );
      if (!signing?.signMessage) {
        throw new Error('This wallet cannot sign Solana messages.');
      }
      const [result] = await signing.signMessage({
        account: activeAccount,
        message,
      });
      if (!result?.signature?.length) {
        throw new Error('The wallet did not return a message signature.');
      }
      return result.signature;
    },
    [activeAccount, activeStatus, activeWallet],
  );

  useEffect(() => {
    if (isUnifiedOccupied || wallet || !detectedWallets.length) {
      return;
    }
    const rememberedName = localStorage.getItem(SOLANA_WALLET_KEY);
    const rememberedWallet = detectedWallets.find(
      (candidate) => candidate.name === rememberedName,
    );
    if (!rememberedWallet) {
      return;
    }

    if (rememberedWallet.name !== WALLET_CONNECT_WALLET_NAME) {
      // Wallet Standard exposes already-authorized accounts synchronously.
      // Never call connect for browser wallets during restoration because
      // some wallets may ignore the silent option and display a prompt.
      setConnectedAccount(rememberedWallet, rememberedWallet.accounts);
      return;
    }

    const connectFeature = feature<ConnectFeature>(
      rememberedWallet,
      SOLANA_CONNECT_FEATURE,
    );
    if (!connectFeature?.connect) {
      localStorage.removeItem(SOLANA_WALLET_KEY);
      return;
    }

    let cancelled = false;
    void connectFeature
      .connect({ silent: true })
      .then(({ accounts }) => {
        if (cancelled) {
          return;
        }
        if (!mainnetAccount(accounts)) {
          localStorage.removeItem(SOLANA_WALLET_KEY);
          return;
        }
        setConnectedAccount(rememberedWallet, accounts);
      })
      // A relay or network failure is not proof that the persisted session is
      // invalid. Keep the preference so another reload can restore it.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [detectedWallets, isUnifiedOccupied, setConnectedAccount, wallet]);

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
      address: activeAddress,
      connect,
      detectedWallets,
      disconnect,
      error,
      signMessage,
      signTransaction,
      status: activeStatus,
      wallet: activeWallet,
    }),
    [
      activeAddress,
      activeStatus,
      activeWallet,
      connect,
      detectedWallets,
      disconnect,
      error,
      signMessage,
      signTransaction,
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
