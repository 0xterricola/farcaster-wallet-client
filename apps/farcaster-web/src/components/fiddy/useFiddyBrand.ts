/**
 * Fiddy is a dark client.
 *
 * The brand is chartreuse (#d4ff3f) on #161715 — the accent clears contrast on
 * the dark ground and nowhere else, and no light shell was designed. So while a
 * Fiddy surface is mounted this hook pins the app to dark and paints the page
 * ground, instead of inheriting the fork's system-following default and leaving
 * a chartreuse-on-white client behind.
 *
 * The preference is written to the same storage key Settings already uses, so
 * the choice is visible and reversible rather than a hidden override.
 */

import { useEffect } from 'react';

const THEME_STORAGE_KEY = 'user-saved-theme';

export function useFiddyBrandGround() {
  useEffect(() => {
    const root = document.documentElement;

    if (localStorage.getItem(THEME_STORAGE_KEY) !== 'dark') {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: THEME_STORAGE_KEY,
          newValue: 'dark',
          storageArea: localStorage,
          url: window.location.href,
        }),
      );
    }

    root.classList.add('dark', 'fiddy-dark-shell');
    root.classList.remove('light');

    return () => {
      root.classList.remove('fiddy-dark-shell');
    };
  }, []);
}
