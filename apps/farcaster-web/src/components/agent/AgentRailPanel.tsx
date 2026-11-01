/**
 * The Fiddy Agent panel — the client's second differentiator, in the right-hand
 * column instead of buried behind a route.
 *
 * Two states only, and both are decided by what this browser actually holds:
 *   not hatched / pairing — no agent paired in this browser
 *   paired               — a session exists at a service; the panel shows where
 *                          and hands off to the agent surface for anything that
 *                          needs a network call
 *
 * Nothing here claims an agent is awake, and nothing here pretends a feature is
 * live: the design's own honesty tags ("soon") are carried over verbatim.
 */

import { Clock, IdCard, Plug } from 'lucide-react';
import React, { memo } from 'react';

import { Link } from '~/components/links/Link';
import { useAgentSession } from '~/hooks/agent/useAgentSession';

const EggMark = () => (
  <svg
    width="52"
    height="52"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3.5c3.2 3.5 5.5 6.9 5.5 9.7a5.5 5.5 0 1 1-11 0c0-2.8 2.3-6.2 5.5-9.7z" />
    <path d="m9.2 12.4 1.5 1.3 1.2-1.7 1.4 1.5" />
  </svg>
);

export const AgentRailPanel: React.FC = memo(() => {
  const { status, session } = useAgentSession();

  const isPaired = status === 'paired';
  const statusLabel =
    status === 'loading' ? 'checking…' : isPaired ? 'paired' : 'not hatched';

  return (
    <section
      className="fiddy-agent-card"
      data-fiddy="agent-rail"
      aria-label="Fiddy Agent"
    >
      <div className="fiddy-agent-head">
        <h2>Fiddy Agent</h2>
        <span
          className={
            isPaired ? 'fiddy-pill-dim fiddy-pill-live' : 'fiddy-pill-dim'
          }
        >
          {statusLabel}
        </span>
      </div>

      {isPaired ? (
        <div className="fiddy-hatch-card">
          <div className="fiddy-egg-wrap" style={{ width: 88, height: 88 }}>
            <EggMark />
          </div>
          <h3 style={{ fontSize: 20 }}>Your agent is paired</h3>
          <p className="fiddy-hatch-sub">
            Paired at {session?.baseUrl ?? 'your service'}. Open the agent
            surface to chat, schedule a routine, or disconnect.
          </p>
          <Link
            to="agent"
            params={{}}
            searchParams={{}}
            title="Open the Fiddy agent"
            className="fiddy-hatch-btn"
          >
            Open agent
          </Link>
        </div>
      ) : (
        <div className="fiddy-hatch-card">
          <div className="fiddy-egg-wrap" style={{ width: 88, height: 88 }}>
            <EggMark />
          </div>
          <h3 style={{ fontSize: 20 }}>Hatch your Fiddy</h3>
          <p className="fiddy-hatch-sub">
            An always-on agent with its own Farcaster identity. It reads your
            feed, drafts replies in your voice, and never posts without you.
          </p>
          <Link
            to="agent"
            params={{}}
            searchParams={{}}
            title="Hatch a Fiddy agent"
            className="fiddy-hatch-btn"
          >
            Hatch an agent
          </Link>
          <div className="fiddy-agent-id">
            <IdCard size={16} aria-hidden="true" />
            <span>
              Gets its own account and profile — not a shared bot, not your
              account with a prompt stapled on.
            </span>
          </div>
        </div>
      )}

      <ul className="fiddy-feats">
        <li className="fiddy-feat">
          <Clock aria-hidden="true" />
          <div>
            <b>
              Scheduled tasks <span className="fiddy-soon">soon</span>
            </b>
            <p>
              “Check mentions every morning” — routines your agent runs and
              reports back on.
            </p>
          </div>
        </li>
        <li className="fiddy-feat">
          <Plug aria-hidden="true" />
          <div>
            <b>Channel connections</b>
            <p>
              Per-channel approval, so your agent reads a channel long before it
              may ever speak in it.
            </p>
          </div>
        </li>
      </ul>
    </section>
  );
});

AgentRailPanel.displayName = 'AgentRailPanel';
