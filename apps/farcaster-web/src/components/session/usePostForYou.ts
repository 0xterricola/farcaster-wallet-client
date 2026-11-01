/**
 * The "let Fiddy post as you" offer, as the shell sees it: one decision, one
 * approval, one developer's door, and the states in between.
 *
 * The decision itself is pure and lives in `./postForYouOffer` — this file only
 * makes the observations (is this a device session, is the node adapter on and
 * a server named, does this device already hold a pass, how has the reader
 * already answered) and runs the two things the card can do: raise the phone
 * approval the rest of the product uses (`ConnectSheet`, the same sheet
 * `/connect-farcaster` shows and `SignerApprovalGate` reuses), or — behind the
 * card's collapsed developer disclosure — the recovery-phrase setup the
 * Advanced screen still ships.
 *
 * Session identity is read from the CACHED onboarding state, never from the
 * network, for the same reason `useDeviceOnlySession` does: this is asked on
 * every authed shell mount, including the ones where a read is exactly what is
 * broken, so it must not be able to fail or suspend. The same rule covers the
 * service: the approval sheet asks `/api/fiddy/connect` when it is opened, and
 * nothing here asks it at mount.
 */

import { useCachedOnboardingState } from 'farcaster-client-hooks';
import type { IssueAppKeyStep } from 'farcaster-node-client';
import { useCallback, useEffect, useState } from 'react';

import { localApiEnabled } from '~/constants/api';
import { useAuth } from '~/contexts/AuthProvider';
import { isLocalSessionToken } from '~/lib/siwfSession';
import { isNodeBackedClientEnabled } from '~/snapchain/nodeApi/nodeBackedClientFlag';
import { isNodeConfigured } from '~/snapchain/nodeChoice';
import { useNodeClient } from '~/snapchain/useNodeClient';

import {
  decidePostForYou,
  describeSetupFailure,
  type OfferAnswer,
  type PassState,
  type PostForYouDecision,
  readOfferAnswer,
  readPassState,
  rememberOfferAnswer,
  setUpPostingForYou,
} from './postForYouOffer';

/** How long the "done" line stays up before the card takes itself away. */
const DONE_LINGER_MS = 4000;

/**
 * What the card says once the offer has been answered. Two sentences, because
 * the two paths leave different things true: the phone approval holds nothing on
 * this device, and the recovery-phrase path is the one that does.
 */
const DONE_SAYING = {
  phone: 'Done — Fiddy can post for you now.',
  phrase: 'Done — Fiddy can post as you on this device.',
} as const;

type PostForYouPhase =
  | 'idle'
  | 'approving'
  | 'asking-for-phrase'
  | 'setting-up'
  | 'done'
  | 'failed';

interface PostForYou {
  decision: PostForYouDecision;
  phase: PostForYouPhase;
  /** Which step of the setup is running, in the protocol's words (mapped to plain words by the card). */
  step: IssueAppKeyStep | null;
  error: string | null;
  /** The sentence for the `done` phase, which depends on how the offer was answered. */
  doneSaying: string | null;
  /** "Set it up": raise the phone approval, asking straight away. */
  offer: () => void;
  /** The approval sheet was closed without an approval — the offer still stands. */
  declineApproval: () => void;
  /** Approved in their own Farcaster app: the offer is over, and remembered. */
  approved: () => void;
  /** The card's collapsed disclosure: the recovery-phrase step, for a test account. */
  offerPhraseStep: () => void;
  /** Close the phrase step without setting up (the account is untouched). */
  closePhraseStep: () => void;
  /** "Not now" — remembered on this device, so the offer is made once. */
  sayNotNow: () => void;
  setUp: (mnemonic: string) => Promise<void>;
}

const usePostForYou = (): PostForYou => {
  const { authToken } = useAuth();
  const user = useCachedOnboardingState().result.state.user;
  const node = useNodeClient();

  const fid = user?.fid;

  const [passState, setPassState] = useState<PassState>('unknown');
  const [offerAnswer, setOfferAnswer] = useState<OfferAnswer | undefined>(
    undefined,
  );
  const [phase, setPhase] = useState<PostForYouPhase>('idle');
  const [step, setStep] = useState<IssueAppKeyStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneSaying, setDoneSaying] = useState<string | null>(null);

  // Whether this device already holds a pass for the account. Storage is async,
  // so the offer waits for the answer instead of flashing and retracting.
  useEffect(() => {
    if (fid === undefined) {
      setPassState('unknown');
      return undefined;
    }
    let alive = true;
    readPassState(fid).then((state) => {
      if (alive) {
        setPassState(state);
      }
    });
    return () => {
      alive = false;
    };
  }, [fid]);

  // And how the reader answered the offer the last time it was made. Read from
  // storage, never from the service: a device that already answered must not be
  // asked again, and this must not be able to fail or suspend.
  useEffect(() => {
    if (fid === undefined) {
      setOfferAnswer(undefined);
      return undefined;
    }
    let alive = true;
    readOfferAnswer(fid).then((answer) => {
      if (alive) {
        setOfferAnswer(answer);
      }
    });
    return () => {
      alive = false;
    };
  }, [fid]);

  const decision = decidePostForYou({
    // The marker for "this device signed in and holds no server-side token",
    // read the same way `useDeviceOnlySession` reads it: a local token, in a
    // build where the mock API is not the thing serving the shell.
    isLocalDeviceSession:
      isLocalSessionToken(authToken) === true && !localApiEnabled,
    adapterEnabled: isNodeBackedClientEnabled(),
    nodeConfigured: isNodeConfigured(),
    fid,
    passState,
    offerAnswer,
  });

  /** "Set it up" — the approval the rest of the product asks for, asking itself. */
  const offer = useCallback(() => {
    setError(null);
    setStep(null);
    setPhase('approving');
  }, []);

  /**
   * The approval sheet was closed without an approval. The offer is NOT over and
   * nothing is remembered: the reader is back at the card, one press away, and
   * "Not now" is still the way to say no.
   */
  const declineApproval = useCallback(() => {
    setError(null);
    setStep(null);
    setPhase('idle');
  }, []);

  /**
   * The service says the posting key exists — approved in the reader's own
   * Farcaster app. The offer is answered, and it is remembered as an answer:
   * the pass lives with Fiddy's service, so nothing on this device would tell
   * the card about it after a reload.
   */
  const approved = useCallback(() => {
    setError(null);
    setStep(null);
    setDoneSaying(DONE_SAYING.phone);
    setOfferAnswer('approved');
    setPhase('done');
    if (fid !== undefined) {
      void rememberOfferAnswer(fid, 'approved');
    }
  }, [fid]);

  /** The developer's door, from inside the card's collapsed disclosure. */
  const offerPhraseStep = useCallback(() => {
    setError(null);
    setStep(null);
    setPhase('asking-for-phrase');
  }, []);

  const closePhraseStep = useCallback(() => {
    setError(null);
    setStep(null);
    setPhase('idle');
  }, []);

  const sayNotNow = useCallback(() => {
    setPhase('idle');
    setOfferAnswer('not-now');
    if (fid !== undefined) {
      void rememberOfferAnswer(fid, 'not-now');
    }
  }, [fid]);

  const setUp = useCallback(
    async (mnemonic: string) => {
      if (fid === undefined || node === undefined) {
        setError(
          'This device has no account to set this up for yet — sign in again.',
        );
        setPhase('failed');
        return;
      }

      setPhase('setting-up');
      setError(null);

      try {
        await setUpPostingForYou({
          node,
          fid,
          mnemonic,
          onStep: (nextStep) => setStep(nextStep),
        });
        setStep(null);
        setPassState('present');
        setDoneSaying(DONE_SAYING.phrase);
        setPhase('done');
      } catch (err) {
        setStep(null);
        setError(
          describeSetupFailure(
            err instanceof Error ? err.message : String(err),
          ),
        );
        setPhase('failed');
      }
    },
    [fid, node],
  );

  // The done line is the last thing this card says; it takes itself away.
  useEffect(() => {
    if (phase !== 'done') {
      return undefined;
    }
    const timer = setTimeout(() => setPhase('idle'), DONE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  return {
    decision,
    phase,
    step,
    error,
    doneSaying,
    offer,
    declineApproval,
    approved,
    offerPhraseStep,
    closePhraseStep,
    sayNotNow,
    setUp,
  };
};

export { usePostForYou };
export type { PostForYou, PostForYouPhase };
