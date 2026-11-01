/**
 * The sign-up doors, and what happens when one of them is switched off.
 *
 * The load-bearing claims here are provider-agnosticism and honesty: both
 * providers come from one list, the config is built from that list rather than
 * hand-written, and a dashboard that has switched a method off produces a
 * sentence with the other ways in it — not a modal that never opens.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  areSocialSignUpsAvailable,
  describeSocialSignUpFailure,
  isMethodDisabledError,
  privyAppId,
  privyBrowserConfig,
  SOCIAL_PROVIDERS,
  socialProvider,
} from '~/lib/socialSignUp';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the doors on offer', () => {
  it('offers Google and X, and nothing provider-specific is hard-coded twice', () => {
    expect(SOCIAL_PROVIDERS.map((provider) => provider.id)).toEqual([
      'google',
      'twitter',
    ]);
    expect(SOCIAL_PROVIDERS.map((provider) => provider.label)).toEqual([
      'Continue with Google',
      'Continue with X',
    ]);
  });

  it('resolves a provider by id, and refuses anything else', () => {
    expect(socialProvider('google')?.name).toBe('Google');
    // @ts-expect-error — an id this client does not offer must not resolve.
    expect(socialProvider('discord')).toBeUndefined();
  });
});

describe('the app id decides whether the feature exists', () => {
  it('is absent when nothing is configured', () => {
    vi.stubEnv('VITE_PRIVY_APP_ID', '');
    expect(privyAppId()).toBeUndefined();
    expect(areSocialSignUpsAvailable()).toBe(false);
  });

  it('is present when configured, trimmed of whitespace', () => {
    vi.stubEnv('VITE_PRIVY_APP_ID', '  cmvbtw3qe002d0flbgwkfjvtc  ');
    expect(privyAppId()).toBe('cmvbtw3qe002d0flbgwkfjvtc');
    expect(areSocialSignUpsAvailable()).toBe(true);
  });
});

describe('the browser config', () => {
  it('is built from the same list, and creates a wallet only when there is none', () => {
    const config = privyBrowserConfig();

    expect(config.loginMethods).toEqual(['google', 'twitter']);
    expect(config.embeddedWallets?.ethereum?.createOnLogin).toBe(
      'users-without-wallets',
    );
  });
});

describe('when a provider is switched off in the dashboard', () => {
  it('recognises the code however Privy delivers it', () => {
    expect(isMethodDisabledError('disallowed_login_method')).toBe(true);
    expect(isMethodDisabledError({ code: 'disallowed_login_method' })).toBe(
      true,
    );
    expect(
      isMethodDisabledError({
        error: 'error: disallowed_login_method for this app',
      }),
    ).toBe(true);
    expect(isMethodDisabledError({ status: 500 })).toBe(false);
    expect(isMethodDisabledError(undefined)).toBe(false);
  });

  it('names the other ways in, in plain words', () => {
    const google = socialProvider('google');
    const message = describeSocialSignUpFailure({
      provider: google!,
      error: { code: 'disallowed_login_method' },
    });

    expect(message).toContain('Google sign-up is switched off');
    expect(message).toContain('Continue with X');
    expect(message).toContain('sign in with Farcaster');
    // The jargon ban holds: the dashboard's own vocabulary never reaches a person.
    expect(message).not.toContain('disallowed_login_method');
    expect(message).not.toContain('Privy');
  });

  it('says plainly that a failure created nothing', () => {
    const twitter = socialProvider('twitter');
    const message = describeSocialSignUpFailure({
      provider: twitter!,
      error: new Error('network down'),
    });

    expect(message).toContain('X did not answer');
    expect(message).toContain('Nothing was created');
    expect(message).not.toContain('Privy');
  });
});
