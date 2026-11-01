import { AnalyticsEvent } from 'farcaster-analytics';
import {
  FC,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { DebugLogger } from '~/components/debug/DebugLogger';
import { LoginError } from '~/components/login/LoginError';
import { LoginQRCodeWithInstructions } from '~/components/login/LoginQRCodeWithInstructions';
import { getOnboardingStateKey } from '~/constants/storage';
import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { useAuth } from '~/contexts/AuthProvider';
import { postSignInLocation } from '~/lib/postSignInLanding';
import {
  buildLocalAuthToken,
  buildLocalOnboardingState,
  confirmFidOnNode,
  createSiwfChannel,
  saveSiwfProof,
  SiwfRelayError,
  SiwfTimeoutError,
  verifySiwfCompletion,
  watchSiwfChannel,
} from '~/lib/siwfSession';
import { resolveEffectiveNodeBaseUrl } from '~/snapchain/nodeChoice';
import { logError } from '~/utils/logUtils';
import { setItem } from '~/utils/storageUtils';

/** After this long on the QR screen we add a "still waiting" nudge. */
const SLOW_HINT_AFTER_MS = 45_000;

/** How long the "you're in" confirmation stays up before the app moves on. */
const SUCCESS_HOLD_MS = 1_100;

const timeoutErrorMessage = 'That sign-in request timed out';

const timeoutErrorHint =
  'Open the Farcaster app on your phone, approve the request there, then try again.';

const relayErrorMessage = "Farcaster's sign-in service is not responding";

const relayErrorHint =
  'This needs a connection to Farcaster. Check your connection, then try again.';

type LoginWithMobileProps = {
  onClose: () => void;
};

/**
 * Sign in by scanning a QR with the Farcaster app.
 *
 * This used to run Warpcast's legacy sync-channel device link, which Farcaster
 * has since removed — the channel was created successfully and then never
 * received anything, so the modal waited forever and the user saw nothing
 * happen. It now runs Sign In With Farcaster against the relay, which is what
 * the phone app actually implements today. See `~/lib/siwfSession` for the
 * evidence and for the honest limits of the session it produces.
 */
const LoginWithMobile: FC<LoginWithMobileProps> = memo(({ onClose }) => {
  const [key, setKey] = useState(Date.now().toString());

  const restart = useCallback(() => {
    setKey(Date.now().toString());
  }, []);

  return (
    <LoginWithMobileContent key={key} onClose={onClose} restart={restart} />
  );
});

LoginWithMobile.displayName = 'LoginWithMobile';

type LoginWithMobileContentProps = {
  onClose: () => void;
  restart: () => void;
};

type SignInFailure = {
  message: string;
  hint: string;
};

type SignedInAs = {
  fid: number;
  username?: string;
  displayName?: string;
  verified: boolean;
  /**
   * Who named this FID: the reader's own server, or nobody. `confirmed` is the
   * only one of the three that may be shown as a proven identity — the other two
   * are the device-only session this screen produced before the check existed.
   */
  confirmed: 'confirmed' | 'none' | 'unavailable';
};

const LoginWithMobileContent: FC<LoginWithMobileContentProps> = memo(
  ({ onClose, restart }) => {
    const { trackEvent } = useAnalytics();
    const { signIn } = useAuth();

    const [channelUrl, setChannelUrl] = useState<string>();
    const [slow, setSlow] = useState(false);
    const [attemptingLogin, setAttemptingLogin] = useState(false);
    const [failure, setFailure] = useState<SignInFailure>();
    const [signedInAs, setSignedInAs] = useState<SignedInAs>();

    const hasStartedRef = useRef(false);

    // Stop the poll when this component goes away — and ONLY then.
    //
    // This deliberately does not use `useCancelOnUnmountRef`: that helper flips
    // its flag 250ms after an unmount, which is right for a flow that owns the
    // page but wrong inside a modal whose container re-mounts during ordinary
    // re-render churn. When it tripped here the catch below returned silently
    // and the QR just sat there — the exact dead-modal failure this card exists
    // to kill. A plain mounted ref can only be cleared by a real unmount.
    const isMountedRef = useRef(true);

    useEffect(() => {
      isMountedRef.current = true;
      return () => {
        isMountedRef.current = false;
      };
    }, []);

    const signInWithFarcaster = useCallback(async () => {
      if (hasStartedRef.current) {
        return;
      }

      hasStartedRef.current = true;

      try {
        // The relay needs the domain the app is actually served from, and a
        // siweUri on that same origin. Both are read here rather than at module
        // load so a host change (localhost → deployed host) can't go stale.
        const { host, origin } = window.location;

        const channel = await createSiwfChannel({
          siweUri: `${origin}/login`,
          domain: host,
        });

        if (!isMountedRef.current) {
          return;
        }

        setChannelUrl(channel.url);

        const completion = await watchSiwfChannel({
          channelToken: channel.channelToken,
          isCancelled: () => !isMountedRef.current,
        });

        if (!isMountedRef.current) {
          return;
        }

        setAttemptingLogin(true);

        const verification = await verifySiwfCompletion({
          message: completion.message,
          signature: completion.signature,
          nonce: channel.nonce,
          domain: host,
        });

        if (!verification.verified || !verification.address) {
          // A signature that doesn't prove what it claims is worse than no
          // session at all — refuse it and say so plainly.
          throw new SiwfRelayError(
            verification.reason ?? 'unverified signature',
          );
        }

        // Who this account IS, asked of the reader's own server rather than of
        // the relay that carried the signature (`~/lib/siwfSession`,
        // `confirmFidOnNode`). A copy of Fiddy a person runs themselves answers
        // this from their own node; fiddy.fun asks the node it reads from.
        const confirmation = await confirmFidOnNode({
          address: verification.address,
          nodeUrl: resolveEffectiveNodeBaseUrl(),
          expectedFid: completion.fid,
        });

        if (!isMountedRef.current) {
          return;
        }

        if (confirmation.state === 'mismatch') {
          // The server that decides this names a different account for the very
          // address that signed. That is not a session to enter: it is a
          // contradiction, and it is reported as one.
          setFailure({
            message: 'That sign-in does not match this account',
            hint: `The server this copy of Fiddy reads from names account ${confirmation.fid} for that signature, not ${completion.fid}. Nothing was signed in.`,
          });
          return;
        }

        // Local-only session. SIWF cannot mint a farcaster.xyz API token, so
        // this marks the session as local and the app stops short of claiming
        // any server-side identity it hasn't proven. See `~/lib/siwfSession`.
        //
        // The proof itself is kept for the one thing that needs it after: the
        // agent service proves ownership by verifying this exact signature, so
        // `/~/agent` can turn the owner's agent on without asking them for a URL
        // and a token. It lives in sessionStorage, for thirty minutes, and
        // `~/lib/fiddyAgentAutopair` deletes it once spent.
        saveSiwfProof({
          fid: completion.fid,
          message: completion.message,
          signature: completion.signature,
          nonce: channel.nonce,
        });

        const authToken = buildLocalAuthToken({ fid: completion.fid });
        const onboardingState = buildLocalOnboardingState({
          fid: completion.fid,
          username: completion.username,
          displayName: completion.displayName,
          bio: completion.bio,
          pfpUrl: completion.pfpUrl,
        });

        // Persist the onboarding state FIRST: AuthProvider reads it by a key
        // derived from the token secret, and the reload below races it.
        await setItem({
          key: await getOnboardingStateKey(authToken.secret),
          value: onboardingState,
        });

        await signIn({ authToken });

        setSignedInAs({
          fid: completion.fid,
          username: completion.username,
          displayName: completion.displayName,
          verified: verification.verified,
          confirmed: confirmation.state,
        });

        trackEvent(AnalyticsEvent.LoggedInToWebUsingCompanion, {});

        // Reboot the app so it boots from the new session — but not blindly in
        // place. Started from a setup screen (where "Go social" lives), an
        // in-place reload re-renders that screen and the person who just signed
        // in never reaches the client; started from anywhere else, in place is
        // exactly right. `postSignInLocation` is that decision, in one place.
        setTimeout(() => {
          window.location.replace(
            postSignInLocation({
              pathname: window.location.pathname,
              href: window.location.href,
            }),
          );
        }, SUCCESS_HOLD_MS);
      } catch (error) {
        // Only a real unmount may swallow the failure. Anything else must reach
        // the user as a visible error with a retry — a modal that can quietly
        // stop working is the bug this card is about.
        if (!isMountedRef.current) {
          return;
        }

        logError(error);

        if (error instanceof SiwfTimeoutError) {
          setFailure({ message: timeoutErrorMessage, hint: timeoutErrorHint });
          return;
        }

        if (error instanceof SiwfRelayError) {
          setFailure({ message: relayErrorMessage, hint: relayErrorHint });
          return;
        }

        setFailure({
          message: relayErrorMessage,
          hint: relayErrorHint,
        });
      }
    }, [signIn, trackEvent]);

    useEffect(() => {
      trackEvent(AnalyticsEvent.ViewLoginWithMobileScreen, undefined);
    }, [trackEvent]);

    useEffect(() => {
      signInWithFarcaster();
    }, [signInWithFarcaster]);

    useEffect(() => {
      const timer = setTimeout(() => setSlow(true), SLOW_HINT_AFTER_MS);
      return () => clearTimeout(timer);
    }, []);

    const body = useMemo(() => {
      if (failure) {
        return (
          <LoginError
            hint={failure.hint}
            message={failure.message}
            restart={restart}
          />
        );
      }

      // The win, visible: name the account we just proved, not "success".
      if (signedInAs) {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-8">
            <div className="text-base text-light">You're signed in.</div>
            <div className="font-seasonMix text-3xl font-semibold text-light">
              {signedInAs.username
                ? `@${signedInAs.username}`
                : (signedInAs.displayName ?? `fid ${signedInAs.fid}`)}
            </div>
            <div className="text-sm text-muted">fid {signedInAs.fid}</div>
            {/* Who named this account. The honest half of the flow: the relay
                carried the signature, and the reader's own server is what says
                which account it is — or says nothing, which is also reported. */}
            <div className="text-center text-sm text-muted">
              {signedInAs.confirmed === 'confirmed'
                ? 'Confirmed by your own setup'
                : signedInAs.confirmed === 'none'
                  ? 'Your own setup does not know this account yet'
                  : 'Your own setup could not confirm this account'}
            </div>
            <div className="text-sm text-muted">Loading the client…</div>
          </div>
        );
      }

      if (!channelUrl) {
        return (
          <div className="flex min-h-[264px] items-center justify-center text-light">
            Asking Farcaster for a sign-in code…
          </div>
        );
      }

      return (
        <LoginQRCodeWithInstructions
          attemptingLogin={attemptingLogin}
          onClose={onClose}
          slow={slow}
          url={channelUrl}
        />
      );
    }, [
      attemptingLogin,
      channelUrl,
      failure,
      onClose,
      restart,
      signedInAs,
      slow,
    ]);

    return (
      <div className="min-h-[264px] w-full">
        <DebugLogger
          name="Sign In With Mobile"
          data={{
            channelUrl,
            signedInAsFid: signedInAs?.fid,
          }}
        />
        {body}
      </div>
    );
  },
);

LoginWithMobileContent.displayName = 'LoginWithMobileContent';

export { LoginWithMobile };
