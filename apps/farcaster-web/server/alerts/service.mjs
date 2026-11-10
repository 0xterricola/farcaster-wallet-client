/**
 * The loop: once a minute, for each subscribed reader, derive → group → send.
 *
 * Four rules shape it, and each one exists because of a way this feature goes
 * wrong in the world:
 *
 *   1. **once a minute per reader.** Not a timer per reader (a thousand timers
 *      is a thousand surprises) and not a busy loop; one pass over the store's
 *      files, skipping anybody asked within the last minute.
 *   2. **a new subscriber is not buzzed about the past.** Everything older than
 *      the moment they turned alerts on is dropped without being recorded — the
 *      reader pressed a button, they did not ask to hear about last Tuesday.
 *   3. **a push service that says GONE deletes the subscription.** 404/410 is
 *      the phone telling us it is gone; keeping the file would mean a reader who
 *      never gets anything and a loop that keeps trying.
 *   4. **nothing here can reach a real phone in a test.** `fetchImpl` is
 *      injected, and the probe passes a stub; a live send only ever happens in
 *      the loop, against a subscription a real browser created.
 *
 * WHAT IT DOES NOT DO: no mute-word filtering. Mutes are DEVICE-LOCAL in this
 * client (`src/snapchain/mutePreferences.ts` `mutesInUse()`), and uploaded here
 * are only the muted FIDs — numbers, re-sent when the list changes. A hidden
 * person cannot push, and a muted WORD never leaves the browser at all. Upstream
 * quilcast filters mutes server-side because their mutes are per-FID server
 * state; copying that would mean uploading the words, which this product says it
 * never does.
 */

import { groupActivity } from './group.mjs';
import { sendPush, vapidAuthorization } from './webpush.mjs';
import { ALERT_KINDS } from './store.mjs';

/** The floor between two consultations of one reader. */
export const CONSULT_INTERVAL_MS = 60 * 1000;

/** How long a push service may hold a message for a sleeping phone. */
export const PUSH_TTL_SECONDS = 6 * 60 * 60;

/** A kind switch that the derivation and the store both know by name. */
export const kindEnabled = (kinds, kind) =>
  Boolean(kinds && kinds[`${kind}s`] !== false);

const KINDS_BY_SWITCH = {
  mentions: ['mention'],
  replies: ['reply'],
  likes: ['like'],
  follows: ['follow'],
};

/** Keep only what this reader asked to hear about. */
export const filterKinds = (items, kinds) => {
  const allowed = new Set();
  for (const name of ALERT_KINDS) {
    // The switch is the plural ("likes"), the item kind is not.
    if (!kinds || kinds[name] !== false) {
      for (const kind of KINDS_BY_SWITCH[name]) {
        allowed.add(kind);
      }
    }
  }
  return items.filter((item) => allowed.has(item.kind));
};

/** Keep a muted person out of the pushes as well as out of the app. */
export const filterMuted = (items, mutedFids) => {
  const muted = new Set((mutedFids ?? []).map(Number));
  if (muted.size === 0) {
    return items;
  }
  return items.filter((item) => !muted.has(Number(item.actor?.fid)));
};

/**
 * @param {object} input
 * @param {ReturnType<import('./store.mjs').createAlertStore>} input.store
 * @param {ReturnType<import('./vapid.mjs').createVapidStore>} input.vapid
 * @param {ReturnType<import('./derive.mjs').createActivityReader>} input.activityReader
 * @param {Function} [input.fetchImpl]
 * @param {() => number} [input.now]
 * @param {number} [input.intervalMs]   the floor between two consultations
 * @param {number} [input.pushTtlSeconds]
 * @param {number} [input.logSize]
 * @param {Array<{ip:string,at:number}>} [input.log]  recent outcomes, for health
 */
export const createAlertService = ({
  store,
  vapid,
  activityReader,
  fetchImpl = fetch,
  now = () => Date.now(),
  intervalMs = CONSULT_INTERVAL_MS,
  pushTtlSeconds = PUSH_TTL_SECONDS,
  logSize = 40,
}) => {
  /** When each reader was last consulted, in memory only: a restart re-reads. */
  const lastSeen = new Map();
  const recent = [];
  let timer;
  let ticking = false;
  const stats = { sent: 0, failed: 0, gone: 0, ticks: 0, lastTickAt: 0 };

  const note = (entry) => {
    recent.unshift({ ...entry, at: now() });
    if (recent.length > logSize) {
      recent.length = logSize;
    }
  };

  /** The keys, or undefined when this host never made any. */
  const keysNow = async () => vapid.read();

  const deliver = async ({ fid, subscription, keys }) => {
    const muted = subscription.mutedFids ?? [];
    const coined = await activityReader.activity(fid);
    const live = filterMuted(filterKinds(coined, subscription.kinds), muted).filter(
      // Nothing from before the reader said yes.
      (item) => (item.at ?? 0) >= (subscription.createdAt ?? 0),
    );
    if (live.length === 0) {
      return { sent: 0 };
    }
    const { pushes, delivered } = groupActivity({
      items: live,
      sent: subscription.sent,
      now: now(),
      language: subscription.language,
    });
    if (pushes.length === 0) {
      return { sent: 0 };
    }
    let sent = 0;
    for (const push of pushes) {
      const authorization = vapidAuthorization({
        endpoint: subscription.endpoint,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        subject: keys.subject,
        now: now(),
      });
      const result = await sendPush({
        fetchImpl,
        subscription,
        payload: push,
        authorization,
        ttlSeconds: pushTtlSeconds,
        now,
      });
      if (result.gone) {
        await store.remove(fid);
        stats.gone += 1;
        note({ kind: 'gone', fid });
        return { sent, gone: true };
      }
      if (result.ok) {
        sent += 1;
        stats.sent += 1;
      } else {
        stats.failed += 1;
        note({ kind: 'failed', fid, reason: result.error ?? `status ${result.status}` });
      }
    }
    // What was folded into "N more" counts as sent too, or it comes back.
    await store.recordSent(fid, delivered, now());
    return { sent };
  };

  /** One pass. Exported so a probe can drive it without waiting a minute. */
  const tick = async () => {
    if (ticking) {
      return { skipped: 'already-running' };
    }
    ticking = true;
    stats.ticks += 1;
    stats.lastTickAt = now();
    try {
      const keys = await keysNow();
      if (!keys) {
        // No identity: nothing is sent, and the loop says so rather than
        // quietly retrying with a key that does not exist.
        return { skipped: 'no-keys' };
      }
      let subscribers;
      try {
        subscribers = await store.list();
      } catch (error) {
        note({ kind: 'store', reason: String(error) });
        return { skipped: 'store' };
      }
      let sent = 0;
      for (const { fid, subscription } of subscribers) {
        const since = lastSeen.get(fid) ?? 0;
        if (now() - since < intervalMs) {
          continue;
        }
        lastSeen.set(fid, now());
        try {
          const result = await deliver({ fid, subscription, keys });
          sent += result.sent ?? 0;
        } catch (error) {
          note({ kind: 'error', fid, reason: error instanceof Error ? error.message : 'x' });
        }
      }
      return { subscribers: subscribers.length, sent };
    } finally {
      ticking = false;
    }
  };

  const start = () => {
    if (timer) {
      return;
    }
    // `unref` so a CLI or a test process is never kept alive by this loop.
    timer = setInterval(() => {
      void tick().catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    tick,
    start,
    stop,
    stats,
    recent,
    /** Exposed for the probe: what the next pass will consider. */
    lastSeen,
  };
};