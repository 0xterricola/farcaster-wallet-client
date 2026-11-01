/**
 * The action half of adding funds: pick a wallet, send, then stay with the
 * transfer until Fiddy's own balance says it arrived.
 *
 * THE ORDER IS THE POINT.
 *
 *   1. Resolve a wallet. In the Farcaster app that is the host's wallet
 *      (`~/lib/farcasterWallet`); in a browser it is the wallet this client
 *      already has connected, and failing that one that injected itself into
 *      the page. No wallet is a named answer, not a silent nothing.
 *   2. Send one USDC transfer to the treasury from the config
 *      (`~/lib/fiddyTopUpSend` — the client's own Base transfer builder, so
 *      the balance check and the simulation happen before anyone approves).
 *   3. Remember the hash *before* asking Fiddy about it
 *      (`~/lib/fiddyPendingTopUp`). The money has already moved; if this tab
 *      dies mid-credit, the next load can still ask.
 *   4. Hand the hash to `runTopUp` (`~/lib/fiddyCredit`), which re-submits
 *      while Base is still confirming and then reads the balance to prove the
 *      movement is really in it.
 *   5. Only when it is in the balance is the remembered hash dropped.
 *
 * WHAT THIS HOOK NEVER DOES. It never sends a second transfer to fix a failed
 * credit — that would be a second charge for one top-up. A failure keeps the
 * hash on screen with "check again", which is free.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { base } from 'viem/chains';
import { useAccount, usePublicClient } from 'wagmi';

import { useWallet } from '~/contexts/WalletProvider';
import { openMiniappWallet } from '~/lib/farcasterWallet';
import {
  fetchFundingBalance,
  type FundingConfig,
  FundingError,
  fundingFailureCode,
  fundingFailureOwnerLine,
  runTopUp,
  submitFundingCredit,
} from '~/lib/fiddyCredit';
import {
  forgetPendingTopUp,
  type PendingTopUp,
  readPendingTopUp,
  rememberPendingTopUp,
} from '~/lib/fiddyPendingTopUp';
import {
  describeSendFailure,
  readInjectedWallet,
  sendTopUp,
  type TopUpSource,
  type TopUpWallet,
} from '~/lib/fiddyTopUpSend';
import { createBaseTransferReader } from '~/utils/baseWalletTransfer';

import { fundingBalanceQueryKey } from './useFiddyCredit';

export type TopUpProgress =
  | { name: 'idle' }
  /** The wallet is being asked; nothing has moved yet. */
  | { name: 'sending' }
  /** Sent: Fiddy is being handed the transfer hash. */
  | { name: 'checking' }
  /** Base has not finished confirming it. `attempt` counts the checks. */
  | { name: 'confirming'; attempt: number }
  /** In the balance. `settled` is false while the movement is not shown yet. */
  | { name: 'credited'; usdc: string; settled: boolean }
  /** The same transfer was already credited; nothing was added twice. */
  | { name: 'already-credited'; usdc: string }
  | { name: 'failed'; code: string; line: string; txHash: string | null };

export interface FiddyTopUpAction {
  progress: TopUpProgress;
  /** The transfer this device is still waiting on, if any. */
  pending: PendingTopUp | null;
  /** True while the wallet or the service is doing something. */
  busy: boolean;
  /** Which wallet a send would use right now, resolved lazily. */
  walletLabel: string | null;
  send: (usd: string, source: TopUpSource) => Promise<void>;
  /** Ask Fiddy about the remembered transfer again. Sends nothing. */
  checkPending: () => Promise<void>;
  /** Stop offering the remembered transfer (it is already credited). */
  forgetPending: () => Promise<void>;
  reset: () => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

const idle: TopUpProgress = { name: 'idle' };

export const useFiddyTopUp = (
  config: FundingConfig | null,
): FiddyTopUpAction => {
  const queryClient = useQueryClient();
  const { provider, address, openConnectModal } = useWallet();
  const { address: wagmiAddress, connector } = useAccount();
  const client = usePublicClient({ chainId: base.id });
  const reader = useMemo(
    () => (client ? createBaseTransferReader(client) : undefined),
    [client],
  );

  const [progress, setProgress] = useState<TopUpProgress>(idle);
  const [pending, setPending] = useState<PendingTopUp | null>(null);
  const [walletLabel, setWalletLabel] = useState<string | null>(null);
  /** One top-up at a time: a second press while one is in flight would be a
   *  second transfer. */
  const running = useRef(false);
  const cancelled = useRef(false);

  const refreshBalance = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: fundingBalanceQueryKey });
  }, [queryClient]);

  /** Load what this device still owes a question to. */
  const loadPending = useCallback(async () => {
    setPending(await readPendingTopUp());
  }, []);

  // Mounted once per funding surface; cheap, and it is not a render loop.
  const loaded = useRef(false);
  if (!loaded.current) {
    loaded.current = true;
    void loadPending();
  }

  const resolveWallet = useCallback(
    async (source: TopUpSource): Promise<TopUpWallet | null> => {
      if (source === 'farcaster') {
        const miniapp = await openMiniappWallet();
        if (miniapp === null) {
          return null;
        }
        return {
          source: 'farcaster',
          address: miniapp.address,
          provider: miniapp.provider,
          label: 'your Farcaster wallet',
        };
      }
      if (provider && (address ?? wagmiAddress)) {
        return {
          source: 'wallet',
          address: (address ?? wagmiAddress) as `0x${string}`,
          provider,
          label: connector?.name ?? 'your connected wallet',
        };
      }
      const injected = readInjectedWallet();
      return injected;
    },
    [address, connector, provider, wagmiAddress],
  );

  const credit = useCallback(
    async (usdc: string, txHash: string, source: TopUpSource) => {
      const record = await rememberPendingTopUp({
        txHash,
        usdc,
        source,
      });
      if (record !== null) {
        setPending(record);
      }
      setProgress({ name: 'checking' });

      const outcome = await runTopUp({
        txHash,
        deps: {
          credit: async (hash) => await submitFundingCredit(hash),
          balance: async () => await fetchFundingBalance(),
          sleep,
          isCancelled: () => cancelled.current,
          onStage: (stage) => {
            if (stage.name === 'checking') {
              setProgress({ name: 'checking' });
            }
            if (stage.name === 'confirming') {
              setProgress({ name: 'confirming', attempt: stage.attempt });
            }
          },
        },
      });

      if (outcome.name === 'credited') {
        await forgetPendingTopUp();
        setPending(null);
        await refreshBalance();
        setProgress({ name: 'credited', usdc, settled: outcome.settled });
        return;
      }
      if (outcome.name === 'already-credited') {
        await forgetPendingTopUp();
        setPending(null);
        await refreshBalance();
        setProgress({ name: 'already-credited', usdc });
        return;
      }
      if (outcome.name === 'failed') {
        setProgress({
          name: 'failed',
          code: outcome.error.code,
          line: outcome.error.ownerLine,
          txHash,
        });
        return;
      }
      setProgress({
        name: 'failed',
        code: 'FUNDING_CREDIT_UNAVAILABLE',
        line: fundingFailureOwnerLine(
          new FundingError('FUNDING_CREDIT_UNAVAILABLE'),
        ),
        txHash,
      });
    },
    [refreshBalance],
  );

  const send = useCallback(
    async (usd: string, source: TopUpSource) => {
      if (running.current) {
        return;
      }
      running.current = true;
      cancelled.current = false;
      setProgress({ name: 'sending' });

      try {
        if (config === null) {
          setProgress({
            name: 'failed',
            code: 'FUNDING_CONFIG_UNAVAILABLE',
            line: fundingFailureOwnerLine(
              new FundingError('FUNDING_CONFIG_UNAVAILABLE'),
            ),
            txHash: null,
          });
          return;
        }
        if (!reader) {
          setProgress({
            name: 'failed',
            code: 'SEND_FAILED',
            line: 'This page cannot reach Base to check the transfer, so nothing was sent.',
            txHash: null,
          });
          return;
        }

        const wallet = await resolveWallet(source);
        if (wallet === null) {
          if (source === 'wallet') {
            // Not a dead end: the client has a wallet picker of its own, and
            // the honest next step is to open it.
            openConnectModal('evm');
          }
          setProgress({
            name: 'failed',
            code: 'NOT_CONNECTED',
            line:
              source === 'farcaster'
                ? 'The Farcaster wallet is not available in this window, so nothing was sent. Open Fiddy inside the Farcaster app to pay from it.'
                : fundingFailureOwnerLine(new FundingError('NOT_CONNECTED')),
            txHash: null,
          });
          return;
        }
        setWalletLabel(wallet.label);

        const hash = await sendTopUp({
          reader,
          config,
          usd,
          wallet,
          isCurrent: () => !cancelled.current,
        });

        await credit(usd, hash, source);
      } catch (error) {
        const failure = describeSendFailure(error);
        setProgress({
          name: 'failed',
          code: fundingFailureCode(failure),
          line: failure.ownerLine,
          txHash: null,
        });
      } finally {
        running.current = false;
      }
    },
    [config, credit, openConnectModal, reader, resolveWallet],
  );

  const checkPending = useCallback(async () => {
    if (running.current) {
      return;
    }
    const record = pending ?? (await readPendingTopUp());
    if (record === null) {
      return;
    }
    running.current = true;
    cancelled.current = false;
    try {
      await credit(record.usdc, record.txHash, record.source);
    } finally {
      running.current = false;
    }
  }, [credit, pending]);

  const forgetPending = useCallback(async () => {
    await forgetPendingTopUp();
    setPending(null);
    setProgress(idle);
  }, []);

  const reset = useCallback(() => {
    cancelled.current = true;
    setProgress(idle);
  }, []);

  return {
    progress,
    pending,
    busy:
      progress.name === 'sending' ||
      progress.name === 'checking' ||
      progress.name === 'confirming',
    walletLabel,
    send,
    checkPending,
    forgetPending,
    reset,
  };
};
