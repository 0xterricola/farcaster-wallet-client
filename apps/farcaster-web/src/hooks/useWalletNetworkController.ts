import { Provider } from 'ox';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toHex } from 'viem';

import {
  addEthereumChainParameters,
  classifyWalletNetworkError,
  DASHBOARD_CHAINS,
  DEFAULT_WALLET_CHAIN_ID,
  parseWalletChainId,
  readWalletChainId,
  SELECTABLE_WALLET_CHAINS,
  WalletNetworkError,
} from '~/utils/walletNetwork';

export type WalletNetworkStatus =
  | 'disconnected'
  | 'loading'
  | 'ready'
  | 'mismatch'
  | 'unavailable'
  | 'checking'
  | 'switching'
  | 'adding'
  | 'error';

export function useWalletNetworkController(provider?: Provider.Provider) {
  const [actualChainId, setActualChainId] = useState<number>();
  const [selectedChainId, setSelectedChainId] = useState<number>(
    DEFAULT_WALLET_CHAIN_ID,
  );
  const [previousWorkingChainId, setPreviousWorkingChainId] =
    useState<number>();
  const [requestedChainId, setRequestedChainId] = useState<number>();
  const [action, setAction] = useState<
    'idle' | 'checking' | 'switching' | 'adding'
  >('idle');
  const [error, setError] = useState<WalletNetworkError>();
  const selectedChainIdRef = useRef(selectedChainId);
  const providerGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const actionRunning = useRef(false);

  useEffect(() => {
    selectedChainIdRef.current = selectedChainId;
  }, [selectedChainId]);

  const reportChainChanged = useCallback((value: unknown) => {
    const chainId = parseWalletChainId(value);
    if (!chainId) {
      return;
    }
    setActualChainId(chainId);
    if (SELECTABLE_WALLET_CHAINS.has(chainId)) {
      setSelectedChainId(chainId);
    }
    if (DASHBOARD_CHAINS.has(chainId)) {
      setPreviousWorkingChainId(chainId);
    }
    setError(undefined);
  }, []);

  useEffect(() => {
    const generation = ++providerGeneration.current;
    actionGeneration.current += 1;
    actionRunning.current = false;
    setAction('idle');
    setRequestedChainId(undefined);
    setActualChainId(undefined);
    setError(undefined);
    if (!provider) {
      return;
    }
    const changed = (value: unknown) => {
      if (generation === providerGeneration.current) {
        reportChainChanged(value);
      }
    };
    provider.on('chainChanged', changed);
    void readWalletChainId(provider)
      .then(changed)
      .catch(() => {
        if (generation === providerGeneration.current) {
          setError({
            kind: 'switch_failed',
            requestedChainId: selectedChainIdRef.current,
            message: 'Could not read the connected wallet network.',
          });
        }
      });
    return () => {
      providerGeneration.current += 1;
      provider.removeListener('chainChanged', changed);
    };
  }, [provider, reportChainChanged]);

  const performSwitch = useCallback(
    async (chainId: number, operation: number) => {
      if (!provider) {
        throw new Error('Connect a wallet before switching networks.');
      }
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: toHex(chainId) }],
      });
      const confirmed = await readWalletChainId(provider);
      if (operation !== actionGeneration.current) {
        throw new Error('Wallet connection changed during network switch.');
      }
      reportChainChanged(confirmed);
      if (confirmed !== chainId) {
        throw new Error(
          'Wallet did not complete the requested network switch.',
        );
      }
    },
    [provider, reportChainChanged],
  );

  const switchNetwork = useCallback(
    async (chainId: number) => {
      if (!SELECTABLE_WALLET_CHAINS.has(chainId) || actionRunning.current) {
        return false;
      }
      actionRunning.current = true;
      const operation = ++actionGeneration.current;
      setAction('switching');
      setRequestedChainId(chainId);
      setError(undefined);
      try {
        await performSwitch(chainId, operation);
        return true;
      } catch (failure) {
        // Some providers report an error after completing the switch. Trust a
        // fresh chain read rather than the error text alone.
        if (provider && operation === actionGeneration.current) {
          try {
            const confirmed = await readWalletChainId(provider);
            reportChainChanged(confirmed);
            if (confirmed === chainId) {
              return true;
            }
          } catch {
            // Preserve the original switch error below.
          }
        }
        if (operation === actionGeneration.current) {
          setError(classifyWalletNetworkError(failure, chainId));
        }
        return false;
      } finally {
        if (operation === actionGeneration.current) {
          actionRunning.current = false;
          setAction('idle');
          setRequestedChainId(undefined);
        }
      }
    },
    [performSwitch, provider, reportChainChanged],
  );

  const refreshNetwork = useCallback(async () => {
    if (!provider || actionRunning.current) {
      return false;
    }
    actionRunning.current = true;
    const operation = ++actionGeneration.current;
    setAction('checking');
    setRequestedChainId(undefined);
    setError(undefined);
    try {
      const confirmed = await readWalletChainId(provider);
      if (operation !== actionGeneration.current) {
        return false;
      }
      reportChainChanged(confirmed);
      return SELECTABLE_WALLET_CHAINS.has(confirmed);
    } catch {
      if (operation === actionGeneration.current) {
        setError({
          kind: 'switch_failed',
          requestedChainId: selectedChainId,
          message: 'Could not read the connected wallet network.',
        });
      }
      return false;
    } finally {
      if (operation === actionGeneration.current) {
        actionRunning.current = false;
        setAction('idle');
      }
    }
  }, [provider, reportChainChanged, selectedChainId]);

  const addNetwork = useCallback(
    async (chainId: number) => {
      const chain = SELECTABLE_WALLET_CHAINS.get(chainId);
      if (!provider || !chain || actionRunning.current) {
        return false;
      }
      actionRunning.current = true;
      const operation = ++actionGeneration.current;
      setAction('adding');
      setRequestedChainId(chainId);
      setError(undefined);
      try {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [addEthereumChainParameters(chain)],
        });
        await performSwitch(chainId, operation);
        return true;
      } catch (failure) {
        if (operation === actionGeneration.current) {
          try {
            const confirmed = await readWalletChainId(provider);
            reportChainChanged(confirmed);
            if (confirmed === chainId) {
              return true;
            }
          } catch {
            // Preserve the original add/switch error below.
          }
          setError(classifyWalletNetworkError(failure, chainId));
        }
        return false;
      } finally {
        if (operation === actionGeneration.current) {
          actionRunning.current = false;
          setAction('idle');
          setRequestedChainId(undefined);
        }
      }
    },
    [performSwitch, provider, reportChainChanged],
  );

  const status = useMemo<WalletNetworkStatus>(() => {
    if (!provider) {
      return 'disconnected';
    }
    if (action !== 'idle') {
      return action;
    }
    if (error) {
      return 'error';
    }
    if (!actualChainId) {
      return 'loading';
    }
    if (actualChainId !== selectedChainId) {
      return 'mismatch';
    }
    return DASHBOARD_CHAINS.has(actualChainId) ? 'ready' : 'unavailable';
  }, [action, actualChainId, error, provider, selectedChainId]);

  return {
    actualChainId,
    selectedChainId,
    previousWorkingChainId,
    requestedChainId,
    status,
    error,
    refreshNetwork,
    switchNetwork,
    addNetwork,
    reportChainChanged,
  };
}

export type WalletNetworkController = ReturnType<
  typeof useWalletNetworkController
>;
