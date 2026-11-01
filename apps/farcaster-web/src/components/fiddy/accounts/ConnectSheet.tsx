/**
 * "Connect your Farcaster account" — one tap, no fee, no passphrase.
 *
 * WHAT THE PERSON SEES, IN ORDER
 *
 *   idle      one sentence about what they are about to allow, and one button
 *   waiting   the link, on a phone a deep link and on a desktop a code to scan;
 *             this screen notices on its own the moment they approve, so nothing
 *             has to be pressed a second time
 *   connected what is now true ("Fiddy can post for you"), and how to undo it
 *   stopped   after they turn it off — from here or in Farcaster
 *   problem   what actually happened, in a sentence, plus the honest fallback
 *
 * WHOSE ACCOUNT IT IS
 *
 * A connection belongs to one person, and this screen is where that is enforced
 * on the client side. It adopts an identity only when the connection is the
 * person's own: the approval has to be for the account they are signed in as
 * (never a different one), or — on a device that has not signed in yet — for the
 * request THIS tab started. Anything else is reported as what it is and the
 * session is left exactly where it was. Fiddy's own account can never become
 * somebody's identity, on any path: the service refuses that approval outright
 * and tells the browser nothing about it.
 *
 * WHAT IT WILL NOT DO
 *
 * - It never says "connected" until the service says so.
 * - It never signs this browser in as an account that is not the one it proved,
 *   and never silently switches an existing session.
 * - It never leaves a dead button: a failure replaces the screen with a
 *   sentence and a way forward.
 * - It never uses the words this product bans from its own screens (no
 *   "signer", no "scope", no "TTL", no "gasless") — the thing the person granted
 *   is "a posting key", and what it can do is "post for you".
 */

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { QRCode } from 'react-qrcode-logo';

import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { routes } from '~/constants/routes';
import { getOnboardingStateKey } from '~/constants/storage';
import { useAuth } from '~/contexts/AuthProvider';
import { useCachedCurrentUser } from '~/hooks/data/useCachedCurrentUser';
import {
  buildLocalAuthToken,
  buildLocalOnboardingState,
  loadSiwfProof,
} from '~/lib/siwfSession';
import {
  type ConnectBinding,
  type ConnectRefusal,
  type ConnectStatus,
  connectStatus,
  forgetConnectAttempt,
  isServiceUnreachable,
  rememberConnectStatus,
  startConnect,
  stopConnect,
} from '~/snapchain/accounts/managedConnect';
import { saveAppKey } from '~/snapchain/appKeyStorage';
import { setItem } from '~/utils/storageUtils';

/** How often the waiting screen asks the service for news. */
const POLL_MS = 2_500;

/** After this long waiting, the screen says what to check instead of sitting silent. */
const SLOW_HINT_AFTER_MS = 60_000;

/** Past the hint, the asking slows down: it is a person's phone, not a race. */
const SLOW_POLL_MS = 10_000;

type View =
  | { name: 'idle'; notice?: string }
  | { name: 'starting' }
  | { name: 'waiting'; approvalUrl: string }
  | { name: 'connected'; fid: number; username: string | null }
  | { name: 'stopped' }
  /** The approval was somebody else's. Nothing is adopted, ever. */
  | { name: 'refused'; reason: ConnectRefusal; username: string | null }
  /** A connection this tab did not ask for, on a device nobody is signed in on. */
  | { name: 'elsewhere'; username: string | null }
  /**
   * The request did not go through. `unreachable` says which kind of failure it
   * was: nothing answered at this address (so the one-tap approval cannot happen
   * HERE, and the screen has to offer what can) or the service answered and
   * refused (so pressing again is the whole answer).
   */
  | { name: 'problem'; message: string; unreachable: boolean };

export interface ConnectSheetProps {
  /** Called when the sheet is done — the page closes it, a modal dismisses it. */
  onClose?: () => void;
  /**
   * Ask straight away, with no first screen: used when the person is already in
   * the middle of something that needs the key (pressing the heart, sending a
   * cast) and has just been told, in one sentence, why the screen is up. The
   * same request, the same poll, the same sheet — one press fewer.
   */
  autoStart?: boolean;
  /**
   * The moment the service says the posting key exists. With this, the sheet
   * never shows its own "Connected" screen and never signs anybody in: the
   * caller is carrying out the write that was waiting
   * (`~/snapchain/accounts/postingKeyApproval`), and says so itself.
   */
  onApproved?: (fid: number, username: string | null) => void;
  /**
   * What happens once the approval is given, as one sentence the caller wrote
   * ("Your like goes out by itself — there is nothing to press when you come
   * back."). Shown on the waiting screen only, and only when something really is
   * waiting: this sheet never promises to finish a thing it was not told about.
   */
  completing?: string | null;
}

/**
 * The service's answer, turned into a screen — with the identity questions asked
 * here, in one place, before anything can be adopted.
 *
 * `signedInFid` is who THIS browser is signed in as, if anyone:
 *   - a connection for a different account is never rendered as this person's;
 *   - a connection for the same account is theirs, and the sheet says so;
 *   - with nobody signed in, an identity may only be adopted from a request this
 *     tab started (`startedHere`). Someone else's connection on a shared device
 *     is reported, not entered.
 */
const statusToView = (
  status: ConnectStatus,
  signedInFid: number | undefined,
): View => {
  if (status.state === 'wrong_account') {
    return {
      name: 'refused',
      reason: status.refused,
      username: status.username,
    };
  }
  if (status.state === 'connected' && status.fid !== null) {
    if (signedInFid !== undefined && signedInFid !== status.fid) {
      return { name: 'elsewhere', username: status.username };
    }
    if (signedInFid === undefined && !status.startedHere) {
      return { name: 'elsewhere', username: status.username };
    }
    return { name: 'connected', fid: status.fid, username: status.username };
  }
  if (status.state === 'waiting' && status.approvalUrl !== null) {
    return { name: 'waiting', approvalUrl: status.approvalUrl };
  }
  if (status.state === 'revoked') {
    return { name: 'stopped' };
  }
  return { name: 'idle' };
};

/**
 * The posting key a copy of Fiddy mints for itself is handed to THIS browser
 * (`server/instance/connect.mjs`), so it is stored where every other key this
 * device uses is stored — and from then on the client signs its own writes
 * through the node it is already pointed at. Only for the account the
 * connection belongs to, and only after the identity rules below have passed:
 * an answer naming a key for somebody else's connection is dropped by
 * `readStatus` before it can reach here.
 */
const keepHandedOverKey = async (
  status: ConnectStatus,
  fid: number,
): Promise<void> => {
  // Read as a KEY, not merely as "not null": this is the one place a service's
  // answer can put bytes in this device's key store, and an answer that carries
  // anything but a 32-byte key (`~/snapchain/accounts/managedConnect` reads the
  // field strictly for the same reason) must never reach it.
  if (
    typeof status.postingKey !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(status.postingKey)
  ) {
    return;
  }
  // AWAITED, not fired and forgotten: on this path the connection exists to
  // finish a write the person is waiting on, and `onApproved` sends that write
  // back through the writer *immediately* after this returns. A key still in
  // flight there would make the retry refuse itself with "no key" — the exact
  // dead end this whole flow exists to remove.
  try {
    await saveAppKey(fid, status.postingKey);
  } catch {
    // Storage refusing the key does not fail the connection: the person can
    // still add one from Advanced, and nothing here claims otherwise.
  }
};

/**
 * Who is asking, as far as this browser can prove it: the FID it is signed in
 * as, with the SIWF proof of that sign-in when this tab still holds one. Without
 * a proof the request is nobody's until somebody approves it in their own
 * Farcaster app — which the service then ties to that account alone.
 *
 * A proof for a *different* fid than the session (a leftover from an earlier
 * sign-in) is never sent: it would be evidence for somebody else's account.
 */
const bindingFor = (signedInFid: number | undefined): ConnectBinding | null => {
  if (signedInFid === undefined) {
    return null;
  }
  const proof = loadSiwfProof();
  if (!proof || proof.fid !== signedInFid) {
    return null;
  }
  return {
    forFid: signedInFid,
    proof: {
      message: proof.message,
      signature: proof.signature,
      nonce: proof.nonce ?? '',
    },
  };
};

export const ConnectSheet = memo<ConnectSheetProps>(
  ({ onClose, autoStart = false, onApproved, completing = null }) => {
    const { authToken, signIn } = useAuth();
    const signedIn = useCachedCurrentUser();
    const signedInFid = signedIn?.fid;
    const [view, setView] = useState<View>({ name: 'idle' });
    const [slow, setSlow] = useState(false);
    const [working, setWorking] = useState(false);

    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);

    /**
     * What the sheet does with an answer from the service.
     *
     * One place, so the first read, the button and the poll cannot disagree:
     * `connected` either goes to the caller (when something is waiting on it) or
     * to this sheet's own Connected screen (when a person is connecting an
     * account they want to keep).
     */
    const apply = useCallback(
      async (status: ConnectStatus): Promise<void> => {
        rememberConnectStatus(status);
        if (!mounted.current) {
          return;
        }
        const next = statusToView(status, signedInFid);
        if (next.name === 'connected') {
          await keepHandedOverKey(status, next.fid);
        }
        if (!mounted.current) {
          return;
        }
        if (next.name === 'connected' && onApproved !== undefined) {
          onApproved(next.fid, next.username);
          return;
        }
        setView(next);
      },
      [onApproved, signedInFid],
    );

    const begin = useCallback(async () => {
      setWorking(true);
      setSlow(false);
      try {
        // Who this connection is for, said with evidence rather than asserted:
        // the sign-in proof this tab holds, when it is for the account it is
        // signed in as. Without one the request belongs to whoever approves it
        // in their own Farcaster app — and then only to this tab.
        const { status } = await startConnect({
          binding: bindingFor(signedInFid),
        });
        await apply(status);
      } catch (error) {
        if (!mounted.current) {
          return;
        }
        setView({
          name: 'problem',
          message: (error as Error).message,
          unreachable: isServiceUnreachable(error),
        });
      } finally {
        if (mounted.current) {
          setWorking(false);
        }
      }
    }, [apply, signedInFid]);

    /**
     * What is already true, asked once when the sheet opens: somebody who
     * approved a minute ago and navigated back must not be shown the first
     * screen again. A service we cannot reach leaves the first screen up (the
     * button retries and says what happened); it never becomes a scary screen of
     * its own.
     *
     * With `autoStart` — the person pressed Cast, or the heart, and the approval
     * is what they are being asked for — there is nothing to wait for: a
     * service that has no request yet gets one, and a request that is already
     * waiting is shown as the link it is.
     */
    useEffect(() => {
      let live = true;
      void (async () => {
        try {
          const status = await connectStatus();
          if (!live || !mounted.current) {
            return;
          }
          if (status.state === 'none' && autoStart) {
            await begin();
            return;
          }
          await apply(status);
        } catch {
          // Stay on the first screen; pressing the button asks again and
          // reports. With nothing to press (autoStart), the same call is tried
          // once more so the person is not left on an empty screen.
          if (autoStart && live && mounted.current) {
            await begin();
          }
        }
      })();
      return () => {
        live = false;
      };
      // `begin` and `apply` are stable for the life of the sheet unless the
      // caller changes its own handler; the read is meant to happen once.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** While a link is waiting, watch for the approval — nobody presses twice. */
    const waitingUrl = view.name === 'waiting' ? view.approvalUrl : null;
    useEffect(() => {
      if (waitingUrl === null) {
        return undefined;
      }
      let live = true;
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout>;

      const ask = async () => {
        try {
          const status = await connectStatus();
          rememberConnectStatus(status);
          if (!live || !mounted.current) {
            return;
          }
          const next = statusToView(status, signedInFid);
          if (next.name !== 'waiting') {
            if (next.name === 'connected') {
              await keepHandedOverKey(status, next.fid);
            }
            if (next.name === 'connected' && onApproved !== undefined) {
              onApproved(next.fid, next.username);
              return;
            }
            setView(next);
            return;
          }
        } catch {
          // A blip is not news: keep the screen as it is and ask again.
        }
        if (!live || !mounted.current) {
          return;
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed > SLOW_HINT_AFTER_MS) {
          setSlow(true);
        }
        timer = setTimeout(
          ask,
          elapsed > SLOW_HINT_AFTER_MS ? SLOW_POLL_MS : POLL_MS,
        );
      };

      timer = setTimeout(ask, POLL_MS);
      return () => {
        live = false;
        clearTimeout(timer);
      };
    }, [waitingUrl, onApproved, signedInFid]);

    const turnOff = useCallback(async () => {
      setWorking(true);
      try {
        const status = await stopConnect();
        rememberConnectStatus(status);
        if (mounted.current) {
          setView({ name: 'stopped' });
        }
      } catch (error) {
        if (mounted.current) {
          setView({
            name: 'problem',
            message: (error as Error).message,
            unreachable: isServiceUnreachable(error),
          });
        }
      } finally {
        if (mounted.current) {
          setWorking(false);
        }
      }
    }, []);

    /**
     * Sign in as the account that just approved Fiddy, using the same
     * device-only session the Farcaster sign-in produces — this person has just
     * proven, in their own Farcaster app, that the account is theirs.
     */
    const continueAs = useCallback(
      async (fid: number, username: string | null) => {
        // The one place a session's identity is set, so the one place it can be
        // set wrongly: an account that contradicts the one already signed in
        // here is refused outright rather than swapped in.
        if (signedInFid !== undefined && signedInFid !== fid) {
          setView({ name: 'elsewhere', username });
          return;
        }
        setWorking(true);
        try {
          const token = buildLocalAuthToken({ fid });
          const onboardingState = buildLocalOnboardingState({
            fid,
            ...(username === null ? {} : { username }),
          });
          await setItem({
            key: await getOnboardingStateKey(token.secret),
            value: onboardingState,
          });
          await signIn({ authToken: token });
          // This tab's label has done its job: nobody else may inherit it.
          forgetConnectAttempt();
          window.location.replace(routes.homeFeed.path);
        } catch (error) {
          if (mounted.current) {
            setView({
              name: 'problem',
              message: (error as Error).message,
              unreachable: isServiceUnreachable(error),
            });
          }
        } finally {
          if (mounted.current) {
            setWorking(false);
          }
        }
      },
      [signIn, signedInFid],
    );

    if (view.name === 'starting') {
      return (
        <FiddySheet
          name="connect-starting"
          title="Setting it up…"
          sub={
            completing === null || completing.length === 0
              ? 'One moment while we ask Farcaster for a posting key for you.'
              : 'One moment while we ask Farcaster for a posting key for you. Then it goes out by itself.'
          }
          egg="small"
        />
      );
    }

    if (view.name === 'waiting') {
      return (
        <FiddySheet
          name="connect-waiting"
          title="One tap in Farcaster to finish"
          sub={
            completing === null || completing.length === 0
              ? 'Open this in the Farcaster app on your phone and approve Fiddy. This screen notices by itself — you can leave it open.'
              : `Open this in the Farcaster app on your phone and approve Fiddy. ${completing}`
          }
          primary={{
            label: 'Open Farcaster',
            onClick: () => window.open(view.approvalUrl, '_blank', 'noopener'),
          }}
          quiet={{ label: 'Not now', onClick: () => onClose?.() }}
          note={
            slow
              ? 'Still waiting. If nothing happened on your phone, open the link again from this screen.'
              : 'The link below is the request; approving it costs you nothing.'
          }
        >
          <div className="fiddy-connect-qr" data-fiddy="connect-qr">
            <QRCode
              bgColor="#161715"
              ecLevel="M"
              eyeRadius={0}
              fgColor="#eef0e8"
              size={196}
              value={view.approvalUrl}
            />
          </div>
          <a
            className="fiddy-connect-link"
            data-fiddy="connect-approval-link"
            href={view.approvalUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            Open the approval page in Farcaster
          </a>
        </FiddySheet>
      );
    }

    if (view.name === 'connected') {
      const handle = view.username === null ? null : `@${view.username}`;
      return (
        <FiddySheet
          name="connect-connected"
          title={handle === null ? 'Connected' : `Connected as ${handle}`}
          sub="Fiddy can post for you — turn it off anytime."
          egg="small"
          primary={
            authToken === undefined
              ? {
                  label: 'Continue',
                  onClick: () => void continueAs(view.fid, view.username),
                  disabled: working,
                }
              : { label: 'Done', onClick: () => onClose?.() }
          }
          quiet={{
            label: 'Turn it off',
            onClick: () => void turnOff(),
            disabled: working,
          }}
          note="Your account stays yours: Fiddy holds a posting key you granted, and you can take it back here or in your Farcaster app's settings."
        >
          <p className="fiddy-connect-body" data-fiddy="connect-promise">
            You will not be asked for a passphrase, and you were not charged
            anything.
          </p>
        </FiddySheet>
      );
    }

    if (view.name === 'refused') {
      const said =
        view.reason === 'app_account'
          ? {
              title: 'That approval was not for your account',
              sub: "The account that approved it was Fiddy's own, so nothing was connected here — and no posting key is held for you.",
            }
          : view.reason === 'other_account'
            ? {
                title: 'That approval came from a different account',
                sub:
                  view.username === null
                    ? 'The approval came from an account that is not the one this request was for. Nothing here was switched.'
                    : `The approval came from @${view.username}, but this request was started for your account. Nothing here was switched.`,
              }
            : {
                title: 'That connection is not yours',
                sub: 'The account that approved it was not the one this request was for. Nothing here was switched.',
              };
      return (
        <FiddySheet
          name="connect-refused"
          title={said.title}
          sub={said.sub}
          egg="small"
          primary={{
            label: 'Try again',
            onClick: () => void begin(),
            disabled: working,
          }}
          quiet={{ label: 'Not now', onClick: () => onClose?.() }}
          note="Your own account, its key and its recovery phrase are untouched. Nothing was posted as anybody."
        />
      );
    }

    if (view.name === 'elsewhere') {
      const handle = view.username === null ? null : `@${view.username}`;
      const mine = signedInFid !== undefined;
      return (
        <FiddySheet
          name="connect-elsewhere"
          title={
            mine
              ? 'That connection is for a different account'
              : handle === null
                ? 'This phone already has a connection'
                : `Connected as ${handle} on this device`
          }
          sub={
            mine
              ? `${handle === null ? 'Another account' : handle} is connected on this device, but you are signed in as someone else. Nothing was switched.`
              : 'This device already has a posting key from a previous visit. Confirm it is yours to use it here.'
          }
          egg="small"
          primary={{
            label: mine ? 'Connect my account' : "That's me",
            onClick: () => void begin(),
            disabled: working,
          }}
          quiet={{ label: 'Not now', onClick: () => onClose?.() }}
          note="Nobody is signed in differently here — this screen only decides which account Fiddy may post as."
        />
      );
    }

    if (view.name === 'stopped') {
      return (
        <FiddySheet
          name="connect-stopped"
          title="Fiddy's access is off"
          sub="Your posting key is gone. Fiddy cannot post for you until you connect again."
          egg="small"
          primary={{
            label: 'Connect again',
            onClick: () => void begin(),
            disabled: working,
          }}
          quiet={{ label: 'Done', onClick: () => onClose?.() }}
        />
      );
    }

    if (view.name === 'problem') {
      /**
       * When nothing answered at this address, the one-tap approval cannot
       * happen HERE — which is every copy of Fiddy a person runs themselves
       * (`fiddy client up`: the client is served by their own machine, and
       * Fiddy's service is not at that address). Offering only "Try again"
       * there is a dead end with a press loop in it, and the sentence the
       * composer then shows ("press Issue app key") names a control the person
       * has no way to reach from a full-screen sheet. So the failure screen
       * carries the slow path itself: it closes what it was holding and walks
       * them to their own setup, where the app key lives.
       */
      return (
        <FiddySheet
          name="connect-problem"
          title="That did not go through"
          sub={view.message}
          egg="small"
          primary={{
            label: 'Try again',
            onClick: () => void begin(),
            disabled: working,
          }}
          secondary={
            view.unreachable
              ? {
                  label: 'Open your own setup',
                  testId: 'connect-own-setup',
                  onClick: () => {
                    onClose?.();
                    // A full load rather than a router push: the sheet is a
                    // full-screen overlay, and it is also mounted by tests that
                    // have no router at all. `continueAs` above leaves the same
                    // way for the same reason.
                    window.location.replace(routes.settingsNode.path);
                  },
                }
              : null
          }
          quiet={{ label: 'Close', onClick: () => onClose?.() }}
          note={
            view.unreachable
              ? 'Nothing changed in your account. The phone approval needs the part of Fiddy that sets it up, and this copy of Fiddy does not have that at this address. Your own setup can sign for you instead. You can also post in your Farcaster app as usual.'
              : 'Nothing changed in your account. You can keep reading Farcaster here, and post in your Farcaster app as usual.'
          }
        />
      );
    }

    return (
      <FiddySheet
        name="connect-idle"
        title="Connect your Farcaster account"
        sub="Let Fiddy post for you — your posts, your replies, your likes — without a fee and without a passphrase."
        egg="hero"
        primary={{
          label: 'Connect',
          onClick: () => void begin(),
          disabled: working,
        }}
        quiet={{ label: 'Not now', onClick: () => onClose?.() }}
        note={
          view.notice ??
          'Fiddy asks your Farcaster app for a posting key. Your account, its key and its recovery phrase stay where they are.'
        }
      />
    );
  },
);

ConnectSheet.displayName = 'ConnectSheet';
