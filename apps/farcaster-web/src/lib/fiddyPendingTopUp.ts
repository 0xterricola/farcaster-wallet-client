/**
 * A top-up that was sent but is not in the balance yet — remembered, on this
 * device, until it lands.
 *
 * WHY THIS EXISTS. The send and the credit are two different events. A wallet
 * can broadcast a USDC transfer on Base and then the browser can die, the
 * person can close the tab, or the credit request can be refused for a while —
 * and the money has still left their wallet. If the only copy of that hash is
 * in a React state, the next page load has no way to ask Fiddy about it, and the
 * honest answer becomes "we cannot tell you". So the hash is kept here, in this
 * browser, and every funding surface offers "check that transfer again" until
 * the balance shows it.
 *
 * WHAT IS NOT KEPT. No secret, no session, no address, no amount the server did
 * not already know: a hash is public on Base, and `usdc` is only what the screen
 * said it was sending, for the sentence "your $5 is on its way". A value that is
 * not exactly the shape below reads as "nothing pending" rather than as a
 * half-formed record.
 */

import { deleteItem, getItem, setItem } from '~/utils/storageUtils';

export const PENDING_TOP_UP_KEY = 'fiddy.credit.pending';

export interface PendingTopUp {
  txHash: string;
  /** The dollar amount the screen said was being sent, e.g. `"5.00"`. */
  usdc: string;
  /** `Date.now()` at the send, so the screen can say "a moment ago". */
  at: number;
  source: 'farcaster' | 'wallet';
}

const isTxHash = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

const read = (value: unknown): PendingTopUp | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (!isTxHash(raw.txHash)) {
    return null;
  }
  return {
    txHash: raw.txHash,
    usdc: typeof raw.usdc === 'string' && raw.usdc.trim() ? raw.usdc : '—',
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
    source: raw.source === 'farcaster' ? 'farcaster' : 'wallet',
  };
};

export const readPendingTopUp = async (): Promise<PendingTopUp | null> => {
  try {
    return read(
      await getItem<unknown>({ key: PENDING_TOP_UP_KEY, fallback: null }),
    );
  } catch {
    return null;
  }
};

export const rememberPendingTopUp = async (input: {
  txHash: string;
  usdc: string;
  source: PendingTopUp['source'];
}): Promise<PendingTopUp | null> => {
  const record = read({ ...input, at: Date.now() });
  if (record === null) {
    return null;
  }
  try {
    await setItem({ key: PENDING_TOP_UP_KEY, value: record });
    return record;
  } catch {
    return null;
  }
};

export const forgetPendingTopUp = async (): Promise<void> => {
  try {
    await deleteItem(PENDING_TOP_UP_KEY);
  } catch {
    // Storage that refuses to forget is not a reason to fail a screen: the
    // worst it costs is one extra "check again" press.
  }
};
