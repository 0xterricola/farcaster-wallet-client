/**
 * One file per reader, holding ONLY what a push needs. Nothing else.
 *
 *   ~/state/fid-<fid>.json
 *
 * WHAT IS IN IT: the phone's push address, the two keys the browser generated
 * for it, which kinds of happenings this reader wants, the language, the FIDs
 * they have muted, and a short window of ids already sent.
 *
 * WHAT IS NOT IN IT: a key, a phrase, a cast, a name, an IP, a session. The
 * browser signs its subscribe request with the app key it already holds
 * (`src/snapchain/appKeyStorage.ts`); the server checks that signature against
 * the node and then forgets it. There is no path by which this file lets anyone
 * post as the reader, which is the whole reason the design is shaped this way.
 *
 * MISSING IS NOT AN ERROR. A reader who never turned alerts on has no file, and
 * `read()` answers `undefined` — the same way a reader who turned them off is
 * just gone. Nothing in the loop treats an absent file as a fault.
 *
 * THE WRITE IS ATOMIC. tmp-then-`rename` in the same directory, mode 600,
 * because a half-written JSON file would read as "no subscription" and silently
 * switch the feature off for that reader. `rename(2)` within one filesystem is
 * atomic, so the file is either the old subscription or the new one.
 */

import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The shape this store writes, and the only shape it will read back. */
export const SUBSCRIPTION_VERSION = 1;

/** Ids kept in the dedupe window per reader. */
export const SENT_MAX = 400;

/** How long an id stays in the window. A like never un-happens. */
export const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The kinds a push may be about. Nothing else is derivable (see `derive.mjs`). */
export const ALERT_KINDS = ['mentions', 'replies', 'likes', 'follows'];

const isPushUrl = (value) => {
  try {
    const url = new URL(String(value));
    // Web Push endpoints are HTTPS. A `http://` one is a device that answered a
    // tampered capability, not a phone we can reach.
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
};

const isB64Url = (value, min, max) => {
  if (typeof value !== 'string') {
    return false;
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    return false;
  }
  const bytes = Math.floor((value.replace(/=+$/, '').length * 3) / 4);
  return bytes >= min && bytes <= max;
};

const cleanKinds = (raw) => {
  const given = raw && typeof raw === 'object' ? raw : {};
  const kinds = /** @type {Record<string, boolean>} */ ({});
  for (const kind of ALERT_KINDS) {
    // Default ON for every kind: a person who pressed "Tell my phone" wants to
    // be told. An explicit `false` is the only way to leave one out.
    kinds[kind] = given[kind] !== false;
  }
  return kinds;
};

const cleanFids = (raw) => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set();
  for (const value of raw) {
    const fid = Number(value);
    if (Number.isSafeInteger(fid) && fid > 0) {
      seen.add(fid);
    }
  }
  return [...seen].slice(0, 5000);
};

/**
 * @typedef {object} Subscription
 * @property {number} version
 * @property {number} fid
 * @property {string} endpoint        the phone's push address
 * @property {{p256dh: string, auth: string}} keys   the phone's two keys
 * @property {Record<string, boolean>} kinds
 * @property {string} language
 * @property {number[]} mutedFids
 * @property {Array<{id: string, at: number}>} sent   the dedupe window
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * What a stored file may contain, narrowed to exactly that.
 *
 * A field this function does not name is DROPPED, not carried: the file is
 * machine state written by this service, and a shape that grows a field nobody
 * reads is a shape that will one day be read by mistake.
 *
 * @returns {Subscription | undefined}
 */
export const cleanSubscription = (raw, { fid, now = Date.now() }) => {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const endpoint = raw.endpoint;
  if (!isPushUrl(endpoint)) {
    return undefined;
  }
  const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  // 65 bytes of P-256 point, and a 16-byte auth secret: the two numbers Web
  // Push is specified around. Anything else cannot be encrypted for.
  if (!isB64Url(keys.p256dh, 60, 70) || !isB64Url(keys.auth, 15, 17)) {
    return undefined;
  }
  const sent = Array.isArray(raw.sent)
    ? raw.sent
        .filter(
          (entry) =>
            entry &&
            typeof entry.id === 'string' &&
            entry.id.length <= 200 &&
            Number.isFinite(entry.at) &&
            now - entry.at < SENT_TTL_MS,
        )
        .slice(-SENT_MAX)
    : [];
  return {
    version: SUBSCRIPTION_VERSION,
    fid,
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    kinds: cleanKinds(raw.kinds),
    language: typeof raw.language === 'string' && raw.language.length <= 8 ? raw.language : 'en',
    mutedFids: cleanFids(raw.mutedFids),
    sent,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: now,
  };
};

/**
 * A directory of subscriptions, keyed by FID.
 *
 * `dir` is a StateDirectory (the `FIDDY_ALERTS_DIR` the host was configured
 * with). If it does not exist it is created on first write and only then — a
 * host that never enables alerts never grows the directory.
 */
export const createAlertStore = ({ dir, now = () => Date.now() }) => {
  if (!dir) {
    throw new Error('createAlertStore needs a directory');
  }
  const pathFor = (fid) => join(dir, `fid-${fid}.json`);

  const read = async (fid) => {
    if (!Number.isSafeInteger(fid) || fid <= 0) {
      return undefined;
    }
    let text;
    try {
      text = await readFile(pathFor(fid), 'utf8');
    } catch (error) {
      // ENOENT is the ordinary answer for every reader who never subscribed.
      if (error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A corrupt file is treated as no subscription rather than as a crash:
      // the reader can subscribe again, and the loop keeps serving everyone
      // else. The next write replaces it.
      return undefined;
    }
    const clean = cleanSubscription({ ...parsed, createdAt: parsed?.createdAt }, { fid, now: now() });
    return clean;
  };

  const write = async (fid, subscription) => {
    const clean = cleanSubscription(subscription, { fid, now: now() });
    if (!clean) {
      throw new Error('not a subscription this host can store');
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = pathFor(fid);
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, target);
    return clean;
  };

  const remove = async (fid) => {
    try {
      await unlink(pathFor(fid));
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  };

  /** Every subscriber. The loop walks this; a missing directory is an empty list. */
  const list = async () => {
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const found = [];
    for (const name of names) {
      const match = /^fid-(\d+)\.json$/.exec(name);
      if (!match) {
        continue;
      }
      const fid = Number(match[1]);
      try {
        const subscription = await read(fid);
        if (subscription) {
          found.push({ fid, subscription });
        }
      } catch {
        // One unreadable file does not stop the others from being served.
      }
    }
    return found;
  };

  /**
   * Add ids to the dedupe window and trim it.
   *
   * Called with what was SENT and what was FOLDED into a grouped line, because
   * a like that went out inside "Maya and 4 others" must not come back alone on
   * the next tick.
   */
  const recordSent = async (fid, ids, at = now()) => {
    const current = await read(fid);
    if (!current || ids.length === 0) {
      return current;
    }
    const known = new Set(current.sent.map((entry) => entry.id));
    const added = [];
    for (const id of ids) {
      // `known` is updated as we go: the same id twice in one call is one entry.
      if (typeof id !== 'string' || known.has(id)) {
        continue;
      }
      known.add(id);
      added.push({ id, at });
    }
    const sent = [...current.sent, ...added]
      .filter((entry) => at - entry.at < SENT_TTL_MS)
      .slice(-SENT_MAX);
    return write(fid, { ...current, sent, updatedAt: at });
  };

  return { read, write, remove, list, recordSent, pathFor };
};