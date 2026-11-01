/**
 * The jsdom in this repo does not expose `window.localStorage`, and the Fiddy
 * setup file treats a missing storage API as "nothing saved yet" (correct in a
 * browser that refuses storage, and useless for testing what gets saved). This
 * installs a real in-memory implementation for the duration of a test file, so
 * the tests exercise the same read/write path a browser would.
 *
 * `sessionStorage` gets the same treatment from its own map: the trial's
 * one-message-per-session budget lives there, and "a new browser session" is a
 * thing a test has to be able to express — a shared map could not.
 */

const memoryStorage = (map = new Map<string, string>()): Storage => ({
  getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
  setItem: (key: string, value: string) => {
    map.set(key, String(value));
  },
  removeItem: (key: string) => {
    map.delete(key);
  },
  clear: () => {
    map.clear();
  },
  key: (index: number) => [...map.keys()][index] ?? null,
  get length() {
    return map.size;
  },
});

const define = (name: 'localStorage' | 'sessionStorage', value: Storage) => {
  Object.defineProperty(window, name, {
    value,
    configurable: true,
    writable: true,
  });
};

export const installFakeStorage = (): void => {
  define('localStorage', memoryStorage());
  define('sessionStorage', memoryStorage());
};

/** What closing the tab and coming back does to the trial budget. */
export const newBrowserSession = (): void => {
  define('sessionStorage', memoryStorage());
};

export const clearFakeStorage = (): void => {
  window.localStorage?.clear();
};
