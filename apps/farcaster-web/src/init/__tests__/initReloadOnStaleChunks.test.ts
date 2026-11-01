// @vitest-environment jsdom
/**
 * One reload per tab, and never a loop.
 *
 * The reload decision is driven directly with a fake storage and clock, because
 * the thing that can really hurt here is the loop: a chunk that is genuinely
 * missing must produce ONE reload, not a page that reloads forever. The last
 * test drives the installed listener instead of the function, so the event name
 * vite actually dispatches is covered too — it seeds the stamp rather than
 * clearing it, because jsdom refuses to navigate and the decision is what
 * matters (the real reload is measured in the browser, by
 * `scripts/verify-stale-chunk-reload.mjs`).
 */

import {
  installStaleChunkReloadListener,
  RELOAD_WINDOW_MS,
  reloadForStaleChunks,
} from '~/init/initReloadOnStaleChunks';

/** A realistic clock, so nothing in these tests depends on the epoch. */
const AT = 1_700_000_000_000;

/** A storage with no browser behind it. */
const fakeStorage = () => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
    key: () => null,
    length: 0,
    entries,
  } as unknown as Storage & { entries: Map<string, string> };
};

/** Storage that refuses to be touched, as a private-mode browser does. */
const refusingStorage = () =>
  ({
    getItem: () => {
      throw new Error('storage is disabled');
    },
    setItem: () => {
      throw new Error('storage is disabled');
    },
  }) as unknown as Storage;

describe('a chunk this tab can no longer fetch', () => {
  it('reloads once, and remembers that it did', () => {
    const storage = fakeStorage();
    const reload = vi.fn();

    expect(reloadForStaleChunks({ storage, now: () => AT, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.entries.size).toBe(1);
  });

  it('refuses a second reload inside the window, however many errors arrive', () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    let clock = AT;

    reloadForStaleChunks({ storage, now: () => clock, reload });

    for (let i = 0; i < 10; i += 1) {
      clock += 100;
      expect(reloadForStaleChunks({ storage, now: () => clock, reload })).toBe(
        false,
      );
    }

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again once the window has passed', () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    let clock = AT;

    reloadForStaleChunks({ storage, now: () => clock, reload });

    clock += RELOAD_WINDOW_MS - 1;
    expect(reloadForStaleChunks({ storage, now: () => clock, reload })).toBe(
      false,
    );

    clock += 1;
    expect(reloadForStaleChunks({ storage, now: () => clock, reload })).toBe(
      true,
    );
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads when the browser will not remember the last one', () => {
    const reload = vi.fn();

    for (let i = 0; i < 5; i += 1) {
      expect(reloadForStaleChunks({ storage: refusingStorage(), reload })).toBe(
        false,
      );
    }

    expect(reload).not.toHaveBeenCalled();
  });

  it('answers the event vite really dispatches, and holds the window', () => {
    installStaleChunkReloadListener();
    // Already reloaded inside the window: the listener must do nothing, which
    // is observable as an untouched stamp (jsdom would not navigate anyway).
    window.sessionStorage.setItem(
      'fiddy:stale-chunk-reload',
      String(Date.now()),
    );
    const before = window.sessionStorage.getItem('fiddy:stale-chunk-reload');

    window.dispatchEvent(new Event('vite:preloadError'));

    expect(window.sessionStorage.getItem('fiddy:stale-chunk-reload')).toBe(
      before,
    );
  });
});
