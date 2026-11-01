/**
 * Scheduled tasks, in plain English.
 *
 * The agent service has no scheduling endpoint, and this panel does not pretend
 * it does. A request is sent to the agent as a chat message — the agent writes
 * the cron entry on its own machine — and the list below is the owner's record
 * of what was asked and what came back. It is a request log; it never claims a
 * task is running.
 */

import React, { memo, useState } from 'react';

import type { ScheduleRequest, ScheduleState } from '~/lib/agentSchedules';

export interface AgentSchedulesPanelProps {
  schedules: ScheduleRequest[];
  busy: boolean;
  onRequest: (prompt: string) => void;
  onRemove: (id: string) => void;
}

const stateCopy: Record<ScheduleState, { label: string; tone: string }> = {
  requested: { label: 'sent · waiting', tone: 'text-muted' },
  answered: { label: 'agent answered', tone: 'text-[#d4ff3f]' },
  failed: { label: 'did not send', tone: 'text-red-400' },
};

const formatWhen = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export const AgentSchedulesPanel = memo<AgentSchedulesPanelProps>(
  ({ schedules, busy, onRequest, onRemove }) => {
    const [draft, setDraft] = useState('');

    return (
      <section className="solid-glass-pane rounded-[18px] p-4">
        <h2 className="text-sm font-semibold text-default">Scheduled tasks</h2>
        <p className="mb-4 mt-1 text-xs text-muted">
          Write it the way you would say it. Your agent turns the request into a
          cron entry on its own machine and confirms in chat — this list keeps
          the request, not the schedule.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const prompt = draft.trim();
            if (!prompt || busy) {
              return;
            }
            onRequest(prompt);
            setDraft('');
          }}
          className="mb-4 flex flex-col gap-2 sm:flex-row"
        >
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Every morning at 9, read my mentions and draft replies"
            className="flex-1 rounded-lg border border-[rgba(255,255,255,0.09)] bg-[#1d1e1c] px-3 py-2 text-sm text-default placeholder:text-muted focus:border-[#d4ff3f] focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || draft.trim().length === 0}
            className="rounded-lg border border-[#d4ff3f] px-4 py-2 text-sm font-medium text-[#d4ff3f] hover:bg-[#d4ff3f]/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send to agent
          </button>
        </form>

        {schedules.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            Nothing scheduled yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {schedules.map((schedule) => {
              const copy = stateCopy[schedule.state];
              return (
                <li
                  key={schedule.id}
                  className="rounded-xl border border-[rgba(255,255,255,0.09)] p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-default">{schedule.prompt}</p>
                    <button
                      type="button"
                      onClick={() => onRemove(schedule.id)}
                      className="shrink-0 text-xs text-muted hover:text-default"
                      aria-label={`Remove request: ${schedule.prompt}`}
                    >
                      Remove
                    </button>
                  </div>
                  <p className="mt-1 text-xs">
                    <span className={copy.tone}>{copy.label}</span>
                    <span className="text-muted">
                      {' '}
                      · asked {formatWhen(schedule.createdAt)}
                    </span>
                    {schedule.domain ? (
                      // A request a mini app made through the reader's own
                      // approval (`docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.4):
                      // the row says where it came from, so the log never makes
                      // somebody else's words look like the owner's.
                      <span
                        className="text-muted"
                        data-fiddy="agent-schedule-domain"
                      >
                        {' '}
                        · from {schedule.domain}
                      </span>
                    ) : null}
                  </p>
                  {schedule.reply ? (
                    <p className="mt-2 whitespace-pre-wrap rounded-lg bg-[#1d1e1c] p-2 text-xs text-muted">
                      {schedule.reply}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  },
);

AgentSchedulesPanel.displayName = 'AgentSchedulesPanel';
