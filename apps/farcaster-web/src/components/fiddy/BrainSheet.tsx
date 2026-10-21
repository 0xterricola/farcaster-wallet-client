/**
 * "Add a brain" — the surface the positioning pivot turns on.
 *
 * Four friendly cards, in plain words:
 *   Fiddy        built in, nothing to plug in
 *   Claude       your own subscription, not wired yet — tagged, not implied
 *   Gemini       the same
 *   Surp         pay as you go, wired: the live price, a key made in this
 *                browser, and the panel that says what a month would cost
 *                (see SurpBrainPanel — the numbers come from surp.ivc.lol)
 *   Another AI   one address + one key, and this one really connects today
 *                (it pairs with an agent service you run, through the same
 *                module and the same validation the agent surface uses)
 *
 * Under it, closed by default, the builders' row: a tool-server address that
 * Fiddy saves and does not use yet. It says so, because a field that looks live
 * and is not would be the exact dishonesty this card exists to remove.
 *
 * Strings here are the product's, not the protocol's: no provider names beyond
 * the ones the owner sees on their own bill, no API-key jargon, no scopes.
 */

import React, { memo, useState } from 'react';

import { useAgentSession } from '~/hooks/agent/useAgentSession';
import {
  AgentServiceError,
  isValidServiceToken,
  listAgents,
  normaliseServiceUrl,
} from '~/lib/agentService';
import {
  type BrainId,
  type FiddySetup,
  saveFiddySetup,
  useFiddySetup,
} from '~/lib/fiddySetup';

import { SurpBrainPanel } from './SurpBrainPanel';

interface BrainCard {
  id: BrainId;
  title: string;
  tag: string;
  tagKind: 'live' | 'soon' | 'yours';
  line: string;
}

export const BRAIN_CARDS: BrainCard[] = [
  {
    id: 'fiddy',
    title: 'Fiddy',
    tag: 'built in',
    tagKind: 'live',
    line: "Fiddy's own brain, ready out of the box. It keeps working when this tab is closed.",
  },
  {
    id: 'claude',
    title: 'Claude',
    tag: 'soon',
    tagKind: 'soon',
    line: 'Use the Claude plan you already pay for. Fiddy will drive it for you.',
  },
  {
    id: 'gemini',
    title: 'Gemini',
    tag: 'soon',
    tagKind: 'soon',
    line: 'Use the Gemini account you already have. Fiddy will drive it for you.',
  },
  {
    id: 'surp',
    title: 'Surp',
    tag: 'pay as you go',
    tagKind: 'live',
    line: 'Pay only for the requests you actually make. Fiddy shows you the live price before you spend anything.',
  },
  {
    id: 'other',
    title: 'Another AI service',
    tag: 'you bring it',
    tagKind: 'yours',
    line: 'Point Fiddy at a service you run: one address, one key. The key stays in this browser.',
  },
];

/** One plain sentence for whichever brain is selected, for summary lines. */
export const brainSummary = (setup: FiddySetup): string => {
  switch (setup.brain) {
    case 'claude':
      return 'Claude — we will tell you when it is ready';
    case 'gemini':
      return 'Gemini — we will tell you when it is ready';
    case 'other':
      return setup.brainServiceUrl
        ? `Your own service (${setup.brainServiceUrl.replace('https://', '')})`
        : 'Your own service — not connected yet';
    case 'surp':
      return 'Surp — pay as you go';
    case 'fiddy':
    default:
      return 'Fiddy, built in';
  }
};

const connectErrorText = (error: unknown): string => {
  if (error instanceof AgentServiceError) {
    if (
      error.code === 'AUTH_REQUIRED' ||
      error.code === 'INVALID_AUTH_TOKEN' ||
      error.status === 401 ||
      error.status === 403
    ) {
      return 'That key was not accepted for that address. Check both and try again.';
    }
    if (error.status === 404 || error.code === 'NOT_DEPLOYED') {
      return 'Something answered at that address, but it is not a Fiddy agent service.';
    }
    return 'That service answered with an error. Try again in a moment.';
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'That address took too long to answer. Try again, or check that it is running.';
  }
  return 'That address did not answer. Check it and try again.';
};

export const BrainSheet = memo(() => {
  const setup = useFiddySetup();
  const { status, session, pair, forget } = useAgentSession();

  const [otherOpen, setOtherOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [toolServer, setToolServer] = useState(setup.toolServerUrl ?? '');
  const [toolServerSaved, setToolServerSaved] = useState(false);

  const pairedAt = status === 'paired' ? (session?.baseUrl ?? null) : null;

  const choose = (id: BrainId) => {
    saveFiddySetup({ brain: id });
    if (id === 'other') {
      setOtherOpen(true);
      setError(null);
      return;
    }
    setOtherOpen(false);
  };

  const connect = async () => {
    setError(null);
    setConnected(null);
    const baseUrl = normaliseServiceUrl(address);
    if (!baseUrl) {
      setError(
        'That address is not usable. It has to be a plain https address, like https://agents.example.com.',
      );
      return;
    }
    if (!isValidServiceToken(key)) {
      setError(
        'That key does not look like a key. Copy it exactly as it was given to you.',
      );
      return;
    }
    setBusy(true);
    try {
      // Prove the key before storing it, exactly as the agent surface does: a
      // key that cannot list your agents must not look connected.
      const agents = await listAgents({ baseUrl, token: key.trim() });
      await pair({ baseUrl, token: key.trim() });
      saveFiddySetup({ brain: 'other', brainServiceUrl: baseUrl });
      setConnected(
        agents.length === 1
          ? `Connected to ${baseUrl.replace('https://', '')} — 1 agent there.`
          : `Connected to ${baseUrl.replace('https://', '')} — ${agents.length} agents there.`,
      );
      setKey('');
    } catch (caught) {
      setError(connectErrorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await forget();
    saveFiddySetup({ brainServiceUrl: null });
    setConnected(null);
    setOtherOpen(false);
  };

  return (
    <div className="fiddy-brains" data-fiddy="brains">
      <ul className="fiddy-card-list">
        {BRAIN_CARDS.map((brain) => {
          const selected = setup.brain === brain.id;
          return (
            <li key={brain.id}>
              <button
                type="button"
                className={`fiddy-brain-card${
                  selected ? ' fiddy-brain-card-selected' : ''
                }`}
                aria-pressed={selected}
                data-fiddy-brain={brain.id}
                data-state={selected ? 'selected' : 'idle'}
                onClick={() => choose(brain.id)}
              >
                <span className="fiddy-card-head">
                  <span className="fiddy-card-title">{brain.title}</span>
                  <span
                    className={`fiddy-tag fiddy-tag-${brain.tagKind}`}
                    data-fiddy-tag={brain.tagKind}
                  >
                    {brain.tag}
                  </span>
                </span>
                <span className="fiddy-card-line">{brain.line}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {otherOpen ? (
        <div className="fiddy-connect" data-fiddy="brain-connect">
          {pairedAt && setup.brain === 'other' ? (
            <div className="fiddy-connected" role="status" aria-live="polite">
              <span className="fiddy-connected-dot" aria-hidden="true" />
              <span>
                Connected to {pairedAt.replace('https://', '')}.
                {connected ? ` ${connected}` : ''}
              </span>
              <button
                type="button"
                className="fiddy-quiet-btn fiddy-quiet-btn-inline"
                onClick={() => void disconnect()}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <>
              <label className="fiddy-field">
                <span className="fiddy-field-label">Its address</span>
                <input
                  className="fiddy-input"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://agents.example.com"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
              </label>
              <label className="fiddy-field">
                <span className="fiddy-field-label">Its key</span>
                <input
                  className="fiddy-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="the key it gave you"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="fiddy-secondary-btn"
                onClick={() => void connect()}
                disabled={busy}
              >
                {busy ? 'Asking it for your agents…' : 'Connect'}
              </button>
              <p className="fiddy-honest-note">
                <span>
                  The key stays in this browser and only unlocks your own agents
                  on that service. It is not an AI provider's key — Fiddy never
                  holds one of those.
                </span>
              </p>
            </>
          )}

          {error ? (
            <p role="alert" className="fiddy-alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {setup.brain === 'surp' && !otherOpen ? <SurpBrainPanel /> : null}

      <div className="fiddy-advanced">
        <button
          type="button"
          className="fiddy-advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          Advanced — for builders
          <span aria-hidden="true">{advancedOpen ? '−' : '+'}</span>
        </button>

        {advancedOpen ? (
          <div className="fiddy-advanced-body" data-fiddy="brain-advanced">
            <label className="fiddy-field">
              <span className="fiddy-field-label">
                Connect a tool server (for builders)
              </span>
              <input
                className="fiddy-input"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://tools.example.com"
                value={toolServer}
                onChange={(event) => {
                  setToolServer(event.target.value);
                  setToolServerSaved(false);
                }}
              />
            </label>
            <button
              type="button"
              className="fiddy-quiet-btn fiddy-quiet-btn-outline"
              onClick={() => {
                saveFiddySetup({ toolServerUrl: toolServer.trim() || null });
                setToolServerSaved(true);
              }}
            >
              Save this address
            </button>
            <p className="fiddy-honest-note">
              <span>
                Not wired yet. Fiddy saves the address on this device and will
                use it when tool servers land.
              </span>
            </p>
            {toolServerSaved ? (
              <p role="status" aria-live="polite" className="fiddy-honest-note">
                <span>Saved on this device.</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

BrainSheet.displayName = 'BrainSheet';
