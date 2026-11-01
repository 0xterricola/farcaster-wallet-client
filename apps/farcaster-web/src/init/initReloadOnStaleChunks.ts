/**
 * A tab that was open before a deploy does not go dead on a lazy surface.
 *
 * THE FAILURE
 *
 * A release replaces the hashed chunk files and the host serves only `current`:
 * the previous release directories stay on disk but their URLs stop answering
 * (see `scripts/release-client.sh`). A tab loaded before that cutover still
 * holds the old build's module graph, so the first `React.lazy` surface it
 * opens afterwards — the emoji picker, the composer's own modal, a Privy
 * sign-up, the seed-phrase warning — asks for a chunk file the host no longer
 * has. The fetch 404s and, with nothing listening, the click simply does
 * nothing. This client releases several times a day, so a tab open across a
 * release is ordinary, not exotic.
 *
 * WHAT HAPPENS INSTEAD
 *
 * Vite reports it: its preload helper catches a failed dynamic import (and a
 * failed preload link) and dispatches `vite:preloadError` on `window` —
 * `return baseModule().catch(handlePreloadError)` in vite 6.4.2's own helper,
 * which is why the event fires for the chunk itself and not only for its
 * `<link>`s. One reload puts the tab on the build the host is actually serving,
 * and the next click works.
 *
 * WHY THE RELOAD IS THROTTLED
 *
 * A chunk that is genuinely gone — a broken release, not a cutover — would
 * otherwise reload forever: reload, fail at the same import, reload. One reload
 * per `RELOAD_WINDOW_MS`, stamped in `sessionStorage`, bounds that to a single
 * reload, after which the failure is left where it is (the rejection is NOT
 * prevented, so whoever asked for the chunk sees its error the ordinary way
 * instead of an empty surface).
 *
 * `sessionStorage` on purpose: the window belongs to one tab, and one tab's
 * reload must not license another tab's. When storage is unavailable — a
 * private-mode browser that throws on the property itself — there is nowhere to
 * remember the last reload, so no reload happens at all: a browser that cannot
 * remember must never be allowed to loop.
 *
 * The shape — reload once per 30 s on the preload error — is upstream quilcast
 * 0.11.2 (`src/app.tsx`, commit `9f835d4a26b1`, MIT), which hit the same wall
 * from the same cutover. This version adds the storage-unavailable path above
 * and lives in `init/`, where the entry's other one-time wiring lives.
 */

/** Where one reload per window is remembered, per tab. */
const RELOAD_STAMP_KEY = 'fiddy:stale-chunk-reload';

/**
 * How long one reload licenses the tab. Long enough that a reload racing its
 * own cutover cannot spin, short enough that a person who hits a genuinely
 * missing chunk twice is not told to wait a long time for a second try.
 */
export const RELOAD_WINDOW_MS = 30_000;

/** This tab's storage, or nothing when the browser will not hand it over. */
const safeSessionStorage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    // Some browsers throw on the property itself, not only on a get.
    return undefined;
  }
};

/** One entry point for the whole decision, so a test can drive it directly. */
export interface StaleChunkReload {
  /** Where the last reload is remembered. */
  storage?: Storage | undefined;
  /** The clock, in milliseconds. */
  now?: () => number;
  /** How the page comes back. */
  reload?: () => void;
}

/**
 * Reload into the build the host is serving, or refuse to.
 *
 * Returns whether it reloaded — the answer is the point, and it is what the
 * test asserts on: a second call inside the window must come back `false`
 * rather than navigating again.
 */
export const reloadForStaleChunks = ({
  storage = safeSessionStorage(),
  now = Date.now,
  reload = () => window.location.reload(),
}: StaleChunkReload = {}): boolean => {
  if (!storage) {
    return false;
  }

  try {
    const stamp = storage.getItem(RELOAD_STAMP_KEY);
    const last = stamp === null ? undefined : Number(stamp);
    const at = now();

    // No stamp means this tab has not reloaded for a chunk yet, so nothing is
    // throttling it — that is a first reload, not a reload at the epoch.
    if (
      last !== undefined &&
      Number.isFinite(last) &&
      at - last < RELOAD_WINDOW_MS
    ) {
      return false;
    }

    storage.setItem(RELOAD_STAMP_KEY, String(at));
  } catch {
    // Storage that cannot be read or written cannot throttle anything, so it
    // cannot be trusted with a reload.
    return false;
  }

  reload();
  return true;
};

/**
 * Listen for the chunks this tab can no longer fetch.
 *
 * Installed once from the entry. The handler deliberately does not call
 * `preventDefault()` on the event: if this reload does not happen, the import
 * rejection should reach the surface that asked for it.
 */
export const installStaleChunkReloadListener = (): void => {
  window.addEventListener('vite:preloadError', () => {
    reloadForStaleChunks();
  });
};
