/**
 * The servers Fiddy may read from, in the order the reader wants them tried.
 *
 * The node picker above this card answers "which one server do you want?". This
 * card answers the question that follows: "and what should happen when it stops
 * answering?" The reader's list is an order, not a promise — the first entry is
 * their preference, and the engine moves down the list when that entry gets
 * slow, falls behind the network, or stops answering at all, then moves back up
 * once it has recovered.
 *
 * Everything shown here is measured, never assumed: each row carries the result
 * of the last check, in plain words, and the row that is live says so. When a
 * check has not run yet, the row says that too — a card full of green ticks
 * before anything was measured would be the same lie a pill full of unearned
 * claims would be.
 */

import React, { memo, useCallback, useState } from 'react';

import {
  capabilitiesOf,
  preferProvider,
  type ProviderRuntimeSnapshot,
  useProviderWatch,
} from '~/snapchain/providers';
import { providerPillView } from '~/snapchain/providers/pill';
import type { NodeProvider } from '~/snapchain/providers/providerTypes';

/** The status of one provider, in the reader's words. */
export const providerStatusWord = (status: string | undefined): string => {
  switch (status) {
    case 'live':
      return 'working';
    case 'slow':
      return 'working, but slowly';
    case 'stale':
      return 'behind the network';
    case 'unconfigured':
      return 'needs a key';
    case 'down':
      return 'not answering';
    default:
      return 'not checked yet';
  }
};

const STATUS_CLASSES: Record<string, string> = {
  live: 'text-[#d4ff3f]',
  slow: 'text-[#f5c451]',
  stale: 'text-[#f5c451]',
  unconfigured: 'text-muted',
  down: 'text-red-400',
};

const statusClass = (status: string | undefined): string =>
  STATUS_CLASSES[status ?? ''] ?? 'text-muted';

export interface ProviderListCardProps {
  /** Who the order belongs to; the watch needs them. */
  fid: number | undefined;
  /** Test seam: render one snapshot instead of reading the live one. */
  snapshot?: ProviderRuntimeSnapshot;
  /** Test seam: called instead of the runtime's own store. */
  onPrefer?: (provider: NodeProvider) => void;
}

const ProviderListCard = memo<ProviderListCardProps>(
  ({ fid, snapshot, onPrefer }) => {
    const live = useProviderWatch(fid);
    const view = snapshot ?? live;
    const [busy, setBusy] = useState<string | null>(null);

    const handlePrefer = useCallback(
      (provider: NodeProvider) => {
        if (onPrefer) {
          onPrefer(provider);
          return;
        }
        if (fid === undefined) {
          return;
        }
        setBusy(provider.id);
        void preferProvider(fid, provider.id).finally(() => setBusy(null));
      },
      [fid, onPrefer],
    );

    const pill = providerPillView(view);
    const activeIndex = view.order.findIndex(
      (provider) => provider.id === view.activeId,
    );

    return (
      <div className="solid-glass-pane rounded-lg border p-4 border-default">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold text-primary">
            Which servers to read from
          </span>
          <span className="text-xs text-muted">
            first one that answers well wins
          </span>
        </div>

        <p className="mb-3 text-xs text-muted">
          Fiddy reads from the first server on this list that is answering
          normally. If it gets slow, falls behind the network or stops
          answering, Fiddy moves down the list on its own and tells you in the
          corner of the screen — then comes back to your first choice once it is
          healthy again.
        </p>

        <p className="mb-3 text-xs text-muted">
          Every row says what that server can do: <strong>reads + posts</strong>{' '}
          means it can also carry a like, a follow or a cast you signed, and{' '}
          <strong>reads only</strong> means it cannot — a write is never quietly
          sent through a different server than the one you are on.
        </p>

        <div className="mb-3 rounded border p-3 text-xs bg-tertiary border-default">
          <div className="font-medium text-primary">
            {view.activeId ? pill.label : 'Checking your servers…'}
          </div>
          <div className="mt-1 text-muted">
            {view.activeId
              ? `Right now: ${view.order[activeIndex]?.label ?? 'a server'}.`
              : 'Nothing measured yet — the first check runs as soon as this page opens.'}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {view.order.map((provider, index) => {
            const health = view.health[provider.id];
            const isActive = provider.id === view.activeId;
            const errors = view.readErrors[provider.id] ?? 0;
            const capability = capabilitiesOf(provider);
            return (
              <div
                key={provider.id}
                className="flex flex-col gap-1 rounded border p-2 border-default"
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-xs text-muted">{index + 1}.</span>
                  <span className="flex-1 text-primary">{provider.label}</span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-xs ${
                      capability.writes
                        ? 'border-[#d4ff3f]/40 text-[#d4ff3f]'
                        : 'text-muted border-default'
                    }`}
                  >
                    {capability.label}
                  </span>
                  <span className={`text-xs ${statusClass(health?.status)}`}>
                    {providerStatusWord(health?.status)}
                  </span>
                  {isActive && (
                    <span className="rounded px-2 py-0.5 text-xs font-medium text-[#1a1c10] bg-action-primary">
                      in use
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted">{provider.detail}</div>
                <div className="text-xs text-muted">
                  {capability.writeDetail}
                </div>
                {health?.detail ? (
                  <div className={`text-xs ${statusClass(health.status)}`}>
                    {health.detail}
                  </div>
                ) : null}
                {errors > 0 ? (
                  <div className="text-xs text-red-400">
                    {errors} read{errors === 1 ? '' : 's'} in a row failed
                    through this one.
                  </div>
                ) : null}
                {index > 0 && !isActive ? (
                  <button
                    type="button"
                    onClick={() => handlePrefer(provider)}
                    disabled={busy === provider.id}
                    className="text-action-primary mt-1 w-max rounded border px-2 py-1 text-xs border-default hover:bg-tertiary disabled:opacity-50"
                  >
                    {busy === provider.id ? 'Moving…' : 'Try this one first'}
                  </button>
                ) : null}
              </div>
            );
          })}
          {view.order.length === 0 ? (
            <div className="text-xs text-muted">
              Nothing to read from yet. Pick a server above, or paste the
              address of one you run.
            </div>
          ) : null}
        </div>

        <div className="mt-3 text-xs text-muted">
          With a Neynar key saved, Neynar is where Fiddy starts — it is the one
          server here that both reads and posts, so a like works without you
          picking anything. The follow-graph feed, your unseen counts and your
          notifications still come from a node, because Neynar’s index does not
          have them. Farcaster’s own server stays last: it is read-only and
          cannot say how far behind it is.
        </div>
      </div>
    );
  },
);

ProviderListCard.displayName = 'ProviderListCard';

export { ProviderListCard };
