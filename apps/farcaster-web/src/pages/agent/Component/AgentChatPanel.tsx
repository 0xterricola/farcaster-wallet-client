/**
 * Chat with your agent.
 *
 * One message in, one reply out, through the agent service — the same route the
 * owner's agent uses for every other channel, so what is answered here is
 * answered by the real instance, not a canned demo. The panel is presentational:
 * the page owns the transcript so a refresh does not invent history.
 */

import React, { memo, useRef, useState } from 'react';

export interface AgentChatMessage {
  id: string;
  role: 'owner' | 'agent' | 'error';
  text: string;
  at: number;
}

export interface AgentChatPanelProps {
  messages: AgentChatMessage[];
  busy: boolean;
  onSend: (text: string) => void;
  /**
   * Set when this agent cannot be written to yet (its session is still being
   * asked for, or starting one is closed on the service). The sentence takes the
   * place of the input instead of leaving a field that would swallow a message
   * and answer with nothing.
   */
  awaiting?: { note: string } | null;
}

export const AgentChatPanel = memo<AgentChatPanelProps>(
  ({ messages, busy, onSend, awaiting = null }) => {
    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const submit = () => {
      const text = draft.trim();
      if (!text || busy) {
        return;
      }
      onSend(text);
      setDraft('');
      inputRef.current?.focus();
    };

    return (
      <section className="solid-glass-pane flex min-h-[320px] flex-col rounded-[18px]">
        <div
          className="flex-1 space-y-3 overflow-y-auto p-4"
          aria-live="polite"
          aria-label="Conversation with your agent"
        >
          {messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">
              Ask your agent for something concrete: “read my mentions and draft
              three replies”, “what did I post last week?”.
            </p>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${
                  message.role === 'owner' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                    message.role === 'owner'
                      ? 'bg-[#d4ff3f] text-[#1a1c10]'
                      : message.role === 'error'
                        ? 'border border-red-800 bg-red-900/20 text-red-300'
                        : 'border border-[rgba(255,255,255,0.09)] bg-[#1d1e1c] text-default'
                  }`}
                >
                  {message.text}
                </div>
              </div>
            ))
          )}
          {busy ? (
            <p className="text-sm text-muted" role="status">
              Your agent is working…
            </p>
          ) : null}
        </div>

        {awaiting ? (
          <p
            role="status"
            className="border-t border-[rgba(255,255,255,0.09)] p-3 text-sm text-muted"
          >
            {awaiting.note}
          </p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="flex items-end gap-2 border-t border-[rgba(255,255,255,0.09)] p-3"
          >
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder="Message your agent…"
              className="min-h-[44px] flex-1 resize-y rounded-lg border border-[rgba(255,255,255,0.09)] bg-[#1d1e1c] px-3 py-2 text-sm text-default placeholder:text-muted focus:border-[#d4ff3f] focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || draft.trim().length === 0}
              className="rounded-lg bg-[#d4ff3f] px-4 py-2 text-sm font-semibold text-[#1a1c10] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </form>
        )}
      </section>
    );
  },
);

AgentChatPanel.displayName = 'AgentChatPanel';
