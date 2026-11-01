/**
 * The client's half of cast translations: ask our own origin, keep the answers.
 *
 * The affordance is already here (`CastTranslationTopHat`, the toggle, the text
 * swap) and it reads `cast.translation`, a field only the HOSTED API shape has
 * — a node never sets it, and the build we ship is node-backed. So this is the
 * producer's client half: the detector (`~/utils/castLanguage`) says a cast is
 * in another language, this asks the service on our OWN origin
 * (`server/translate/`, `POST /api/translate` + `/api/translations`), and the
 * hooks read what comes back.
 *
 * Three rules, and they are the whole design:
 *
 *   1. one origin. The browser talks to fiddy.fun and to nothing else — the
 *      model is reached from the server, so `verify-no-off-site-reads.mjs`
 *      stays green and no third party ever sees a visitor;
 *   2. one request per feed, not per cast. The casts on screen are asked about
 *      together, after a moment, in batches of fifty (`requestCastTranslations`),
 *      and the answers are cached for the session;
 *   3. never a control that cannot work. `castTranslationServiceAvailable()`
 *      asks `GET /api/translate` first, so a self-hosted copy with no service,
 *      or a host with no model key, draws no Translate button at all.
 *
 * The storage format and the refusals are the service's business: this module
 * only ever keeps what the server validated.
 */

import { CLIENT_LANGUAGE } from '~/utils/castLanguage';

export type CastTranslation = { from: string; text: string };

/** The hash as the service keys it: bare, lowercase. */
const keyOf = (hash: string) => hash.replace(/^0x/i, '').toLowerCase();

const kept = new Map<string, CastTranslation>();
const listeners = new Set<() => void>();
const waiting = new Map<string, (() => void)[]>();

/** How long to gather the casts on screen before asking about them at once. */
const GATHER_MS = 60;

/** The service's own cap on one lookup. */
const BATCH = 50;

let flush: ReturnType<typeof setTimeout> | undefined;
let capability: Promise<boolean> | undefined;

const announce = () => listeners.forEach((listener) => listener());

/** What this session already knows about a cast, or null. */
const readCastTranslation = (hash: string): CastTranslation | null =>
  kept.get(keyOf(hash)) ?? null;

/** Re-render when a batch lands (`useSyncExternalStore`). */
const subscribeToCastTranslations = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Whether this host can translate at all, asked once per session.
 *
 * The service answers `{on:false}` when it has no model key, and a host with no
 * service at all answers 404 or refuses the connection: both mean "no", and the
 * caller draws nothing. Asked once because it cannot change under a reader's
 * feet, and cached for a session because it is a fact about the host.
 */
const castTranslationServiceAvailable = (): Promise<boolean> => {
  capability ??= fetch('/api/translate', {
    headers: { accept: 'application/json' },
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => Boolean(payload?.on))
    .catch(() => false);
  return capability;
};

/**
 * The already-kept translations for a feed's worth of casts, in one request.
 *
 * A cast with no kept translation resolves with null: nothing is asked of the
 * model here, and nothing is invented. The gather window is what makes a feed
 * of thirty foreign casts one round trip instead of thirty.
 */
const requestCastTranslations = (hashes: string[]): Promise<void> =>
  Promise.all(
    hashes.map(
      (hash) =>
        new Promise<void>((settle) => {
          const key = keyOf(hash);
          if (kept.has(key)) {
            settle();
            return;
          }
          waiting.set(key, [...(waiting.get(key) ?? []), () => settle()]);
          flush ??= setTimeout(() => {
            flush = undefined;
            const asked = new Map(waiting);
            waiting.clear();
            const keys = [...asked.keys()];
            Promise.all(
              Array.from(
                { length: Math.ceil(keys.length / BATCH) },
                (_, page) =>
                  fetch('/api/translations', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      to: CLIENT_LANGUAGE,
                      hashes: keys.slice(page * BATCH, page * BATCH + BATCH),
                    }),
                  })
                    .then((response) => (response.ok ? response.json() : {}))
                    .catch(() => ({})),
              ),
            ).then((answers) => {
              const found: Record<string, CastTranslation> = Object.assign(
                {},
                ...answers,
              );
              for (const [key, resolvers] of asked) {
                const translation = found[key];
                if (translation?.text) {
                  kept.set(key, translation);
                }
                resolvers.forEach((resolve) => resolve());
              }
              if (Object.values(found).some((one) => one?.text)) {
                announce();
              }
            });
          }, GATHER_MS);
        }),
    ),
  ).then(() => undefined);

/**
 * Translate ONE cast now, because the reader pressed the button.
 *
 * `fid` is the cast's author, when the page knows it: the service addresses a
 * cast through its author's shard, and the browser is the one that already read
 * it. It is an address, never the words — the text is read from the node.
 *
 * A refusal arrives as the server's own sentence, which is what the reader
 * sees; nothing is cached from a refusal.
 */
const askForCastTranslation = async ({
  hash,
  fid,
}: {
  hash: string;
  fid?: number;
}): Promise<CastTranslation> => {
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hash, to: CLIENT_LANGUAGE, fid }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.text) {
    throw new Error(payload?.error || "Couldn't translate that right now.");
  }
  const translation: CastTranslation = {
    from: String(payload.from ?? 'und'),
    text: String(payload.text),
  };
  kept.set(keyOf(hash), translation);
  announce();
  return translation;
};

/** Tests and a fresh session: forget what this browser cached. */
const forgetCastTranslations = () => {
  kept.clear();
  capability = undefined;
  announce();
};

export {
  askForCastTranslation,
  castTranslationServiceAvailable,
  forgetCastTranslations,
  readCastTranslation,
  requestCastTranslations,
  subscribeToCastTranslations,
};
