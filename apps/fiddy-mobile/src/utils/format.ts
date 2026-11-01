/** Small time helpers — no date library needed for a feed. */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3m", "5h", "2d" — the shortest honest rendering of a timestamp. */
export const timeAgo = (timestampMs: number, now: number = Date.now()): string => {
  const delta = Math.max(0, now - timestampMs);
  if (delta < MINUTE) {
    return 'now';
  }
  if (delta < HOUR) {
    return `${Math.floor(delta / MINUTE)}m`;
  }
  if (delta < DAY) {
    return `${Math.floor(delta / HOUR)}h`;
  }
  if (delta < 7 * DAY) {
    return `${Math.floor(delta / DAY)}d`;
  }
  return new Date(timestampMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
};

/** Compact counts: 1234 → "1.2K" (never wider than 4 characters). */
export const compactNumber = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '—';
  }
  if (value < 1000) {
    return String(value);
  }
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  }
  if (value < 1_000_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  return `${(value / 1_000_000_000).toFixed(1)}B`;
};