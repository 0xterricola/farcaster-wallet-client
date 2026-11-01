/**
 * Scheduled tasks, as the client can honestly hold them.
 *
 * The agent service exposes chat, lifecycle and channels but no scheduling
 * endpoint yet, and this client will not pretend otherwise. A schedule is
 * therefore two things: a plain-English request the owner sends to their agent
 * through chat (the agent writes its own cron entry on its side), and a local
 * record of that request so the UI can show what was asked for, when, and how
 * the agent answered.
 *
 * The record is a request log, not a scheduler. It says "asked", never "running".
 *
 * A request is not always the owner's own words: a mini app may ask this
 * reader's agent to be reminded (`docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.4),
 * behind the reader's own approval. That request lands in this same log, with
 * the app's text and its domain on the row, so where a request came from is
 * never guessed from its wording.
 */

import { deleteItem, getItem, setItem } from '~/utils/storageUtils';

const NAMESPACE = 'fiddy.agent.schedules';

export type ScheduleState = 'requested' | 'answered' | 'failed';

export interface ScheduleRequest {
  id: string;
  agentId: string;
  /** What the owner asked for, in their own words — or an app's, verbatim. */
  prompt: string;
  state: ScheduleState;
  createdAt: number;
  /** The agent's reply, trimmed — the only evidence the schedule was written. */
  reply?: string;
  /**
   * The app's domain, when a mini app asked for this rather than the owner
   * typing it (`docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.4). Absent for the
   * owner's own requests, and shown wherever the row is shown: a request that
   * came from somebody else's page says so in the reader's own log.
   */
  domain?: string;
}

const keyFor = (agentId: string): string => `${NAMESPACE}.${agentId}`;

const isSchedule = (value: unknown): value is ScheduleRequest => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<ScheduleRequest>;
  return (
    typeof item.id === 'string' &&
    typeof item.agentId === 'string' &&
    typeof item.prompt === 'string' &&
    typeof item.createdAt === 'number' &&
    (item.domain === undefined || typeof item.domain === 'string') &&
    (item.state === 'requested' ||
      item.state === 'answered' ||
      item.state === 'failed')
  );
};

export const loadSchedules = async (
  agentId: string,
): Promise<ScheduleRequest[]> => {
  const stored = await getItem<unknown>({
    key: keyFor(agentId),
    fallback: [],
  });
  return Array.isArray(stored) ? stored.filter(isSchedule) : [];
};

export const saveSchedules = async (
  agentId: string,
  schedules: ScheduleRequest[],
): Promise<void> => {
  await setItem({ key: keyFor(agentId), value: schedules });
};

export const clearSchedules = (agentId: string): Promise<void> =>
  deleteItem(keyFor(agentId));

/** A stable-enough id without pulling in a dependency for three fields. */
export const newScheduleId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const upsertSchedule = (
  schedules: ScheduleRequest[],
  next: ScheduleRequest,
): ScheduleRequest[] => {
  const index = schedules.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [next, ...schedules];
  }
  const copy = schedules.slice();
  copy[index] = next;
  return copy;
};

/**
 * Keep one request in the reader's own log, in one step: the row goes in while
 * the request is being sent, and the same row is replaced by its outcome when
 * the agent answers or the send fails. Read, merge and write happen together so
 * a caller that only has the request in hand needs one call per state change —
 * `agentAskHandlers` (S3's `remind`) is that caller.
 *
 * Keyed by the `agentId` it is handed — the agent the request was sent to, so
 * a row can never be written under another agent's key and go unread.
 */
export const keepSchedule = async (
  agentId: string,
  request: ScheduleRequest,
): Promise<void> => {
  const current = await loadSchedules(agentId);
  await saveSchedules(agentId, upsertSchedule(current, request));
};
