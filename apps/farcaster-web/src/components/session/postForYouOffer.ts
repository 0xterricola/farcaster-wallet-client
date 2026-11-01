/**
 * "Let Fiddy post as you" — the one-time step, and when it is offered.
 *
 * WHY THIS EXISTS
 *
 * With the node-backed client, a signed-in account can read everything: the
 * feed, threads, profiles, channels and notifications all come from the node.
 * Writing is the exception, and it is a deliberate one: a Farcaster write is a
 * message signed by *this device*, with a pass (an "app key") the account
 * granted this browser once. MEASURED (2026-10-21, the live client, signed in,
 * no pass issued): the composer reaches `POST /v2/casts`, the adapter answers
 * `501` with a sentence that sends the reader to Advanced → their setup →
 * "Issue app key" — a screen two taps away from where the reader hit the wall,
 * in the middle of posting something.
 *
 * This module is the missing half of that sentence: the offer, made where the
 * reader is, right after sign-in, once. Nothing about *how* the pass is issued
 * changes — the same builders, the same node call, the same browser-local
 * storage as the Advanced screen (`~/pages/settingsNode`) — because a second
 * signing path is exactly what the parent card forbids.
 *
 * WHAT IT MAY AND MAY NOT SAY
 *
 * The offer is shell copy, not Advanced copy: it never names a protocol word
 * ("gasless", "signer", "scopes", "TTL", "KEY_ADD"). It says what Fiddy can do
 * with the pass and what setting it up costs — which is nothing to type: the
 * phone approval (the same `ConnectSheet` `/connect-farcaster` shows) is what
 * "Set it up" raises, and the recovery-phrase path stays where the Advanced
 * screen keeps it, behind a collapsed disclosure on the card.
 *
 * MEASURED (2026-10-22, the card before this one): the offer's own button still
 * opened `SeedPhraseWarningModal` — a blocking "⚠️ Security warning … use a TEST
 * account … enter your recovery phrase" screen — so a reader who had just signed
 * in could meet a phrase prompt two taps into the product. The offer is now the
 * phone approval, and the phrase step is a developer's door with its name on it.
 *
 * THE TWO ANSWERS THIS DEVICE REMEMBERS
 *
 * The offer is made once per account, and it is answered in one of two ways:
 * "Not now", or approving Fiddy in the person's own Farcaster app. Both are
 * recorded on the device (`readOfferAnswer` / `rememberOfferAnswer`), because
 * neither is visible from the pass check alone: after an approval the pass is
 * held by Fiddy's service, not on this device, and after a refusal there is
 * nothing to find anywhere.
 */

import {
  bytesToHex,
  generateAppKey,
  issueAppKey,
  type IssueAppKeyStep,
  type NodeSigner,
  type SnapchainNodeClient,
} from 'farcaster-node-client';
import { mnemonicToAccount } from 'viem/accounts';

import {
  loadAppKey,
  saveAppKey,
  saveAppNonce,
} from '~/snapchain/appKeyStorage';
import { getItem, setItem } from '~/utils/storageUtils';

/**
 * Whether this device already holds a pass for the account, or whether that is
 * still being read. Storage is async, so "not yet known" is a real state and
 * the offer waits for it rather than flashing.
 */
type PassState = 'unknown' | 'present' | 'absent';

/**
 * How this device has already answered the one-time offer. A separate question
 * from the pass check above: an approval leaves no key here (Fiddy's service
 * holds it) and a refusal leaves nothing anywhere.
 */
type OfferAnswer = 'unanswered' | 'not-now' | 'approved';

const ANSWER_KEY = (fid: number) => `fiddy_post_for_you_${fid}_answer`;

/**
 * The key the released build wrote when somebody pressed "Not now". Still read,
 * so a device that has already answered is never asked again; nothing writes it
 * any more.
 */
const DISMISSED_KEY = (fid: number) => `fiddy_post_for_you_${fid}_said_not_now`;

const readPassState = async (fid: number): Promise<PassState> =>
  (await loadAppKey(fid)) === null ? 'absent' : 'present';

const readOfferAnswer = async (fid: number): Promise<OfferAnswer> => {
  const written = await getItem<OfferAnswer | null>({
    key: ANSWER_KEY(fid),
    fallback: null,
  });
  if (written === 'not-now' || written === 'approved') {
    return written;
  }
  return (await getItem<boolean>({
    key: DISMISSED_KEY(fid),
    fallback: false,
  })) === true
    ? 'not-now'
    : 'unanswered';
};

const rememberOfferAnswer = async (
  fid: number,
  answer: OfferAnswer,
): Promise<void> => {
  await setItem({ key: ANSWER_KEY(fid), value: answer });
};

type PostForYouDecision =
  | { kind: 'offered'; fid: number }
  | {
      kind: 'not-offered';
      because:
        | 'a-server-can-serve-this-session'
        | 'no-server-named'
        | 'no-account-yet'
        | 'a-pass-already-exists'
        | 'already-approved'
        | 'said-not-now'
        | 'still-checking';
    };

interface DecidePostForYouInput {
  /** A session this device holds with no server-side token (see useDeviceOnlySession). */
  isLocalDeviceSession: boolean;
  /** The node adapter that answers the shell's reads and writes is on. */
  adapterEnabled: boolean;
  /** A server is actually named — by the build, or by the reader. */
  nodeConfigured: boolean;
  fid: number | undefined;
  passState: PassState;
  /** How the device already answered, or `undefined` while that read is pending. */
  offerAnswer: OfferAnswer | undefined;
}

/**
 * The whole offer decision, in one pure function so it can be pinned by tests
 * instead of only by a browser: every input is an observation the hook made,
 * and the answer names the reason it is not offering.
 */
const decidePostForYou = (input: DecidePostForYouInput): PostForYouDecision => {
  if (!input.isLocalDeviceSession) {
    return { kind: 'not-offered', because: 'a-server-can-serve-this-session' };
  }
  if (!input.adapterEnabled || !input.nodeConfigured) {
    return { kind: 'not-offered', because: 'no-server-named' };
  }
  if (input.fid === undefined) {
    return { kind: 'not-offered', because: 'no-account-yet' };
  }
  if (input.passState === 'unknown' || input.offerAnswer === undefined) {
    return { kind: 'not-offered', because: 'still-checking' };
  }
  if (input.passState === 'present') {
    return { kind: 'not-offered', because: 'a-pass-already-exists' };
  }
  // Approved in their own Farcaster app: Fiddy holds the pass for this account,
  // so there is nothing left to offer — and nothing about it to ask again.
  if (input.offerAnswer === 'approved') {
    return { kind: 'not-offered', because: 'already-approved' };
  }
  if (input.offerAnswer === 'not-now') {
    return { kind: 'not-offered', because: 'said-not-now' };
  }
  return { kind: 'offered', fid: input.fid };
};

/**
 * What the three steps are called in plain words. `IssueAppKeyStep` is the
 * protocol's vocabulary; none of it is shown.
 */
const SETUP_STEP_COPY: Record<IssueAppKeyStep, string> = {
  'reading-nonce': 'Checking what your account already has…',
  building: 'Writing the one-time permission…',
  submitting: 'Handing it to your node…',
  confirming: 'Waiting for your node to confirm it…',
  done: 'Done',
};

/**
 * A failed setup, in the reader's words. The raw reason is the fallback rather
 * than the default: it is written for whoever built the node, and the reader
 * only ever sees it when nothing more specific is true.
 */
const describeSetupFailure = (reason: string): string => {
  if (/revoke one first|gasless keys/i.test(reason)) {
    return 'This account already holds as many of these passes as it can. Remove one on the Advanced screen first, then try again.';
  }
  if (/No CSPRNG/i.test(reason)) {
    return 'This browser cannot generate a safe pass, so nothing was set up.';
  }
  if (/has not merged it after/i.test(reason)) {
    return 'Your node took the request but has not confirmed it yet. It may still go through — come back in a minute and try a post.';
  }
  if (/mnemonic|invalid.*(phrase|words)/i.test(reason)) {
    return 'Those words are not a valid account phrase. Check the spelling and the order, then try again.';
  }
  return `It did not go through: ${reason}`;
};

interface SetUpPostingForYouInput {
  node: SnapchainNodeClient;
  fid: number;
  /** The account's recovery phrase, typed into the warning modal. Never stored. */
  mnemonic: string;
  onStep?: (step: IssueAppKeyStep) => void;
  /** Test seams for the node's confirmation poll. */
  confirmIntervalMs?: number;
  confirmAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface SetUpPostingForYouResult {
  signer: NodeSigner;
}

/**
 * Issue this device its own pass for the account, through the same path the
 * Advanced screen uses: the recovery phrase is derived in the browser, the
 * request is signed locally, the node merges it, and the *pass* — never the
 * phrase — is what gets stored, per account.
 */
const setUpPostingForYou = async ({
  node,
  fid,
  mnemonic,
  onStep,
  confirmIntervalMs,
  confirmAttempts,
  sleep,
}: SetUpPostingForYouInput): Promise<SetUpPostingForYouResult> => {
  const custodyAccount = mnemonicToAccount(mnemonic);
  const appKey = await generateAppKey();

  const result = await issueAppKey({
    node,
    fid,
    appKey,
    custodyAccount,
    ...(onStep ? { onStep } : {}),
    ...(confirmIntervalMs === undefined ? {} : { confirmIntervalMs }),
    ...(confirmAttempts === undefined ? {} : { confirmAttempts }),
    ...(sleep === undefined ? {} : { sleep }),
  });

  await saveAppKey(fid, bytesToHex(appKey.privateKey));
  await saveAppNonce(fid, result.userId.nonce + 1);

  return { signer: result.signer };
};

export {
  decidePostForYou,
  describeSetupFailure,
  readOfferAnswer,
  readPassState,
  rememberOfferAnswer,
  SETUP_STEP_COPY,
  setUpPostingForYou,
};
export type {
  DecidePostForYouInput,
  OfferAnswer,
  PassState,
  PostForYouDecision,
};
