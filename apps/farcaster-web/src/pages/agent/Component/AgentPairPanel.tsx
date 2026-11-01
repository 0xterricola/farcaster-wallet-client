/**
 * Pairing: point this browser at the agent service that runs your agent.
 *
 * Two fields and no provider names. The token is the owner's session token for
 * *their* service; it authorises managing their agents and nothing else. We
 * reject instead of repairing — a typo must not silently aim the client at a
 * host the owner did not choose.
 */

import React, { memo, useState } from 'react';

import {
  DEFAULT_AGENT_SERVICE_URL,
  isValidServiceToken,
  normaliseServiceUrl,
} from '~/lib/agentService';

export interface AgentPairPanelProps {
  busy: boolean;
  error: string | null;
  onSubmit: (session: { baseUrl: string; token: string }) => void;
  onCancel: () => void;
}

export const AgentPairPanel = memo<AgentPairPanelProps>(
  ({ busy, error, onSubmit, onCancel }) => {
    const [serviceUrl, setServiceUrl] = useState(DEFAULT_AGENT_SERVICE_URL);
    const [token, setToken] = useState('');

    const baseUrl = normaliseServiceUrl(serviceUrl);
    const tokenOk = isValidServiceToken(token);
    const canSubmit = Boolean(baseUrl) && tokenOk && !busy;
    // Say it while they type, not after a failed submit: the button is disabled
    // until both fields are usable, so a disabled button with no explanation
    // would be a dead end.
    const urlError = serviceUrl.trim().length > 0 && !baseUrl;
    const tokenError = token.length > 0 && !tokenOk;

    return (
      <section className="solid-glass-pane mx-auto w-full max-w-xl rounded-[18px] p-6">
        <h1 className="mb-1 font-[SeasonMix] text-xl font-semibold text-default">
          Pair your own agent service
        </h1>
        <p className="mb-5 text-sm text-muted">
          For self-hosters: paste the address of the service that runs your
          agent and a session token for it. Both stay in this browser; the agent
          keeps its own keys.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit && baseUrl) {
              onSubmit({ baseUrl, token: token.trim() });
            }
          }}
          className="space-y-4"
        >
          <label className="block">
            <span className="mb-1 block text-sm text-muted">
              Agent service address
            </span>
            <input
              type="url"
              value={serviceUrl}
              onChange={(event) => setServiceUrl(event.target.value)}
              spellCheck={false}
              autoCapitalize="none"
              className="w-full rounded-lg border border-[rgba(255,255,255,0.09)] bg-[#1d1e1c] px-3 py-2 text-sm text-default placeholder:text-muted focus:border-[#d4ff3f] focus:outline-none"
              placeholder="https://agents.example.com"
            />
            {urlError ? (
              <span role="alert" className="mt-1 block text-xs text-red-400">
                Use a bare https address: no path, no port, no credentials.
              </span>
            ) : null}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-muted">Session token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="font-mono w-full rounded-lg border border-[rgba(255,255,255,0.09)] bg-[#1d1e1c] px-3 py-2 text-sm text-default placeholder:text-muted focus:border-[#d4ff3f] focus:outline-none"
              placeholder="token for your agent service"
            />
            {tokenError ? (
              <span role="alert" className="mt-1 block text-xs text-red-400">
                A token is a single line, at least 8 characters.
              </span>
            ) : null}
          </label>

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm text-red-300"
            >
              {error}
            </p>
          ) : null}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 rounded-lg border border-[rgba(255,255,255,0.09)] py-2 text-sm text-muted hover:text-default"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex-1 rounded-lg bg-[#d4ff3f] px-4 py-2 text-sm font-semibold text-[#1a1c10] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      </section>
    );
  },
);

AgentPairPanel.displayName = 'AgentPairPanel';
