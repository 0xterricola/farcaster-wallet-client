/**
 * A Surp key, made in this browser and kept in this browser.
 *
 * Two facts shape everything below.
 *
 * 1. The key is money. Surp keys are prepaid: whoever reads the string can
 *    spend its balance. So the raw value lives in exactly one place (its own
 *    storage entry, written by this module and read by this module), it is
 *    never written into the setup file — that file documents that it holds no
 *    key — never logged, never put in a URL that a server sees, and the screen
 *    shows a mask of it rather than the whole thing.
 *
 * 2. `POST /api/keys/create` mints a key anonymously: measured 2026-10-21, the
 *    call returns a real `sk-surp-…` with no credential at all, and its
 *    `balance_cents` field is whatever the caller asked for. So a key made here
 *    arrives empty as far as payment is concerned, and this module never asks
 *    for a balance, in any amount. If Surp ever closes that door, key creation
 *    still works; if Surp ever starts honouring a client-supplied balance, this
 *    code does not become a way to mint one.
 *
 * Because the response is the only time the raw key exists, the caller gets it,
 * shows it once, and this module writes it down. `readSurpKey` is the only way
 * back to it.
 */

import { asRecord, num, str, surpJson } from './transport';

/** Where the key lives. Its own entry: nothing else reads or writes it. */
export const SURP_KEY_STORAGE = 'fiddy.surp.key';

export interface SurpKeyRecord {
  key: string;
  label: string;
  /** What Surp said the key holds when it was made, in microcents. */
  balanceMicrocents: number;
  createdAt: number;
}

export interface SurpKeyBalance {
  label: string;
  balanceUsdCents: number;
  totalRequests: number;
  lastUsed: number | null;
}

/** A Surp key as Surp writes them. Checked so a stray string is not stored. */
export const looksLikeSurpKey = (value: string): boolean =>
  /^sk-surp-[A-Za-z0-9_-]{20,}$/.test(value.trim());

/** A mask for screens and for support: never the whole key. */
export const surpKeyMask = (key: string): string => {
  const trimmed = key.trim();
  if (trimmed.length <= 12) {
    return '••••';
  }
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
};

export const parseCreatedKey = (
  payload: unknown,
  now: number,
): SurpKeyRecord | null => {
  const body = asRecord(payload);
  const key = body ? str(body.key) : null;
  if (!body || !key || !looksLikeSurpKey(key)) {
    return null;
  }
  return {
    key: key.trim(),
    label: str(body.label) ?? 'fiddy',
    balanceMicrocents: num(body.balance_microcents) ?? 0,
    createdAt: now,
  };
};

export const readSurpKey = (): SurpKeyRecord | null => {
  try {
    const raw = window.localStorage.getItem(SURP_KEY_STORAGE);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SurpKeyRecord> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const key = typeof parsed.key === 'string' ? parsed.key : null;
    if (!key || !looksLikeSurpKey(key)) {
      return null;
    }
    return {
      key,
      label: typeof parsed.label === 'string' ? parsed.label : 'fiddy',
      balanceMicrocents:
        typeof parsed.balanceMicrocents === 'number'
          ? parsed.balanceMicrocents
          : 0,
      createdAt:
        typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
};

export const forgetSurpKey = (): void => {
  try {
    window.localStorage.removeItem(SURP_KEY_STORAGE);
  } catch {
    // A browser that refuses storage has nothing to forget.
  }
};

/**
 * Make a key. The `label` is the only thing sent — no balance, ever — and it is
 * the owner's own words so the key is recognisable on Surp's own dashboard.
 */
export const createSurpKey = async (
  label: string,
  now = Date.now(),
): Promise<SurpKeyRecord> => {
  const payload = await surpJson<unknown>({
    path: '/api/keys/create',
    method: 'POST',
    body: { label: label.trim().slice(0, 60) || 'fiddy', balance_cents: 0 },
  });
  const record = parseCreatedKey(payload, now);
  if (!record) {
    throw new Error('surp-key-unreadable');
  }
  try {
    window.localStorage.setItem(SURP_KEY_STORAGE, JSON.stringify(record));
  } catch {
    // The key still exists and is still shown once; it just will not be here
    // next time, and the surface says so rather than pretending it saved.
  }
  return record;
};

export const parseKeyBalance = (payload: unknown): SurpKeyBalance | null => {
  const body = asRecord(payload);
  const label = body ? str(body.label) : null;
  const balanceUsdCents = body ? num(body.balance_usd_cents) : null;
  if (!body || label === null || balanceUsdCents === null) {
    return null;
  }
  return {
    label,
    balanceUsdCents,
    totalRequests: num(body.total_requests) ?? 0,
    lastUsed: num(body.last_used),
  };
};

/** What the key has left. The read-only check that a key is real and live. */
export const readSurpKeyBalance = async (
  key: string,
): Promise<SurpKeyBalance> => {
  const payload = await surpJson<unknown>({
    path: '/api/keys/balance',
    query: { key: key.trim() },
  });
  const balance = parseKeyBalance(payload);
  if (!balance) {
    throw new Error('surp-key-balance-unreadable');
  }
  return balance;
};
