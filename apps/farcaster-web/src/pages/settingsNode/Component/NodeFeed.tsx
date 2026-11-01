/**
 * Node Feed - your home feed, assembled from your own node.
 *
 * A read node has no indexer and no home-feed endpoint, so the feed is built
 * locally: read the follow graph, read each followee's casts, merge on the
 * Farcaster timestamp. Likes, recasts and follows are ordinary messages the
 * client signs and submits to the same node.
 */

import { HeartIcon, RepeatIcon, UserPlusIcon } from 'lucide-react';
import React, { memo } from 'react';

interface FeedCast {
  cast: {
    fid: number;
    hash: string;
    signer: string;
    timestamp: number;
    timestampMs: number;
    castAdd?: { text: string; embeds: unknown[] };
  };
  client?: {
    id: string;
    label: string;
  };
}

interface NodeFeedProps {
  casts: FeedCast[];
  loading: boolean;
  isFallback: boolean;
  onRefresh: () => void;
  onReact: (
    castFid: number,
    castHash: string,
    reactionType: 'like' | 'recast',
    remove: boolean,
  ) => void;
  onFollow: (targetFid: number, remove: boolean) => void;
}

const formatRelativeTime = (timestampMs: number): string => {
  const diffMs = Date.now() - timestampMs;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) {
    return `${diffSec}s`;
  }
  if (diffMin < 60) {
    return `${diffMin}m`;
  }
  if (diffHour < 24) {
    return `${diffHour}h`;
  }
  return `${diffDay}d`;
};

const NodeFeed = memo<NodeFeedProps>(
  ({ casts, loading, isFallback, onRefresh, onReact, onFollow }) => {
    return (
      <div className="solid-glass-pane rounded-lg border p-4 border-default">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="font-semibold text-primary">Feed</span>
            <span className="text-xs text-muted">
              {isFallback
                ? 'Your own casts — the follow graph on your setup is empty'
                : 'Your follow graph, read from your own setup and merged locally'}
            </span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="text-action-primary text-sm hover:underline disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {casts.length === 0 && !loading ? (
          <div className="py-8 text-center text-muted">
            No casts yet — post one above, or follow someone.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {casts.map(({ cast, client }) => (
              <div
                key={`${cast.fid}:${cast.hash}`}
                className="flex flex-col gap-2 rounded border p-3 border-default"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-primary">
                    FID {cast.fid}
                  </span>
                  <span className="text-xs text-muted">
                    {formatRelativeTime(cast.timestampMs)}
                  </span>
                </div>

                {cast.castAdd && (
                  <div className="text-sm text-primary">
                    {cast.castAdd.text}
                  </div>
                )}

                {client && (
                  <div className="text-xs text-muted">via {client.label}</div>
                )}

                <div className="flex gap-4 pt-2">
                  <button
                    type="button"
                    onClick={() => onReact(cast.fid, cast.hash, 'like', false)}
                    className="hover:text-action-primary flex items-center gap-1 text-sm text-muted"
                  >
                    <HeartIcon size={14} />
                    <span>Like</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onReact(cast.fid, cast.hash, 'recast', false)
                    }
                    className="hover:text-action-primary flex items-center gap-1 text-sm text-muted"
                  >
                    <RepeatIcon size={14} />
                    <span>Recast</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onFollow(cast.fid, false)}
                    className="hover:text-action-primary flex items-center gap-1 text-sm text-muted"
                  >
                    <UserPlusIcon size={14} />
                    <span>Follow</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  },
);

NodeFeed.displayName = 'NodeFeed';

export { NodeFeed };
