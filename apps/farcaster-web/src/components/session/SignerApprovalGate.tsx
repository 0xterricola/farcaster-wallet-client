/**
 * "Let Fiddy post for you?" — the screen that goes up where the person is.
 *
 * WHAT THIS IS
 *
 * The write seam (`~/snapchain/nodeApi/nodeWrites`) holds a like, a recast, a
 * follow or a cast that has no posting key to sign it, and hands it to
 * `~/snapchain/accounts/postingKeyApproval`. That store raises this component,
 * which is the whole visible half:
 *
 *   asking     the approval sheet, already asking — the same `ConnectSheet`
 *              `/connect-farcaster` shows, with `autoStart` so there is no
 *              second press: a link, a code to scan, and a screen that notices
 *              the approval by itself;
 *   finishing  one sentence, while the write that was waiting is carried;
 *   nothing    when nothing is waiting, which is almost always.
 *
 * The reader therefore never leaves the thing they were doing, never types a
 * recovery phrase, and never presses the heart twice: approving the sheet is
 * what makes their like go out.
 *
 * WHY IT TAKES THE WHOLE SCREEN
 *
 * It is mounted in the signed-in shell (`~/layouts/AuthedLayout`), over whatever
 * the person was looking at. A like is a small thing to ask for, but the
 * approval is not: it happens in their own Farcaster app, it is the moment they
 * hand a posting key over, and it deserves the same screen the rest of the
 * product uses for that decision rather than a toast in a corner.
 *
 * COPY: one word this product bans is the protocol's word for what it holds
 * ("signer"); what the person grants is "a posting key", and what it does is
 * "post for you". The labels the seam hands over (`like`, `recast`, `follow`,
 * `post`) are already in the person's own vocabulary, and the sentences below
 * are built only from those.
 */

import React, { memo, useCallback, useSyncExternalStore } from 'react';

import { ConnectSheet } from '~/components/fiddy/accounts/ConnectSheet';
import { postingKeyApproval } from '~/snapchain/accounts/postingKeyApproval';
import type { WriteApprovalLabel } from '~/snapchain/nodeApi/nodeWrites';

/**
 * What happens, once they approve — said on the waiting screen, so the person
 * knows the thing they asked for is what will happen and that they do not have
 * to come back to this browser tab to press anything.
 */
const AFTER_APPROVAL: Record<WriteApprovalLabel, string> = {
  like: 'Your like goes out by itself — there is nothing to press when you come back.',
  recast:
    'Your recast goes out by itself — there is nothing to press when you come back.',
  follow:
    'The follow goes out by itself — there is nothing to press when you come back.',
  post: 'Your post goes out by itself — there is nothing to press when you come back.',
  change:
    'The change goes out by itself — there is nothing to press when you come back.',
};

/** One line, while the write that was waiting is being carried out. */
const FINISHING: Record<WriteApprovalLabel, string> = {
  like: 'Approved — your like is going out.',
  recast: 'Approved — your recast is going out.',
  follow: 'Approved — the follow is going out.',
  post: 'Approved — your post is going out.',
  change: 'Approved — the change is going out.',
};

const CARD_CLASS =
  'fixed bottom-20 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border p-4 shadow-xl bg-app border-default sm:bottom-6';

const SignerApprovalGate = memo(() => {
  const state = useSyncExternalStore(
    postingKeyApproval.subscribe,
    postingKeyApproval.getState,
    postingKeyApproval.getState,
  );

  const approved = useCallback(() => postingKeyApproval.approved(), []);
  const declined = useCallback(() => postingKeyApproval.declined(), []);

  if (state.pending === null) {
    return null;
  }

  const { label } = state.pending;

  if (state.phase === 'finishing') {
    return (
      <aside
        aria-label="Let Fiddy post for you"
        data-fiddy="signer-approval-finishing"
        className={CARD_CLASS}
        role="status"
      >
        <p className="text-sm text-primary" data-fiddy="signer-approval-done">
          {FINISHING[label] ?? FINISHING.change}
        </p>
      </aside>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-app"
      data-fiddy="signer-approval-gate"
    >
      {/* The approval itself: the same sheet `/connect-farcaster` shows, asking
          without its first screen, and answering this component rather than
          signing the person in — the write that was waiting is what continues. */}
      <ConnectSheet
        autoStart
        completing={AFTER_APPROVAL[label] ?? AFTER_APPROVAL.change}
        onApproved={approved}
        onClose={declined}
      />
    </div>
  );
});

SignerApprovalGate.displayName = 'SignerApprovalGate';

export { SignerApprovalGate };
