import { formatDistanceToNow } from 'date-fns';
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  CircleEllipsisIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  LoaderCircleIcon,
  RefreshCwIcon,
  Repeat2Icon,
  ShieldCheckIcon,
  XCircleIcon,
} from 'lucide-react';
import React, { useMemo } from 'react';
import { Address, Chain } from 'viem';

import { useWalletActivity } from '~/hooks/useWalletActivity';
import { truncateAddress } from '~/utils/ethereumUtils';
import {
  formatWalletActivityAsset,
  mergeWalletActivity,
  readLocalWalletActivity,
  WalletActivity,
} from '~/utils/walletActivity';

const typeDetails = {
  send: { label: 'Sent', icon: ArrowUpRightIcon },
  receive: { label: 'Received', icon: ArrowDownLeftIcon },
  swap: { label: 'Swap', icon: Repeat2Icon },
  approval: { label: 'Approval', icon: ShieldCheckIcon },
  contract: { label: 'Contract interaction', icon: FileCode2Icon },
} as const;

function amountLabel(activity: WalletActivity) {
  const from = formatWalletActivityAsset(activity.fromAsset);
  const to = formatWalletActivityAsset(activity.toAsset);
  if (activity.type === 'swap' && from && to) {
    return `${from} → ${to}`;
  }
  if (activity.type === 'receive') {
    return to;
  }
  return from;
}

function statusDetails(status: WalletActivity['status']) {
  if (status === 'pending') {
    return {
      label: 'Pending',
      icon: CircleEllipsisIcon,
      className: 'text-muted',
    };
  }
  if (status === 'failed') {
    return { label: 'Failed', icon: XCircleIcon, className: 'text-red-600' };
  }
  return {
    label: 'Confirmed',
    icon: CheckCircle2Icon,
    className: 'text-green-700',
  };
}

export function ExternalWalletActivity({
  address,
  chain,
}: {
  address: Address;
  chain: Chain;
}) {
  const query = useWalletActivity(address, chain);
  const local = readLocalWalletActivity(address, chain.id);
  const activity = useMemo(
    () => mergeWalletActivity(query.data ?? [], local),
    [query.data, local],
  );
  const explorer = chain.blockExplorers?.default;

  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted">
          Five most recent transactions on {chain.name}.
        </p>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 text-sm text-accent hover:underline disabled:opacity-50"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCwIcon
            className={`size-4 ${query.isFetching ? 'animate-spin' : ''}`}
          />
          Refresh
        </button>
      </div>

      {query.isPending && activity.length === 0 && (
        <div
          className="flex items-center justify-center gap-2 rounded-2xl py-10 text-sm text-muted bg-elevated-nohover"
          role="status"
        >
          <LoaderCircleIcon className="size-5 animate-spin" />
          Loading {chain.name} activity…
        </div>
      )}

      {query.isError && (
        <div
          className="rounded-xl bg-yellow-50 p-3 text-sm text-yellow-800"
          role="alert"
        >
          {query.error instanceof Error
            ? query.error.message
            : 'Complete explorer history is temporarily unavailable.'}
          {activity.length > 0 ? ' Showing activity saved by this client.' : ''}
        </div>
      )}

      {!query.isPending && !query.isError && activity.length === 0 && (
        <div className="rounded-2xl py-10 text-center text-sm text-muted bg-elevated-nohover">
          No recent activity found on {chain.name}.
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
            const content = (
              <>
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
                    <span aria-hidden="true">·</span>
                    <span>
                      {formatDistanceToNow(item.timestamp, { addSuffix: true })}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{truncateAddress(item.hash, 5)}</span>
                  </div>
                </div>
                {explorer && (
                  <ExternalLinkIcon className="size-4 shrink-0 text-muted" />
                )}
              </>
            );
            return explorer ? (
              <a
                key={`${item.chainId}:${item.hash}`}
                className="flex items-center gap-3 border-b p-3 border-default last:border-b-0 hover:bg-overlay-light"
                href={`${explorer.url}/tx/${item.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                {content}
              </a>
            ) : (
              <div
                key={`${item.chainId}:${item.hash}`}
                className="flex items-center gap-3 border-b p-3 border-default last:border-b-0"
              >
                {content}
              </div>
            );
          })}
        </div>
      )}

      {explorer && (
        <a
          className="flex items-center justify-center gap-2 rounded-xl p-3 text-sm font-semibold text-accent bg-elevated-nohover hover:bg-overlay-light"
          href={`${explorer.url}/address/${address}`}
          target="_blank"
          rel="noreferrer"
        >
          View all on {explorer.name}
          <ExternalLinkIcon className="size-4" />
        </a>
      )}
    </div>
  );
}
