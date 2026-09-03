import { formatDistanceToNow } from 'date-fns';
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  CircleHelpIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  Repeat2Icon,
  XCircleIcon,
} from 'lucide-react';
import React from 'react';

import { useSolanaActivity } from '~/hooks/useSolanaActivity';
import {
  SolanaActivity,
  SolanaActivityAsset,
  SolanaActivityStatus,
  SolanaActivityType,
} from '~/utils/solanaActivity';
import { formatSolanaSwapUnits } from '~/utils/solanaSwap';
import { solanaTransactionUrl } from '~/utils/solanaTransfer';
import { solanaAddressUrl } from '~/utils/solanaWallet';

const typeDetails: Record<
  SolanaActivityType,
  { icon: typeof ArrowDownLeftIcon; label: string }
> = {
  receive: { icon: ArrowDownLeftIcon, label: 'Received' },
  send: { icon: ArrowUpRightIcon, label: 'Sent' },
  swap: { icon: Repeat2Icon, label: 'Swap' },
  unknown: { icon: CircleHelpIcon, label: 'Activity' },
};

function statusDetails(status: SolanaActivityStatus) {
  if (status === 'failed') {
    return { className: 'text-red-600', icon: XCircleIcon, label: 'Failed' };
  }
  return {
    className: 'text-green-700',
    icon: CheckCircle2Icon,
    label: 'Confirmed',
  };
}

function formatActivityAsset(
  asset: SolanaActivityAsset | undefined,
): string | undefined {
  if (!asset) {
    return undefined;
  }
  const amount = formatSolanaSwapUnits(asset.amount, asset.decimals);
  const label = asset.mint
    ? `${asset.mint.slice(0, 4)}…${asset.mint.slice(-4)}`
    : 'SOL';
  return `${amount} ${label}`;
}

function amountLabel(activity: SolanaActivity): string | undefined {
  const sent = formatActivityAsset(activity.sentAsset);
  const received = formatActivityAsset(activity.receivedAsset);
  if (activity.type === 'swap' && sent && received) {
    return `${sent} → ${received}`;
  }
  if (activity.type === 'receive') {
    return received;
  }
  if (activity.type === 'send') {
    return sent;
  }
  return undefined;
}

export function ExternalSolanaWalletActivity({ address }: { address: string }) {
  const query = useSolanaActivity(address);
  const activity = query.data ?? [];

  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted">
          Five most recent transactions on Solana Mainnet.
        </p>
        <button
          className="flex shrink-0 items-center gap-1 text-sm text-accent hover:underline disabled:opacity-50"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
          type="button"
        >
          <RefreshCwIcon
            className={`size-4 ${query.isFetching ? 'animate-spin' : ''}`}
          />
          Refresh
        </button>
      </div>

      {query.isPending && (
        <div
          className="flex items-center justify-center gap-2 rounded-2xl py-10 text-sm text-muted bg-elevated-nohover"
          role="status"
        >
          <LoaderCircleIcon className="size-5 animate-spin" />
          Loading Solana activity…
        </div>
      )}

      {query.isError && (
        <div
          className="rounded-xl bg-yellow-50 p-3 text-sm text-yellow-800"
          role="alert"
        >
          {query.error instanceof Error
            ? query.error.message
            : 'Solana activity is temporarily unavailable.'}
        </div>
      )}

      {!query.isPending && !query.isError && activity.length === 0 && (
        <div className="rounded-2xl py-10 text-center text-sm text-muted bg-elevated-nohover">
          No recent activity found on Solana Mainnet.
        </div>
      )}

      {activity.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-default">
          {activity.map((item) => {
            const details = typeDetails[item.type];
            const TypeIcon = details.icon;
            const status = statusDetails(item.status);
            const StatusIcon = status.icon;
            const amount = amountLabel(item);
            return (
              <a
                className="flex items-center gap-3 border-b p-3 border-default last:border-b-0 hover:bg-overlay-light"
                href={solanaTransactionUrl(item.signature)}
                key={item.signature}
                rel="noreferrer"
                target="_blank"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-elevated-nohover">
                  <TypeIcon className="size-4 text-default" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-semibold text-default">
                      {details.label}
                    </span>
                    {amount && (
                      <span className="truncate text-sm font-medium text-default">
                        {amount}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <span
                      className={`flex items-center gap-1 ${status.className}`}
                    >
                      <StatusIcon className="size-3" />
                      {status.label}
                    </span>
                    {item.timestamp !== undefined && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {formatDistanceToNow(item.timestamp * 1000, {
                            addSuffix: true,
                          })}
                        </span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{`${item.signature.slice(0, 4)}…${item.signature.slice(-4)}`}</span>
                  </div>
                </div>
                <ExternalLinkIcon className="size-4 shrink-0 text-muted" />
              </a>
            );
          })}
        </div>
      )}

      <a
        className="flex items-center justify-center gap-2 rounded-xl p-3 text-sm font-semibold text-accent bg-elevated-nohover hover:bg-overlay-light"
        href={solanaAddressUrl(address)}
        rel="noreferrer"
        target="_blank"
      >
        View all on Solana Explorer
        <ExternalLinkIcon className="size-4" />
      </a>
    </div>
  );
}
