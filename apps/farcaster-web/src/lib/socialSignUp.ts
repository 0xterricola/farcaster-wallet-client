/**
 * Signing up with a social account — Google, or X — through Privy.
 *
 * WHY THIS EXISTS. Until now there was exactly one way into this client: Sign In
 * With Farcaster, which asks for an account you already have somewhere else. That
 * is the right door for someone who lives on Farcaster and the wrong one for
 * someone who has never heard of it. So this adds the ordinary door — press
 * "Continue with Google" or "Continue with X", and you have an account here,
 * without ever seeing a word list. The key pair behind that account is a real
 * Ethereum wallet; it is just held for you rather than written on a piece of
 * paper, and `~/lib/socialAccount` maps it to the Fiddy identity this device
 * keeps.
 *
 * PROVIDER-AGNOSTIC ON PURPOSE. Both buttons are built from one list. Which of
 * them a given person can actually complete is a switch in the Privy dashboard
 * (`disallowed_login_method`), never a line of code — so the code must not
 * pretend it knows. When the dashboard has a method switched off the attempt
 * fails with that code, and `describeSocialSignUpFailure` turns it into a
 * sentence a person can act on instead of a modal that never opens.
 *
 * ONE PRIVY INTEGRATION, NOT TWO. The app id below is the same public
 * identifier legitmate-farcaster exports as `NEXT_PUBLIC_PRIVY_APP_ID`. There is
 * one Privy app behind both surfaces; the browser half of it is a public value
 * by design (it identifies the app to the SDK and ships in the bundle).
 * `PRIVY_APP_SECRET` is the other half, it is a server secret, and nothing in
 * this client reads it.
 *
 * OFF IS A STATE, NOT A FAILURE. With no app id configured the feature is
 * absent: no provider is mounted (`~/providers/PrivyRoot`), no button is drawn,
 * and the Farcaster half of sign-in behaves exactly as it did before. That is
 * what keeps a build without the variable — every build today — honest.
 */

import type { PrivyClientConfig } from '@privy-io/react-auth';

/**
 * Where a social sign-up lands: the account screen, which says what this account
 * is, offers the backup, and names the one thing still missing.
 *
 * Declared here rather than only in `~/constants/routes` because both the route
 * table and the sign-up flow need it, and the flow must not have to import the
 * whole route table (which imports every page) to say where it is going.
 */
export const SOCIAL_ACCOUNT_PATH = '/welcome/account';

/** The social sign-up methods this client offers, in the order they are drawn. */
export type SocialProviderId = 'google' | 'twitter';

export type SocialProvider = {
  /** Stable id, and the Privy login method it maps to, one and the same. */
  id: SocialProviderId;
  /** What the button says. */
  label: string;
  /** How the provider is named inside a sentence. */
  name: string;
};

export const SOCIAL_PROVIDERS: readonly SocialProvider[] = [
  { id: 'google', label: 'Continue with Google', name: 'Google' },
  { id: 'twitter', label: 'Continue with X', name: 'X' },
] as const;

/**
 * The public app id, read at call time rather than at module load.
 *
 * Read late for two reasons: a test can set the variable and see the feature
 * appear, and a build that has the variable but a bundle that was cached without
 * it cannot go stale behind a module-level constant.
 */
export const privyAppId = (): string | undefined => {
  const raw = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  return trimmed === '' ? undefined : trimmed;
};

/** True when social sign-up is configured for this build at all. */
export const areSocialSignUpsAvailable = (): boolean =>
  privyAppId() !== undefined;

/** The provider with that id, or undefined for anything else. */
export const socialProvider = (
  id: SocialProviderId,
): SocialProvider | undefined =>
  SOCIAL_PROVIDERS.find((provider) => provider.id === id);

/**
 * The config the browser SDK is mounted with.
 *
 * `createOnLogin: 'users-without-wallets'` is the whole "abstracted account"
 * promise: a social sign-up produces an Ethereum wallet the person never had to
 * think about, and an account that already has one keeps it. `loginMethods` is
 * built from `SOCIAL_PROVIDERS`, so adding or removing a door is one edit in one
 * list — and the dashboard is still the thing that decides whether the provider
 * behind it answers.
 */
export const privyBrowserConfig = (): PrivyClientConfig => ({
  loginMethods: SOCIAL_PROVIDERS.map((provider) => provider.id),
  embeddedWallets: {
    ethereum: { createOnLogin: 'users-without-wallets' },
  },
});

/**
 * Privy refuses a method the dashboard has switched off with this code. It can
 * arrive as a code on an error object or inside the message, which is why the
 * check reads both rather than asserting a shape.
 */
const METHOD_DISABLED_CODE = 'disallowed_login_method';

export const isMethodDisabledError = (error: unknown): boolean => {
  if (typeof error === 'string') {
    return error.includes(METHOD_DISABLED_CODE);
  }

  if (error && typeof error === 'object') {
    const candidate = error as {
      code?: unknown;
      error?: unknown;
      message?: unknown;
    };

    return [candidate.code, candidate.error, candidate.message].some(
      (value) =>
        typeof value === 'string' && value.includes(METHOD_DISABLED_CODE),
    );
  }

  return false;
};

/**
 * What to tell someone whose social sign-up did not work — in words they can act
 * on. A switched-off provider is a switch, so it says so and offers the other
 * two doors; anything else is a plain failure with a plain retry.
 */
export const describeSocialSignUpFailure = ({
  provider,
  error,
}: {
  provider: SocialProvider;
  error?: unknown;
}): string => {
  if (isMethodDisabledError(error)) {
    const alternatives = SOCIAL_PROVIDERS.filter(
      (candidate) => candidate.id !== provider.id,
    )
      .map((candidate) => `Continue with ${candidate.name}`)
      .concat('sign in with Farcaster');

    return `${provider.name} sign-up is switched off for this app right now. You can use ${alternatives.join(' or ')} instead.`;
  }

  return `${provider.name} did not answer. Nothing was created — try again, or use another way in.`;
};
