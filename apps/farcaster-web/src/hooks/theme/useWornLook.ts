/**
 * The look this browser is wearing.
 *
 * The document already wears it before this hook runs — `public/shell-bootstrap.js`
 * writes the look's variables in `<head>`, so there is no frame of the previous
 * palette. What this hook adds is the live half: putting one on, taking it off,
 * and following a look put on in another tab.
 *
 * TWO KEYS, ON PURPOSE. `fiddy-look` is the look itself; `fiddy-looks` is the
 * library of the ones this browser tried, so "put that one back on" is a list
 * rather than a memory test. Both are read with the same checked shape
 * (`~/utils/lookTheme.ts`), so a hand-edited or half-written value is simply not
 * a look.
 *
 * WHAT PUTTING A LOOK ON ALSO WRITES. The saved light/dark choice, to the look's
 * own ground. That is the same move `useFiddyBrandGround` already makes for the
 * brand: the choice is visible and reversible in Settings rather than a hidden
 * override, and the two cannot end up disagreeing about which ground is dark.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  applyLook,
  cleanLook,
  Look,
  LOOK_LIBRARY_KEY,
  LOOK_STORAGE_KEY,
  readSavedLooks,
  readWornLook,
  rememberLook,
  wearLook,
} from '~/utils/lookTheme';

const THEME_STORAGE_KEY = 'user-saved-theme';

const tellTheApp = (key: string, value: string | null) => {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key,
      newValue: value,
      oldValue: null,
      storageArea: localStorage,
      url: window.location.href,
    }),
  );
};

export function useWornLook() {
  const [wornLook, setWornLook] = useState<Look | undefined>(() =>
    readWornLook(),
  );
  const [savedLooks, setSavedLooks] = useState<Look[]>(() => readSavedLooks());

  // The bootstrap did this for the first paint; this keeps it true afterwards
  // (a take-off, a put-on, or a look that arrived from another tab).
  useEffect(() => {
    applyLook(wornLook);
  }, [wornLook]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LOOK_STORAGE_KEY) {
        setWornLook(readWornLook());
      }
      if (event.key === LOOK_LIBRARY_KEY) {
        setSavedLooks(readSavedLooks());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const putOnLook = useCallback((look: Look) => {
    const cleaned = cleanLook(look);
    if (!Object.keys(cleaned).length) {
      return;
    }
    wearLook(cleaned);
    setSavedLooks(rememberLook(cleaned));
    setWornLook(cleaned);

    const base = cleaned.base === 'light' ? 'light' : 'dark';
    if (localStorage.getItem(THEME_STORAGE_KEY) !== base) {
      localStorage.setItem(THEME_STORAGE_KEY, base);
      tellTheApp(THEME_STORAGE_KEY, base);
    }
  }, []);

  const takeOffLook = useCallback(() => {
    wearLook(undefined);
    setWornLook(undefined);
  }, []);

  /** Keep a look without wearing it (used when a shared look is saved). */
  const keepLook = useCallback((look: Look) => {
    setSavedLooks(rememberLook(look));
  }, []);

  return { wornLook, savedLooks, putOnLook, takeOffLook, keepLook };
}
