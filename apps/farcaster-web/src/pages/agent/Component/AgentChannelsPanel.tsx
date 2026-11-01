/**
 * Channel connections, one approval each.
 *
 * The rule the product promises: a channel is connected only after the owner
 * approves that specific channel. So every row starts unapproved, approving is
 * a separate click, and connecting sends the owner to the agent's own side to
 * finish — the client never receives a channel credential.
 *
 * Channels the service does not offer yet are listed with an explicit tag
 * instead of a dead switch.
 */

import React, { memo, useState } from 'react';

import type { ChannelConnection, ChannelToolkit } from '~/lib/agentService';

export interface AgentChannelsPanelProps {
  toolkits: ChannelToolkit[];
  connections: ChannelConnection[];
  busyToolkit: string | null;
  error: string | null;
  /** Channels Hermes supports that this service has not exposed yet. */
  pending: string[];
  onConnect: (toolkit: string) => void;
}

const CONNECTED_STATES = new Set(['CONNECTED', 'ACTIVE', 'READY']);

export const AgentChannelsPanel = memo<AgentChannelsPanelProps>(
  ({ toolkits, connections, busyToolkit, error, pending, onConnect }) => {
    const [approved, setApproved] = useState<Record<string, boolean>>({});
    const connectionFor = (slug: string): ChannelConnection | undefined =>
      connections.find(
        (connection) =>
          connection.toolkitSlug === slug ||
          connection.toolkitName.toLowerCase() === slug.toLowerCase(),
      );

    return (
      <section className="solid-glass-pane rounded-[18px] p-4">
        <h2 className="text-sm font-semibold text-default">Channels</h2>
        <p className="mb-4 mt-1 text-xs text-muted">
          Each channel is a separate decision. Approve the one you want, then
          finish the connection on your agent's side. Nothing here stores a
          channel credential in this browser.
        </p>

        {error ? (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-red-800 bg-red-900/20 p-2 text-xs text-red-300"
          >
            {error}
          </p>
        ) : null}

        {toolkits.length === 0 ? (
          <p className="py-4 text-sm text-muted">
            This service has not exposed any channel toolkits yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {toolkits.map((toolkit) => {
              const connection = connectionFor(toolkit.slug);
              const connected = Boolean(
                connection &&
                CONNECTED_STATES.has(connection.status.toUpperCase()),
              );
              const isApproved = approved[toolkit.slug] === true;
              const busy = busyToolkit === toolkit.slug;

              return (
                <li
                  key={toolkit.slug}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[rgba(255,255,255,0.09)] p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-default">{toolkit.name}</p>
                    <p className="text-xs text-muted">
                      {connected
                        ? `connected${connection ? ` · ${connection.status}` : ''}`
                        : toolkit.description || 'not connected'}
                    </p>
                  </div>

                  {connected ? (
                    <span className="rounded-full border border-[#d4ff3f]/40 px-2 py-0.5 text-xs text-[#d4ff3f]">
                      approved
                    </span>
                  ) : isApproved ? (
                    <button
                      type="button"
                      onClick={() => onConnect(toolkit.slug)}
                      disabled={Boolean(busyToolkit)}
                      className="rounded-lg bg-[#d4ff3f] px-3 py-1.5 text-xs font-semibold text-[#1a1c10] hover:opacity-90 disabled:opacity-40"
                    >
                      {busy ? 'Opening…' : 'Finish on agent side →'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setApproved((current) => ({
                          ...current,
                          [toolkit.slug]: true,
                        }))
                      }
                      className="rounded-lg border border-[rgba(255,255,255,0.09)] px-3 py-1.5 text-xs text-muted hover:text-default"
                    >
                      Approve connection
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {pending.length > 0 ? (
          <div className="mt-4 border-t border-[rgba(255,255,255,0.09)] pt-3">
            <p className="mb-2 text-xs font-medium text-muted">
              Supported by Hermes, not offered by this service yet
            </p>
            <ul className="flex flex-wrap gap-2">
              {pending.map((channel) => (
                <li
                  key={channel}
                  className="rounded-full border border-[rgba(255,255,255,0.09)] px-2 py-0.5 text-xs text-muted"
                >
                  {channel} · soon
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    );
  },
);

AgentChannelsPanel.displayName = 'AgentChannelsPanel';
