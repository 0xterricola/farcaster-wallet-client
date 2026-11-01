import {
  POSTHOG_API_HOST,
  POSTHOG_API_KEY_DEV,
  POSTHOG_API_KEY_PRODUCTION,
} from 'farcaster-analytics';

import { isProd } from '~/constants/env';

/**
 * PostHog's key — and whether this build has one at all.
 *
 * MEASURED (2026-10-21, the live site, a real signed-in load): the fork's
 * analytics constants are still its template. `POSTHOG_API_KEY_PRODUCTION` is
 * the string `REPLACE_ME`, aimed at `ph.neynar.com`, so every load of fiddy.fun
 * asked a stranger's PostHog for `/array/REPLACE_ME/config` (404) and `/flags/`
 * (401), wrote a `ph_REPLACE_ME_posthog` record into localStorage, and had its
 * config script blocked by our own CSP — three console errors a load, and not
 * one measurement. Nothing about Fiddy is in that account; the key is not ours.
 *
 * A build that really has a key sets `VITE_POSTHOG_API_KEY` (and
 * `VITE_POSTHOG_API_HOST` when it is not PostHog's own host). Without one,
 * analytics is OFF: `Analytics.init()` returns before posthog-js is touched, so
 * nothing leaves the page and nothing is stored — see `utils/analyticsUtils.ts`.
 * The honest default for a key nobody has supplied is to send nothing.
 */
const isPlaceholderKey = (key: string): boolean => {
  const trimmed = key.trim();
  return trimmed.length === 0 || trimmed === 'REPLACE_ME';
};

const envKey = String(import.meta.env.VITE_POSTHOG_API_KEY ?? '');
const envHost = String(import.meta.env.VITE_POSTHOG_API_HOST ?? '').trim();

const templateKey = isProd ? POSTHOG_API_KEY_PRODUCTION : POSTHOG_API_KEY_DEV;

const posthogApiKey = isPlaceholderKey(envKey) ? templateKey : envKey.trim();
const posthogApiHost = envHost.length > 0 ? envHost : POSTHOG_API_HOST;

/** True when this build was given a real key: without one, nothing is sent. */
const analyticsConfigured = !isPlaceholderKey(posthogApiKey);

export { analyticsConfigured, posthogApiHost, posthogApiKey };
