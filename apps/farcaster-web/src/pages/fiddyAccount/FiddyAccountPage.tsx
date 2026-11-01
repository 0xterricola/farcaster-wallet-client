/**
 * Where a social sign-up lands: the account it just made, in plain words.
 *
 * WHY THIS SCREEN EXISTS AT ALL. A Google or X sign-up makes a real account on
 * this device — a wallet nobody had to think about — but it does not make a
 * Farcaster account, and posting is Farcaster's job. So instead of dropping the
 * person on a screen that complains, this one does three things in order: says
 * who they are now, asks them to back it up (offered, never forced —
 * `~/components/fiddy/seedBackup`), and names the one thing still missing with
 * the ways to get it.
 *
 * THE NUMBER IS CLAIMED BY THIS ACCOUNT, NOT BY A SECOND ONE. The leading route
 * for a social account hands the account screen's own account to
 * `~/components/login/HeldAccountSheet`, which signs the registration with the
 * wallet the sign-up is holding — so the registrar mints the FID to THAT wallet
 * and this device ends up with one account that holds the number, rather than
 * two (a wallet with no FID, and a device-made account that has one). A person
 * who already has a Farcaster account somewhere else still has their route:
 * sign in with it, which proves that account rather than attaching it
 * (`~/lib/siwfSession`).
 *
 * WHAT IT REFUSES TO PRETEND. Nothing here says the account can post before a
 * Farcaster account exists, and nothing claims the held wallet owns one until
 * the network has actually given it a number. The account is held, selectable,
 * and listed in the switcher the rest of the client already uses; the moment a
 * Farcaster account is attached, the ordinary signed-in flow takes over.
 *
 * AN ACCOUNT THAT ALREADY HAS ITS NUMBER. It can still land here — signed out,
 * after a reload, on a device whose session was cleared — and telling that
 * person they have no Farcaster account would be false. So the routes collapse
 * to one action: sign in as it.
 */

import { KeyRound, MessageCircle, ShieldCheck } from 'lucide-react';
import React, { FC, lazy, memo, Suspense, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { CreateAccountSheet } from '~/components/fiddy/accounts/CreateAccountSheet';
import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { SeedBackupNotice } from '~/components/fiddy/seedBackup/SeedBackupNotice';
import { Link } from '~/components/links/Link';
import { LoginModal } from '~/components/modals/LoginModal';
import { Page } from '~/components/page/Page';
import { defaultRoute, routes } from '~/constants/routes';
import { useAuth } from '~/contexts/AuthProvider';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import { postSignInLocation } from '~/lib/postSignInLanding';
import { isSocialAccount } from '~/lib/socialAccount';
import { SOCIAL_PROVIDERS } from '~/lib/socialSignUp';
import {
  signInAsLocalAccount,
  useLocalAccounts,
} from '~/snapchain/accounts/session';

/** Privy's own window for words it holds. Loaded only when it is configured. */
const HeldWordsButton = lazy(() =>
  import('~/components/login/SocialSignUpPrivy').then((module) => ({
    default: module.HeldWordsButton,
  })),
);

/**
 * Claiming a number for the account that is already here. Loaded on demand for
 * the same reason the sign-up itself is: it is the only code on this screen that
 * needs the provider's window, and a build without one must not load it.
 */
const HeldAccountSheet = lazy(() =>
  import('~/components/login/HeldAccountSheet').then((module) => ({
    default: module.HeldAccountSheet,
  })),
);

const FiddyAccountPage: FC = memo(() => {
  const { accounts, current, loading } = useLocalAccounts();
  const { signIn } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const [creating, setCreating] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [signInError, setSignInError] = useState<string | undefined>();
  const isSignedIn = useIsSignedIn();

  const provider =
    SOCIAL_PROVIDERS.find((candidate) => candidate.id === current?.provider) ??
    undefined;

  // A signed-in session does not belong on this screen either.
  //
  // This is the screen a social sign-up lands on, and its whole subject is the
  // one thing still missing: "No Farcaster account yet", with the honest ways to
  // get one. MEASURED 2026-10-22, a real Chrome at 390px: signing in with
  // Farcaster from this screen completes the handshake, saves the proof and
  // reloads this very URL (`postSignInLocation` keeps a deep link in place, and
  // this screen is not one of the setup paths it leaves) — and the person who
  // just attached a Farcaster account was shown a screen telling them they have
  // none, with no way into the client. So a session that arrives here, by that
  // reload or by any other route, goes on to the client — where the switcher
  // lists the accounts this device holds, which is the state this screen was
  // pointing at.
  if (isSignedIn) {
    return <Navigate to={defaultRoute.path} replace />;
  }

  if (loading) {
    return (
      <Page className="fiddy-surface" meta={{ title: 'Fiddy — your account' }}>
        <div data-fiddy="fiddy-account" data-state="loading" />
      </Page>
    );
  }

  if (!current) {
    return (
      <Page className="fiddy-surface" meta={{ title: 'Fiddy — your account' }}>
        <div data-fiddy="fiddy-account" data-state="none">
          <FiddySheet
            name="account"
            egg="small"
            title="This browser is not holding an account of its own yet."
            sub="Nothing is broken. An account made here lives on this device, and this one has none."
            primary={{
              label: 'Start again',
              onClick: () => {
                window.location.assign(routes.fiddyWelcome.path);
              },
            }}
          >
            <p className="fiddy-sheet-note">
              Signing up with Google or X makes one in one press, and so does
              making one with Farcaster.
            </p>
          </FiddySheet>
        </div>
      </Page>
    );
  }

  const identityLabel =
    current.email ?? (current.username ? `@${current.username}` : undefined);
  const social = isSocialAccount(current);
  const hasNumber = current.fid !== undefined;
  const accountName = current.username
    ? `@${current.username}`
    : 'this account';

  /**
   * Signing in as an account this device holds, from the screen that just told
   * the person it holds no Farcaster account. `~/snapchain/accounts/session`
   * refuses an account with no number, so this is only ever offered when there
   * is one to sign in as.
   */
  const signInNow = async () => {
    setSignInError(undefined);

    try {
      await signInAsLocalAccount({ account: current, signIn });
    } catch (thrown) {
      setSignInError(
        thrown instanceof Error && thrown.message
          ? thrown.message
          : "we couldn't sign you in - try opening Fiddy again",
      );
      return;
    }

    window.location.replace(
      postSignInLocation({
        pathname: window.location.pathname,
        href: window.location.href,
      }),
    );
  };

  const primary = hasNumber
    ? { label: `Sign in as ${accountName}`, onClick: () => void signInNow() }
    : social
      ? {
          label: 'Make this a Farcaster account',
          onClick: () => setClaiming(true),
        }
      : {
          label: 'I already have a Farcaster account — sign in with it',
          onClick: () => setSigningIn(true),
        };

  const quiet = hasNumber
    ? {
        label: 'I already have a Farcaster account — sign in with it',
        onClick: () => setSigningIn(true),
      }
    : social
      ? {
          label: 'I already have a Farcaster account — sign in with it',
          onClick: () => setSigningIn(true),
        }
      : {
          label: 'Make a Farcaster account here instead',
          onClick: () => setCreating(true),
        };

  return (
    <Page className="fiddy-surface" meta={{ title: 'Fiddy — your account' }}>
      <div
        data-fiddy="fiddy-account"
        data-state="ready"
        data-has-number={hasNumber ? 'true' : 'false'}
      >
        <FiddySheet
          name="account"
          egg="small"
          title={identityLabel ?? 'Your account is here.'}
          sub={
            provider
              ? hasNumber
                ? `You signed up with ${provider.name}. This account holds a Farcaster account of its own now.`
                : `You signed up with ${provider.name}. That makes a real account on this device — a key pair held for you, with nothing to write down.`
              : 'This account lives on this device, and the words that own it were written down when it was made.'
          }
          primary={primary}
          quiet={quiet}
          note={
            hasNumber
              ? 'Nothing is missing here: the Farcaster account belongs to this one.'
              : social
                ? 'Fiddy posts through Farcaster, so that is the one step left. The number is claimed by the account you just made: no second account, and nothing to write down.'
                : 'Fiddy posts through Farcaster, so that is the one step left. Either way the account you just made stays on this device and shows up in your account list.'
          }
        >
          <ul className="fiddy-summary">
            <li>
              <KeyRound aria-hidden="true" />
              <span>
                <b>{identityLabel ?? 'Held for you'}</b>
                <small>
                  {provider
                    ? `your ${provider.name} sign-up`
                    : 'the account this device made'}
                </small>
              </span>
            </li>
            <li>
              <MessageCircle aria-hidden="true" />
              <span>
                <b>
                  {hasNumber
                    ? 'A Farcaster account of its own'
                    : 'No Farcaster account yet'}
                </b>
                <small>
                  {hasNumber
                    ? `${accountName} belongs to this account, and this device can post for it`
                    : 'posting, the feed and messages need one — that is the step above'}
                </small>
              </span>
            </li>
            <li>
              <ShieldCheck aria-hidden="true" />
              <span>
                <b>
                  {accounts.length > 1
                    ? `${accounts.length} accounts on this device`
                    : 'One account on this device'}
                </b>
                <small>
                  switch between them from the shell once you are in
                </small>
              </span>
            </li>
          </ul>

          {signInError ? <p className="fiddy-error">{signInError}</p> : null}

          {current.walletCustody === 'privy' ? (
            <SeedBackupNotice
              account={current}
              heldWordsSlot={
                <Suspense fallback={null}>
                  <HeldWordsButton address={current.custodyAddress} />
                </Suspense>
              }
            />
          ) : (
            <SeedBackupNotice account={current} />
          )}

          <p className="fiddy-sheet-note">
            {current.provider
              ? 'Your account list shows this one by the name you signed up with.'
              : ''}
          </p>
        </FiddySheet>

        <footer className="fiddy-legal">
          <Link
            to="privacyPolicy"
            params={{}}
            searchParams={{}}
            title="Privacy Policy"
          >
            Privacy
          </Link>
          <Link
            to="termsOfUse"
            params={{}}
            searchParams={{}}
            title="Terms of Use"
          >
            Terms
          </Link>
        </footer>
      </div>

      {signingIn ? <LoginModal onClose={() => setSigningIn(false)} /> : null}

      {creating ? (
        <CreateAccountSheet onClose={() => setCreating(false)} />
      ) : null}

      {/* The number is claimed by the account that is already here. */}
      {claiming ? (
        <Suspense fallback={null}>
          <HeldAccountSheet
            account={current}
            onClose={() => setClaiming(false)}
          />
        </Suspense>
      ) : null}
    </Page>
  );
});

FiddyAccountPage.displayName = 'FiddyAccountPage';

export { FiddyAccountPage };
