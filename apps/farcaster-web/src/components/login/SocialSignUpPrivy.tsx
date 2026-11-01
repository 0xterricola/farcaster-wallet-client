/**
 * The social sign-up itself — the only file in this feature that talks to Privy.
 *
 * WHY IT IS A SEPARATE MODULE, LOADED ON DEMAND. Privy's browser SDK is a
 * third-party script with an iframe behind it. Nothing on the client's first
 * paint should depend on it, so this module is only ever reached through a
 * dynamic import: the buttons draw from `~/components/login/SocialSignUpOptions`
 * (which knows nothing about Privy), and this stays behind the door until a
 * person actually presses one.
 *
 * WHAT A COMPLETED SIGN-UP DOES, IN ORDER. Privy answers with a user; the user is
 * mapped to a Fiddy identity (`~/lib/socialAccount`); the identity is saved into
 * the SAME account book the rest of the client uses, selected, and this browser
 * is sent to the account screen. Nothing is sent to Fiddy's half of anything —
 * there is no server call in this flow at all, which is the same honest shape as
 * the Farcaster sign-in (`~/lib/siwfSession`): the account is real, and this
 * device is the only place that holds it.
 *
 * WHAT IT REFUSES TO DO. Two refusals matter. A sign-up that comes back without
 * an Ethereum wallet is not turned into an account — an account with no custody
 * address is not an account. And a failure is never swallowed: whether the
 * provider is switched off in the dashboard or the network is down, the sentence
 * that comes back says which, and that nothing was created.
 */

import { useLogin, usePrivy, type User } from '@privy-io/react-auth';
import React, { FC, memo, useCallback, useRef, useState } from 'react';

import {
  buildSocialAccountRecord,
  pickSocialIdentity,
  type PrivyUserLike,
} from '~/lib/socialAccount';
import {
  describeSocialSignUpFailure,
  SOCIAL_ACCOUNT_PATH,
  SOCIAL_PROVIDERS,
  socialProvider,
  type SocialProviderId,
} from '~/lib/socialSignUp';
import { usePrivyRoot } from '~/providers/PrivyRoot';
import { saveLocalAccount } from '~/snapchain/accounts/localAccounts';

import { SocialSignUpOptions } from './SocialSignUpOptions';

/** The sign-up as the modal sees it: ready to draw, or honest about waiting. */
const SocialSignUpPrivy: FC = memo(() => {
  const { ready, configured, failed } = usePrivyRoot();

  if (!configured) {
    return null;
  }

  if (!ready) {
    // Two different silences, said differently: one is still loading, one has
    // already refused (see ~/providers/PrivyRoot — a provider that refuses
    // leaves the client standing and `failed` true). A person who is told "one
    // moment" forever is being lied to.
    return (
      <SocialSignUpOptions
        disabled
        onPress={() => undefined}
        unavailableNote={
          failed
            ? 'Google and X are not answering right now. You can still sign in with Farcaster below.'
            : 'Getting Google and X ready — one moment.'
        }
      />
    );
  }

  return <SocialSignUpFlow />;
});

SocialSignUpPrivy.displayName = 'SocialSignUpPrivy';

/** The half that may call Privy's hooks, so it only renders under the provider. */
const SocialSignUpFlow: FC = memo(() => {
  const [busy, setBusy] = useState<SocialProviderId | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  /**
   * Which door was pressed. The callbacks below arrive with the failing provider
   * left implicit, and "X did not answer" must not be said about Google.
   */
  const askedRef = useRef<SocialProviderId>(SOCIAL_PROVIDERS[0].id);

  const finish = useCallback(async (user: User) => {
    const identity = pickSocialIdentity(user as unknown as PrivyUserLike);

    if (!identity) {
      setBusy(undefined);
      setMessage(
        'That sign-up did not say which account it was. Nothing was created — try again.',
      );
      return;
    }

    const record = buildSocialAccountRecord({ identity });

    if (!record) {
      setBusy(undefined);
      setMessage(
        'That sign-up did not finish setting the account up. Nothing was created — try again.',
      );
      return;
    }

    // Saved before anything navigates: the account screen reads it back, and a
    // reload in between must not lose what was just made.
    await saveLocalAccount(record, { select: true });

    window.location.replace(SOCIAL_ACCOUNT_PATH);
  }, []);

  const { login } = useLogin({
    onComplete: ({ user }) => {
      void finish(user);
    },
    onError: (error) => {
      const provider = socialProvider(askedRef.current) ?? SOCIAL_PROVIDERS[0];

      setBusy(undefined);
      setMessage(describeSocialSignUpFailure({ provider, error }));
    },
  });

  const press = useCallback(
    (providerId: SocialProviderId) => {
      askedRef.current = providerId;
      setMessage(undefined);
      setBusy(providerId);

      login({ loginMethods: [providerId] });
    },
    [login],
  );

  return <SocialSignUpOptions busy={busy} message={message} onPress={press} />;
});

SocialSignUpFlow.displayName = 'SocialSignUpFlow';

/**
 * "Show me my backup words", for an account whose words are held for it.
 *
 * Privy keeps the phrase inside its own secure window; this app never holds it
 * and never prints it, so the button opens that window rather than rendering
 * anything itself. If the window cannot be opened — not signed in any more, or
 * the account has no held wallet — the sentence says so instead of leaving a
 * press that did nothing.
 */
const HeldWordsButtonInner: FC<{ address?: string; label?: string }> = memo(
  ({ address, label = 'Open the secure backup window' }) => {
    const { exportWallet, authenticated } = usePrivy();
    const [message, setMessage] = useState<string | undefined>();

    if (!authenticated) {
      return (
        <p className="text-sm text-muted" data-fiddy="held-words-unavailable">
          Sign in with Google or X again to take your own copy of these words.
        </p>
      );
    }

    return (
      <>
        <button
          type="button"
          className="fiddy-quiet-btn"
          data-fiddy="held-words-open"
          onClick={() => {
            setMessage(undefined);

            void exportWallet(address ? { address } : undefined).catch(() => {
              setMessage(
                'That window did not open. Nothing was changed — try again.',
              );
            });
          }}
        >
          {label}
        </button>
        {message ? (
          <p
            className="text-sm text-danger"
            role="alert"
            data-fiddy="held-words-error"
          >
            {message}
          </p>
        ) : null}
      </>
    );
  },
);

HeldWordsButtonInner.displayName = 'HeldWordsButtonInner';

/** The gate above it: with no provider there is no window to open. */
const HeldWordsButton: FC<{ address?: string; label?: string }> = memo(
  ({ address, label }) => {
    const { ready, configured } = usePrivyRoot();

    if (!configured || !ready) {
      return null;
    }

    return <HeldWordsButtonInner address={address} label={label} />;
  },
);

HeldWordsButton.displayName = 'HeldWordsButton';

export { HeldWordsButton, SocialSignUpPrivy };
