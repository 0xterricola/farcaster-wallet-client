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
  getMetaMaskConnectClients,
  MetaMaskConnectClients,
} from '~/utils/metamaskConnectClient';
import {
  connectUnifiedMetaMask,
  getUnifiedAddressesFromSession,
  METAMASK_UNIFIED_SCOPES,
  validateUnifiedConnection,
  WalletConnectionStatus,
} from '~/utils/metamaskConnection';

const UNIFIED_METAMASK_KEY = 'unified_metamask_connected';

type UnifiedMetaMaskContextValue = Readonly<{
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  error: string | undefined;
  evmAddress: string | undefined;
  evmProvider: MetaMaskConnectClients['evmProvider'] | undefined;
  solanaAddress: string | undefined;
  solanaWallet: MetaMaskConnectClients['solanaWallet'] | undefined;
  status: WalletConnectionStatus;
}>;

const UnifiedMetaMaskContext =
  createContext<UnifiedMetaMaskContextValue | null>(null);

type SolanaConnectFeature = Readonly<{
  connect: (input?: { silent?: boolean }) => Promise<{
    accounts: readonly { address: string }[];
  }>;
}>;

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Unified MetaMask connection failed.';
}

async function hydrateSolanaSigner(
  clients: MetaMaskConnectClients,
  expectedAddress: string,
): Promise<void> {
  const feature = clients.solanaWallet.features['standard:connect'] as
    | SolanaConnectFeature
    | undefined;
  if (!feature?.connect) {
    throw new Error('MetaMask did not expose its Solana signing capability.');
  }
  const result = await feature.connect({ silent: true });
  if (!result.accounts.some((account) => account.address === expectedAddress)) {
    throw new Error(
      'MetaMask connected a Solana account, but its signer did not become ready. Disconnect and try again.',
    );
  }
}

export function UnifiedMetaMaskProvider({ children }: { children: ReactNode }) {
  const [clients, setClients] = useState<MetaMaskConnectClients>();
  const [evmAddress, setEvmAddress] = useState<string>();
  const [solanaAddress, setSolanaAddress] = useState<string>();
  const [status, setStatus] = useState<WalletConnectionStatus>('disconnected');
  const [error, setError] = useState<string>();

  const clearConnection = useCallback(() => {
    localStorage.removeItem(UNIFIED_METAMASK_KEY);
    setClients(undefined);
    setEvmAddress(undefined);
    setSolanaAddress(undefined);
    setStatus('disconnected');
  }, []);

  const commitConnection = useCallback(
    (
      nextClients: MetaMaskConnectClients,
      result: Readonly<{ evmAddress: string; solanaAddress: string }>,
    ) => {
      setClients(nextClients);
      setEvmAddress(result.evmAddress);
      setSolanaAddress(result.solanaAddress);
      setStatus('connected');
      setError(undefined);
      localStorage.setItem(UNIFIED_METAMASK_KEY, 'true');
    },
    [],
  );

  const connect = useCallback(async () => {
    setStatus('connecting');
    setError(undefined);
    let nextClients: MetaMaskConnectClients | undefined;
    try {
      nextClients = await getMetaMaskConnectClients();
      const result = await connectUnifiedMetaMask(nextClients.core);
      if (!result.ok) {
        clearConnection();
        setStatus('error');
        setError(result.message);
        return false;
      }
      await hydrateSolanaSigner(nextClients, result.solanaAddress);
      commitConnection(nextClients, result);
      return true;
    } catch (connectFailure) {
      try {
        await nextClients?.core.disconnect([...METAMASK_UNIFIED_SCOPES]);
      } catch {
        // Preserve the signer hydration failure shown to the user.
      }
      clearConnection();
      setStatus('error');
      setError(errorMessage(connectFailure));
      return false;
    }
  }, [clearConnection, commitConnection]);

  const disconnect = useCallback(async () => {
    setError(undefined);
    try {
      const activeClients = clients ?? (await getMetaMaskConnectClients());
      await activeClients.core.disconnect([...METAMASK_UNIFIED_SCOPES]);
    } catch (disconnectFailure) {
      setError(errorMessage(disconnectFailure));
    } finally {
      clearConnection();
    }
  }, [clearConnection, clients]);

  useEffect(() => {
    if (localStorage.getItem(UNIFIED_METAMASK_KEY) !== 'true') {
      return;
    }

    let cancelled = false;
    void getMetaMaskConnectClients()
      .then(async (rememberedClients) => {
        const result = validateUnifiedConnection(
          getUnifiedAddressesFromSession(
            await rememberedClients.core.provider.getSession(),
          ),
        );
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          await rememberedClients.core
            .disconnect([...METAMASK_UNIFIED_SCOPES])
            .catch(() => undefined);
          clearConnection();
          return;
        }
        await hydrateSolanaSigner(rememberedClients, result.solanaAddress);
        commitConnection(rememberedClients, result);
      })
      .catch(() => {
        // A temporary restoration failure is not proof that the persisted SDK
        // session is invalid. Leave the marker so a reload can try again.
      });

    return () => {
      cancelled = true;
    };
  }, [clearConnection, commitConnection]);

  const value = useMemo<UnifiedMetaMaskContextValue>(
    () => ({
      connect,
      disconnect,
      error,
      evmAddress,
      evmProvider: clients?.evmProvider,
      solanaAddress,
      solanaWallet: clients?.solanaWallet,
      status,
    }),
    [clients, connect, disconnect, error, evmAddress, solanaAddress, status],
  );

  return (
    <UnifiedMetaMaskContext.Provider value={value}>
      {children}
    </UnifiedMetaMaskContext.Provider>
  );
}

export function useUnifiedMetaMask(): UnifiedMetaMaskContextValue {
  const context = useContext(UnifiedMetaMaskContext);
  if (!context) {
    throw new Error(
      'useUnifiedMetaMask must be used within UnifiedMetaMaskProvider',
    );
  }
  return context;
}
