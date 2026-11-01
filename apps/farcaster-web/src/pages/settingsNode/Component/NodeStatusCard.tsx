/**
 * Node Status Card - is your own Snapchain node answering, and how far has it synced.
 *
 * The recovery copy is the point of this card: the common failure is a node that
 * is fine but not reachable from the browser (it lives behind an SSH tunnel), so
 * the card names the three ways back — and never claims the client is broken.
 */

import { CheckIcon, XIcon } from 'lucide-react';
import React, { memo } from 'react';

import { DEFAULT_NODE_URL, NODE_PROXY_PATH } from '~/snapchain/nodeEnv';

interface NodeStatusCardProps {
  health: {
    ok: boolean;
    baseUrl: string;
    latencyMs: number;
    version?: string;
    numShards?: number;
    maxHeight?: number;
    error?: string;
  } | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
  /**
   * Which network this client is reading, in the reader's words ("Hypersnap",
   * "Snapchain", or "Not recorded"). A node's own status says nothing about
   * which network it is — `/v1/info` carries no network name — so this is the
   * only place the reader can learn it, and it must not be left blank.
   */
  network?: string;
}

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-4">
    <span className="text-muted">{label}</span>
    <span className="text-right text-primary">{value}</span>
  </div>
);

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="font-mono rounded px-1 text-[11px] text-primary bg-tertiary">
    {children}
  </code>
);

const NodeStatusCard = memo<NodeStatusCardProps>(
  ({ health, loading, onRefresh, network }) => {
    if (!health) {
      return (
        <div className="solid-glass-pane rounded-lg border p-4 border-default">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-primary">Your setup</span>
            <span className="text-sm text-muted">Checking…</span>
          </div>
        </div>
      );
    }

    const showingRelay = health.baseUrl === NODE_PROXY_PATH;

    return (
      <div className="solid-glass-pane rounded-lg border p-4 border-default">
        <div className="mb-4 flex items-center justify-between">
          <span className="font-semibold text-primary">Your setup</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="text-action-primary text-sm hover:underline disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted">Status</span>
            <span
              className={`flex items-center gap-1 ${
                health.ok ? 'text-action-primary' : 'text-danger'
              }`}
            >
              {health.ok ? <CheckIcon size={16} /> : <XIcon size={16} />}
              {health.ok ? 'Connected' : 'Unreachable'}
            </span>
          </div>

          {network && (
            <Row
              label="Network"
              value={<span data-fiddy="node-network">{network}</span>}
            />
          )}

          <Row
            label={showingRelay ? 'Path' : 'Its address'}
            value={
              <span className="font-mono text-xs">
                {health.baseUrl || DEFAULT_NODE_URL}
              </span>
            }
          />

          {showingRelay && (
            <div className="text-xs text-muted">
              A browser cannot call a plain-HTTP setup directly — this page is
              HTTPS, and your setup does not answer the cross-origin check. So
              Fiddy proxies this path on the server side, through to your
              setup&rsquo;s address.
            </div>
          )}

          {health.ok && (
            <>
              <Row label="Latency" value={`${health.latencyMs}ms`} />
              {health.version && <Row label="Version" value={health.version} />}
              {health.numShards !== undefined && (
                <Row label="Shards" value={health.numShards} />
              )}
              {health.maxHeight !== undefined && (
                <Row
                  label="Top shard height"
                  value={health.maxHeight.toLocaleString()}
                />
              )}
            </>
          )}

          {!health.ok && health.error && (
            <div className="mt-2 rounded border p-3 text-xs bg-tertiary border-default">
              <div className="font-semibold text-danger">
                Your setup did not answer
              </div>
              {/* Plain words by default; the library's own message, which names
                  the software, is one click away for whoever is debugging. */}
              <div className="mt-1 text-muted">
                Nothing is broken for you — Fiddy serves the feed itself while
                your own setup is quiet.
              </div>
              <details className="mt-2 text-muted">
                <summary className="cursor-pointer text-primary">
                  Show the exact error
                </summary>
                <div className="font-mono mt-1">{health.error}</div>
              </details>
              <div className="mt-2 text-muted">
                <div className="mb-1 text-primary">Ways back:</div>
                <ul className="list-inside list-disc space-y-1">
                  <li>
                    Is it running? <Code>fiddy node status</Code>
                  </li>
                  <li>
                    Not public? <Code>fiddy client up --tunnel</Code> opens the
                    tunnel for you
                  </li>
                  <li>
                    Manually:{' '}
                    <Code>ssh -N -L 3381:127.0.0.1:3381 user@your-node</Code>
                  </li>
                  <li>
                    Different port or host? Set <Code>SNAPCHAIN_HTTP_URL</Code>{' '}
                    in <Code>.env.local</Code> and restart the client
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);

NodeStatusCard.displayName = 'NodeStatusCard';

export { NodeStatusCard };
