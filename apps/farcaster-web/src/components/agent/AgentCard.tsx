/**
 * The two cards the agent surface is built from.
 *
 * `AgentHatchCard` is the empty state: an egg, one action, and an honest line
 * about whether hatching is open on the service you are pointed at.
 * `AgentIdentityCard` is the header of a live agent: who it is, where it runs,
 * and the lifecycle actions that cost money if you get them wrong.
 *
 * Honesty rule for both: nothing here may claim a capability the service has
 * not confirmed. Unwired things carry a "soon" tag; unavailable things say so
 * in words.
 */

import React, { memo } from 'react';

export type HatchAvailability = 'unknown' | 'open' | 'closed' | 'unreachable';

export interface AgentHatchCardProps {
  availability: HatchAvailability;
  /** Live Hermes catalog receipt, when it could be fetched. */
  catalog?: { skills: number; plugins: number } | null;
  onHatch: () => void;
  onPair: () => void;
}

const availabilityCopy: Record<HatchAvailability, string> = {
  unknown:
    'Hatching is managed by your agent service. Pair it to see whether it is open and what it would cost.',
  open: 'Hatching is open.',
  closed:
    'Hatching is not open on this service yet. Pairing an agent you already run works today.',
  unreachable: 'Your agent service is not answering, so hatching cannot start.',
};

/** Exported so paired-but-empty screens can state it too. */
export const hatchAvailabilityCopy = availabilityCopy;

const CHANNELS = [
  'Farcaster',
  'iMessage',
  'Discord',
  'Telegram',
  'WhatsApp',
  'Email',
  'Web / API',
];

export const AgentHatchCard = memo<AgentHatchCardProps>(
  ({ availability, catalog, onHatch, onPair }) => {
    const hatchable = availability === 'open';
    return (
      <section className="solid-glass-pane mx-auto w-full max-w-xl rounded-[18px] p-8 text-center">
        <div className="mx-auto mb-6 flex h-28 w-28 items-center justify-center">
          <svg
            aria-hidden="true"
            className="h-full w-full"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#9ba193"
            strokeWidth="1"
          >
            <path d="M12 3C7.5 3 4 7.5 4 12c0 10 8 11 16 11S20 22 20 12c0-4.5-3.5-9-8-9z" />
          </svg>
        </div>

        <h1 className="mb-3 font-[SeasonMix] text-2xl font-semibold text-default">
          Your agent, on your accounts
        </h1>
        <p className="mb-6 text-muted">
          A Hermes agent that keeps working when this tab is closed: it reads
          your mentions, drafts casts, and answers on the channels you approve.
          Its keys stay on its own machine — this browser never holds one.
        </p>

        <div className="mb-6 rounded-2xl border border-[rgba(255,255,255,0.09)] bg-[rgba(255,255,255,0.04)] p-4 text-left">
          <h2 className="mb-2 text-sm font-semibold text-[#d4ff3f]">
            Channels, each with your approval
          </h2>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-muted">
            {CHANNELS.map((channel) => (
              <li key={channel} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-[#7cb518]"
                />
                {channel}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            A channel is a connection to your agent, never a credential in this
            browser. You approve each one on its own screen.
          </p>
        </div>

        {catalog && (catalog.skills > 0 || catalog.plugins > 0) ? (
          <p className="mb-6 text-xs text-muted">
            A hatched agent runs the live Hermes catalog:{' '}
            {catalog.skills.toLocaleString()} skills and{' '}
            {catalog.plugins.toLocaleString()} plugins, read from the catalog
            just now.
          </p>
        ) : null}

        <button
          type="button"
          onClick={onHatch}
          disabled={!hatchable}
          className="solid-glass-pane inline-block rounded-xl bg-[#d4ff3f] px-6 py-3 text-sm font-semibold text-[#1a1c10] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#d4ff3f] focus-visible:ring-offset-2 focus-visible:ring-offset-[#161715] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {hatchable ? 'Hatch your Fiddy' : 'Hatch your Fiddy · soon'}
        </button>

        <p role="status" aria-live="polite" className="mt-3 text-xs text-muted">
          {availabilityCopy[availability]}
        </p>

        <div className="mt-6 border-t border-[rgba(255,255,255,0.09)] pt-4">
          <button
            type="button"
            onClick={onPair}
            className="text-sm text-[#d4ff3f] underline underline-offset-4 hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#d4ff3f]"
          >
            I run my own agent service — pair it
          </button>
        </div>
      </section>
    );
  },
);

AgentHatchCard.displayName = 'AgentHatchCard';

export interface AgentIdentityCardProps {
  name: string;
  status: string;
  serviceUrl: string;
  busy?: boolean;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
  onDestroy?: () => void;
  onForget: () => void;
}

const isRunning = (status: string): boolean => {
  const normalised = status.toLowerCase();
  return normalised === 'running' || normalised === 'awake';
};

const statusTone = (status: string): string => {
  const normalised = status.toLowerCase();
  if (isRunning(normalised)) {
    return 'text-[#d4ff3f]';
  }
  if (normalised === 'error' || normalised === 'failed') {
    return 'text-red-400';
  }
  return 'text-muted';
};

export const AgentIdentityCard = memo<AgentIdentityCardProps>(
  ({
    name,
    status,
    serviceUrl,
    busy = false,
    onStart,
    onStop,
    onRestart,
    onDestroy,
    onForget,
  }) => {
    const running = isRunning(status);
    return (
      <header className="solid-glass-pane mb-4 rounded-[18px] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-[#d4ff3f] bg-[#1d1e1c]">
              <span
                aria-hidden="true"
                className="text-lg font-bold text-[#d4ff3f]"
              >
                {name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div>
              <h1 className="font-[SeasonMix] text-lg font-semibold text-default">
                {name}
              </h1>
              <p className={`text-sm font-medium ${statusTone(status)}`}>
                <span
                  aria-hidden="true"
                  className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
                    running ? 'bg-[#d4ff3f]' : 'bg-[#9ba193]'
                  }`}
                />
                {status}
              </p>
              <p className="truncate text-xs text-muted">
                runs on {serviceUrl.replace('https://', '')}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {onStart && !running ? (
              <button
                type="button"
                onClick={onStart}
                disabled={busy}
                className="rounded-lg border border-[#d4ff3f] px-3 py-1.5 text-xs font-medium text-[#d4ff3f] hover:bg-[#d4ff3f]/10 disabled:opacity-40"
              >
                Start
              </button>
            ) : null}
            {onStop && running ? (
              <button
                type="button"
                onClick={onStop}
                disabled={busy}
                className="rounded-lg border border-[rgba(255,255,255,0.09)] px-3 py-1.5 text-xs text-muted hover:text-default disabled:opacity-40"
              >
                Stop
              </button>
            ) : null}
            {onRestart ? (
              <button
                type="button"
                onClick={onRestart}
                disabled={busy}
                className="rounded-lg border border-[rgba(255,255,255,0.09)] px-3 py-1.5 text-xs text-muted hover:text-default disabled:opacity-40"
              >
                Restart
              </button>
            ) : null}
            <button
              type="button"
              onClick={onForget}
              className="rounded-lg border border-[rgba(255,255,255,0.09)] px-3 py-1.5 text-xs text-muted hover:text-default"
            >
              Unpair this browser
            </button>
            {onDestroy ? (
              <button
                type="button"
                onClick={onDestroy}
                disabled={busy}
                className="rounded-lg border border-red-800 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/20 disabled:opacity-40"
              >
                Destroy
              </button>
            ) : null}
          </div>
        </div>
      </header>
    );
  },
);

AgentIdentityCard.displayName = 'AgentIdentityCard';
