import { AnalyticsEvent } from 'farcaster-analytics';
import { FC, memo, useEffect, useRef, useState } from 'react';

import { authTokenKey, getOnboardingStateKey } from '~/constants/storage';
import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { useAuth } from '~/contexts/AuthProvider';
import {
  announceMiniAppReady,
  isInsideMiniAppHost,
  loadMiniAppHostSdk,
  signInInsideMiniApp,
} from '~/lib/miniAppSession';
import { postSignInLocation } from '~/lib/postSignInLanding';
import { logError } from '~/utils/logUtils';
import { getItem, setItem } from '~/utils/storageUtils';

/**
 * Signs a Mini App visitor in from the host's own context, so nobody is asked
 * to sign in to the client they are already inside.
 *
 * WHAT THE PERSON SEES, and why it is this
 * Opened inside Farcaster (as a Mini App), the client boots straight into the
 * app: the overlay below says what is happening for the second it takes, and
 * then the app is there, signed in as the account the host already knew. No QR
 * code, no modal, nothing to scan. Opened in a browser, this component does
 * nothing at all — it is not a second sign-in door, it is the removal of one.
 *
 * WHY IT DOES NOT RACE THE NORMAL BOOT
 * `AuthProvider` reads the stored session asynchronously, so at the moment this
 * mounts, `authToken` is undefined even for someone who is already signed in.
 * Acting on that would sign a returning visitor in a second time and reload the
 * app out from under them. So the stored token is read here first, from the same
 * key `AuthProvider` uses (`constants/storage`), and nothing happens if one
 * exists.
 *
 * WHY THERE IS A ONE-SHOT MARK
 * A completed host sign-in ends in a reload (the same reboot the QR flow does,
 * for the same reason: the app should boot from the session rather than
 * re-render around it). If that reload somehow does not pick the session up, an
 * unguarded component would sign in again, reload again — forever, inside
 * somebody's Farcaster app. The mark in `sessionStorage` makes that impossible:
 * one attempt per tab session, and if it fails the ordinary sign-in door is
 * still right there.
 */
const AUTO_SIGN_IN_ATTEMPT_KEY = 'fiddy.miniapp.auto-sign-in';

/** How long the "you're in" line stays up before the client reboots. */
const SUCCESS_HOLD_MS = 1_100;

type AutoSignInState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'refused'; reason: string };

const MiniAppAutoSignIn: FC = memo(() => {
  const { signIn } = useAuth();
  const { trackEvent } = useAnalytics();
  const [state, setState] = useState<AutoSignInState>({ status: 'idle' });

  const hasRunRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current) {
      return;
    }

    hasRunRef.current = true;

    const run = async () => {
      const alreadySignedIn = await getItem<{ secret?: string } | undefined>({
        key: authTokenKey,
        fallback: undefined,
      });

      if (alreadySignedIn) {
        // Signed in already: nothing to do but let the host take its splash
        // down, which is the one call a Mini App must make either way.
        const sdk = await loadMiniAppHostSdk();

        if (sdk && (await isInsideMiniAppHost({ sdk }))) {
          await announceMiniAppReady({ sdk });
        }

        return;
      }

      const sdk = await loadMiniAppHostSdk();

      if (!sdk || !(await isInsideMiniAppHost({ sdk }))) {
        return;
      }

      const alreadyAttempted =
        window.sessionStorage?.getItem(AUTO_SIGN_IN_ATTEMPT_KEY) === 'true';

      if (alreadyAttempted) {
        // The person is in a host and a previous attempt in this tab did not
        // take. Stop retrying and leave the sign-in door to them.
        await announceMiniAppReady({ sdk });
        return;
      }

      try {
        window.sessionStorage?.setItem(AUTO_SIGN_IN_ATTEMPT_KEY, 'true');
      } catch (error) {
        // Private-mode storage: the guard is a nicety, not a requirement.
      }

      setState({ status: 'working' });

      const outcome = await signInInsideMiniApp({
        sdk,
        domain: window.location.host,
      });

      if (outcome.status === 'not-a-host') {
        setState({ status: 'idle' });
        return;
      }

      if (outcome.status !== 'signed-in') {
        setState({ status: 'refused', reason: outcome.reason });
        return;
      }

      // Persist the onboarding state FIRST: AuthProvider reads it by a key
      // derived from the token secret, and the reload below races it.
      await setItem({
        key: await getOnboardingStateKey(outcome.authToken.secret),
        value: outcome.onboardingState,
      });

      await signIn({ authToken: outcome.authToken });

      trackEvent(AnalyticsEvent.LoggedInInsideMiniAppHost, {
        fid: outcome.fid,
        fidBoundToSignature: outcome.fidBoundToSignature,
        hostAnnouncedReady: outcome.readyAnnounced,
      });

      // Reboot the app so it boots from the session it now has — and land on
      // the client, not on whatever screen the host happened to open.
      setTimeout(() => {
        window.location.replace(
          postSignInLocation({
            pathname: window.location.pathname,
            href: window.location.href,
          }),
        );
      }, SUCCESS_HOLD_MS);
    };

    run().catch((error) => {
      logError(error);
      setState({ status: 'idle' });
    });
  }, [signIn, trackEvent]);

  if (state.status === 'working') {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-[#141414]"
        data-fiddy="miniapp-auto-sign-in"
      >
        <div className="text-base text-light">
          Signing you in with Farcaster…
        </div>
        <div className="text-sm text-muted">
          You are already signed in to the app you opened this in.
        </div>
      </div>
    );
  }

  if (state.status === 'refused') {
    return (
      <div
        className="fixed inset-x-0 top-0 z-50 flex justify-center p-2"
        data-fiddy="miniapp-auto-sign-in-refused"
      >
        <div className="max-w-md rounded-md bg-[#141414] px-3 py-2 text-center text-xs text-light">
          {state.reason}. Use the sign-in button instead — nothing was signed in
          on this device.
        </div>
      </div>
    );
  }

  return null;
});

MiniAppAutoSignIn.displayName = 'MiniAppAutoSignIn';

export { MiniAppAutoSignIn };
