/**
 * Analytics with no key: the honest default.
 *
 * MEASURED (2026-10-21, the live release): every load of fiddy.fun asked
 * `ph.neynar.com` for `/array/REPLACE_ME/config` (404) and `/flags/` (401) and
 * wrote a `ph_REPLACE_ME_posthog` record into localStorage — the fork's template
 * key, aimed at Neynar's PostHog, measuring nothing. This build has no PostHog
 * key of its own, so the check that matters is that nothing is sent at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogInit = vi.fn();

vi.mock('posthog-js', () => ({
  default: {
    init: (...args: unknown[]) => posthogInit(...args),
    capture: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    get_property: vi.fn(),
    get_session_id: vi.fn(),
    setPersonProperties: vi.fn(),
    onFeatureFlags: vi.fn(),
    isFeatureEnabled: vi.fn(),
    getFeatureFlagPayload: vi.fn(),
  },
}));

import { analyticsConfigured, posthogApiKey } from '~/constants/analytics';
import { Analytics } from '~/utils/analyticsUtils';

describe('analytics in a build with no PostHog key', () => {
  beforeEach(() => {
    posthogInit.mockClear();
  });

  it('is not configured, and says the key it would use is the fork’s template', () => {
    expect(analyticsConfigured).toBe(false);
    expect(posthogApiKey).toBe('REPLACE_ME');
  });

  it('leaves posthog-js uninitialised, so no request leaves the page', () => {
    Analytics.init();
    expect(posthogInit).not.toHaveBeenCalled();
  });

  it('does not turn it on later either', () => {
    Analytics.enable();
    expect(posthogInit).not.toHaveBeenCalled();
  });

  it('answers every caller with nothing, instead of pretending to measure', () => {
    Analytics.init();
    expect(Analytics.getDeviceId()).toBeUndefined();
    expect(Analytics.getSessionId()).toBeUndefined();
    expect(Analytics.isFeatureEnabled('any-flag')).toBeUndefined();
    expect(Analytics.getFeatureFlagPayload('any-flag')).toBeUndefined();
  });
});
