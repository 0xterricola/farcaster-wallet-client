/**
 * Which network Fiddy reads — and only the ones it can actually read.
 *
 * Two networks carry the same kind of social data:
 *
 *   Snapchain — Farcaster's own network, where every account, cast and follow
 *               lives. The one to pick.
 *   Hypersnap — an independent parallel network built by the Quilibrium
 *               community. For explorers; not where a Farcaster account lives.
 *
 * This card exists because the client could not previously say which of the two
 * it was reading from: a node's own `/v1/info` carries no network name
 * (measured — see `~/snapchain/networks`), so the honest answer is provenance:
 * the address, or what whoever set this client up recorded.
 *
 * What it refuses to do, on purpose: offer a network it has no address for.
 * Snapchain has no public node a stranger can read (measured: Neynar's two
 * endpoints answer "payment or API key required"), so on a build without its own
 * node Snapchain is shown as unavailable, with the one command that changes
 * that, rather than as a button that fails after it is pressed. Pressing a
 * network that IS offered really moves the reads: it saves that network's
 * address as this reader's server.
 */

import { SnapchainNodeClient } from 'farcaster-node-client';
import React, { memo, useCallback, useState } from 'react';

import {
  FIDDY_NETWORKS,
  networkName,
  type NetworkOffer,
  type NetworkReading,
  type NetworkRoute,
} from '~/snapchain/networks';

interface NetworkChoiceCardProps {
  /** Which network this client is reading now, and why that is the answer. */
  reading: NetworkReading;
  /** Both networks, each with the address this client can read it from. */
  offers: NetworkOffer[];
  /** Point the client at this network's server (the existing node choice). */
  onChooseRoute: (route: NetworkRoute) => Promise<unknown> | unknown;
}

interface Outcome {
  ok: boolean;
  text: string;
}

/** Ask a network's address for its own status; report exactly what came back. */
const checkRoute = async (route: NetworkRoute): Promise<Outcome> => {
  try {
    const health = await new SnapchainNodeClient({
      baseUrl: route.url.replace(/\/+$/, ''),
    }).health();
    if (health.ok) {
      return {
        ok: true,
        text: `${networkName(
          route.network,
        )} answered in ${health.latencyMs} ms${
          health.info?.version ? ` · v${health.info.version}` : ''
        }.`,
      };
    }
    return {
      ok: false,
      text: `${networkName(
        route.network,
      )} did not answer just now. Fiddy keeps using what it used before, and will say so, until it does.`,
    };
  } catch (error) {
    return {
      ok: false,
      text: `${networkName(route.network)} did not answer just now (${
        error instanceof Error ? error.message : String(error)
      }).`,
    };
  }
};

const NetworkChoiceCard = memo<NetworkChoiceCardProps>(
  ({ reading, offers, onChooseRoute }) => {
    const [busy, setBusy] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);

    const choose = useCallback(
      async (route: NetworkRoute) => {
        setBusy(route.network);
        setOutcome(null);
        try {
          await onChooseRoute(route);
          setOutcome(await checkRoute(route));
        } finally {
          setBusy(null);
        }
      },
      [onChooseRoute],
    );

    const check = useCallback(
      async (network: string) => {
        const route = offers.find((offer) => offer.facts.id === network)?.route;
        if (!route) {
          return;
        }
        setBusy(network);
        setOutcome(null);
        try {
          setOutcome(await checkRoute(route));
        } finally {
          setBusy(null);
        }
      },
      [offers],
    );

    return (
      <div
        className="solid-glass-pane rounded-lg border p-4 border-default"
        data-fiddy="network-choice"
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold text-primary">Network</span>
          <span className="text-xs text-muted" data-fiddy="network-current">
            reading from {networkName(reading.network).toLowerCase()}
          </span>
        </div>

        <p className="mb-4 text-sm text-muted">
          Two networks, same idea. Both carry accounts, casts and follows, and
          they do not talk to each other. Fiddy only offers a network it can
          actually read.
        </p>

        <div className="flex flex-col gap-3">
          {offers.map((offer) => {
            const { facts, route } = offer;
            const inUse =
              reading.network === facts.id && reading.source !== null;
            return (
              <div
                key={facts.id}
                className={`rounded-lg border p-4 ${
                  inUse ? 'border-[#d4ff3f]/50 bg-tertiary' : 'border-default'
                }`}
                data-fiddy={`network-row-${facts.id}`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-primary">{facts.name}</span>
                  <span className="text-xs text-muted">{facts.builtBy}</span>
                </div>
                <p className="mt-1 text-sm text-muted">{facts.sentence}</p>
                <p className="mt-1 text-xs text-muted">
                  {facts.detail} {facts.accountLine}
                </p>

                {route ? (
                  <div className="mt-3 flex flex-col gap-1">
                    <span
                      className="font-mono text-xs text-primary"
                      data-fiddy={`network-route-${facts.id}`}
                    >
                      {route.url}
                    </span>
                    <span className="text-xs text-muted">{route.note}</span>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => choose(route)}
                        disabled={busy !== null}
                        className="rounded px-3 py-1 text-xs text-[#1a1c10] bg-action-primary disabled:opacity-50"
                        data-fiddy={`network-use-${facts.id}`}
                      >
                        {busy === facts.id
                          ? 'Switching…'
                          : inUse
                            ? 'Reading from this one'
                            : `Read from ${facts.name}`}
                      </button>
                      <button
                        type="button"
                        onClick={() => check(facts.id)}
                        disabled={busy !== null}
                        className="rounded px-2 py-1 text-xs text-muted hover:text-primary disabled:opacity-50"
                      >
                        Check it
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="mt-3 text-xs text-muted"
                    data-fiddy={`network-blocked-${facts.id}`}
                  >
                    {offer.why}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="mt-4 text-xs text-muted">
          {reading.why}
          {reading.source === 'address'
            ? ' A node does not announce its network, so this is read from the address, not from the server.'
            : ''}
        </p>

        {outcome && (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 rounded border p-2 text-xs text-muted bg-tertiary border-default"
          >
            {outcome.text}
          </div>
        )}

        {/* Both names are always on screen, even when one cannot be used: the
            choice is between two real networks, and a reader who cannot use one
            of them yet is told why rather than left to wonder. */}
        <span className="sr-only" data-fiddy="network-known">
          {FIDDY_NETWORKS.map((entry) => entry.name).join(', ')}
        </span>
      </div>
    );
  },
);

NetworkChoiceCard.displayName = 'NetworkChoiceCard';

export { NetworkChoiceCard };
