/**
 * "Let Fiddy post as you?" — the one-time offer, made where the reader is.
 *
 * MEASURED (2026-10-21, the live client, signed in, before this card): pressing
 * Cast without a pass answers with a sentence that sends the reader to
 * Advanced → their setup → "Issue app key". That is true and it stays true; it
 * is just not where a reader is standing when they find out.
 *
 * This card is that sentence, offered once, in the shell, right after sign-in,
 * with the setup one press away:
 *
 *   - it says what Fiddy may do with the pass (post, reply, like, follow) and
 *     what stays put ("your account, its key and its recovery phrase stay where
 *     they are") — in plain words, no protocol vocabulary;
 *   - "Set it up" raises the phone approval: `ConnectSheet`, the same sheet
 *     `/connect-farcaster` shows and `SignerApprovalGate` reuses, mounted with
 *     `autoStart` so it is asking from the first frame (a link, a code to scan,
 *     and a screen that notices the approval by itself). Nothing is typed and
 *     nothing is held on this device;
 *   - approving in their own Farcaster app ends the offer, and the device
 *     remembers it (`rememberOfferAnswer`), so it is not made again;
 *   - "Not now" is remembered the same way;
 *   - the recovery-phrase step is still here, where the Advanced screen keeps
 *     it: behind a collapsed, explicitly developer-shaped disclosure, with the
 *     blocking `SeedPhraseWarningModal` unchanged behind that.
 *
 * MEASURED (2026-10-22, before this card): "Set it up" opened that phrase
 * warning directly — a normal reader could meet a "⚠️ Security warning … enter
 * your recovery phrase" screen two taps after signing in, even though the
 * posting flow itself had already stopped doing that.
 *
 * It renders nothing at all when the offer does not apply — a session a server
 * can serve, no server named, an account this device already has a pass for, or
 * one that has already answered (either way).
 */

import React, { FC, lazy, memo, Suspense, useState } from 'react';

import { ConnectSheet } from '~/components/fiddy/accounts/ConnectSheet';

import { SETUP_STEP_COPY } from './postForYouOffer';
import { usePostForYou } from './usePostForYou';

/**
 * The warning + phrase step is Advanced's own screen, and the repository's lint
 * rule is that page components are reached lazily (`~/pages/*` may not be
 * imported statically) — which is also the right shape here: a reader who never
 * opens the developer disclosure never downloads it.
 */
const SeedPhraseWarningModal = lazy(async () => {
  const module =
    await import('~/pages/settingsNode/Component/SeedPhraseWarningModal');
  return { default: module.SeedPhraseWarningModal };
});

const CARD_CLASS =
  'fixed bottom-20 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border p-4 shadow-xl bg-app border-default sm:bottom-6';

const PostForYouStep: FC = memo(() => {
  const {
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
  } = usePostForYou();

  /**
   * The developer's door is collapsed by default and is the reader's own
   * toggle: a normal reader never meets a phrase prompt, and whoever needs the
   * test-account path finds it by its own name.
   */
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const cardIsUp = decision.kind === 'offered' || phase !== 'idle';

  if (!cardIsUp) {
    return null;
  }

  return (
    <aside aria-label="Let Fiddy post as you" data-fiddy="post-for-you">
      {phase === 'idle' && decision.kind === 'offered' ? (
        <div className={CARD_CLASS}>
          <h2
            id="fiddy-post-for-you-heading"
            className="mb-2 text-base font-bold text-primary"
          >
            Let Fiddy post as you?
          </h2>
          <div className="mb-3 text-sm text-primary">
            <p className="mb-2">
              Fiddy can post, reply, like and follow for you. Approving takes
              one tap in your own Farcaster app, on your phone — no fee, and
              nothing to type.
            </p>
            <p className="text-muted">
              Your account, its key and its recovery phrase stay where they are.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={offer}
              data-fiddy="post-for-you-set-up"
              className="rounded border px-3 py-1.5 text-sm font-semibold text-primary bg-tertiary border-default"
            >
              Set it up
            </button>
            <button
              type="button"
              onClick={sayNotNow}
              data-fiddy="post-for-you-not-now"
              className="rounded px-3 py-1.5 text-sm text-muted"
            >
              Not now
            </button>
          </div>

          {/* The phrase step, where the Advanced screen keeps it: collapsed, and
              labelled as what it is — a developer's path for a test account. */}
          <details
            className="mt-3 border-t pt-2 border-default"
            data-fiddy="post-for-you-advanced"
            open={advancedOpen}
            onToggle={(event) =>
              setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)
            }
          >
            <summary className="cursor-pointer text-xs text-muted">
              Advanced: test account recovery phrase (developers only)
            </summary>
            <p className="mb-2 mt-2 text-xs text-muted">
              This path asks for your account&rsquo;s recovery phrase, signs one
              approval with it in this browser tab, and keeps the key it makes
              on this device. Use a test account, never your main one. If you
              only want Fiddy to post for you, use &ldquo;Set it up&rdquo; above
              — it needs neither.
            </p>
            <button
              type="button"
              onClick={offerPhraseStep}
              data-fiddy="post-for-you-phrase"
              className="rounded border px-3 py-1.5 text-xs text-muted border-default"
            >
              Use a test account&rsquo;s recovery phrase
            </button>
          </details>
        </div>
      ) : null}

      {phase === 'setting-up' ? (
        <div className={CARD_CLASS} role="status">
          <p className="text-sm text-primary" data-fiddy="post-for-you-step">
            {step === null
              ? 'Setting this up…'
              : (SETUP_STEP_COPY[step] ?? 'Setting this up…')}
          </p>
        </div>
      ) : null}

      {phase === 'done' ? (
        <div className={CARD_CLASS} role="status">
          <p className="text-sm text-primary" data-fiddy="post-for-you-done">
            {doneSaying ?? 'Done.'}
          </p>
        </div>
      ) : null}

      {phase === 'failed' ? (
        <div className={CARD_CLASS}>
          <h2 className="mb-2 text-base font-bold text-danger">
            That didn&rsquo;t go through
          </h2>
          <p
            className="mb-3 text-sm text-primary"
            data-fiddy="post-for-you-error"
          >
            {error}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={offerPhraseStep}
              className="rounded border px-3 py-1.5 text-sm font-semibold text-primary bg-tertiary border-default"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={closePhraseStep}
              className="rounded px-3 py-1.5 text-sm text-muted"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      {/* The approval itself: the sheet `/connect-farcaster` shows, asking from
          the first frame because the reader pressed "Set it up" to do exactly
          this. It answers this card rather than signing anybody in
          (`onApproved`), and nothing is being carried — there is no write in
          flight here, only the offer being answered. */}
      {phase === 'approving' ? (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-app"
          data-fiddy="post-for-you-approval"
        >
          <ConnectSheet
            autoStart
            onApproved={approved}
            onClose={declineApproval}
          />
        </div>
      ) : null}

      {/* The warning and the phrase step are Advanced's own screen, unchanged:
          acknowledged by checkbox, not dismissible by accident, phrase cleared
          on close. */}
      {phase === 'asking-for-phrase' ? (
        <Suspense fallback={null}>
          <SeedPhraseWarningModal
            onClose={closePhraseStep}
            onConfirm={setUp}
            loading={false}
          />
        </Suspense>
      ) : null}
    </aside>
  );
});

PostForYouStep.displayName = 'PostForYouStep';

export { PostForYouStep };
