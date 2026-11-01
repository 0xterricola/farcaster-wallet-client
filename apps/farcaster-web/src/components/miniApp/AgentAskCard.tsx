/**
 * The ask card: what a mini app asked this reader's agent for, and the reader's
 * own two controls.
 *
 * Design of record: `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §4 (where the card
 * lives and every rule of the card itself) and §6 (the honest end). It is drawn
 * by the shell, inside the mini app window's own tree, over the app's
 * cross-origin frame — the same place `ComposeCastModal` already renders
 * (`MiniApp.tsx`), and deliberately not a corner toast (the posting-key card is
 * `fixed bottom-20 right-4` and the mini app window is `fixed bottom-4`: the
 * same corner) and not the agent rail (which only renders on the home feed).
 *
 * THE RULES THIS CARD IS BUILT TO
 *
 * - **The heading names the origin the window was launched with.** That is the
 *   only name the shell can verify; a manifest name is text the app chose, so it
 *   appears as an aside, quoted, and never as the heading or on a control.
 * - **The app's own words are quoted and inert.** They are text in a block that
 *   does nothing: not a heading, not a button, not a link, and nothing that
 *   could pass for shell chrome. A hostile app drawing "Approve" in its own
 *   frame is §7 row 2; this card is the opposite half of it, and a name like
 *   "Ask Fiddy" is a string, not a control.
 * - **Two controls, and the quieter third.** `Ask Fiddy` and `Not now` are the
 *   decision; the mute is the footer line, and it is remembered for the
 *   window's life, keyed by the origin (§4).
 * - **The copy says what happens next**, in the product's own words: no "node",
 *   no "signer", no "scope", no "TTL", no "gasless" — what the reader grants
 *   stays "a posting key" / "post for you" (§3.3, §6).
 * - **Nothing when nothing waits**, which is almost always.
 */

import React, { memo, useCallback, useEffect, useState } from 'react';

import type {
  AgentAskApproval,
  AgentAskApprovalState,
  PendingAgentAsk,
} from '~/components/miniApp/agentAskApproval';
import type { AgentAskMuteStore } from '~/components/miniApp/agentAskChannel';

/** The heading's verb, per ask — what the app is asking Fiddy for. */
const ASK_HEADING: Record<PendingAgentAsk['kind'], string> = {
  draft: 'draft a cast',
  post: 'post a cast',
  remind: 'send a reminder',
};

/**
 * What happens next, on the card, before the reader decides. §4's own words:
 * the draft opens in your composer / you approve the post next / your agent
 * will get this as a message.
 */
const ASK_NEXT: Record<PendingAgentAsk['kind'], string> = {
  draft: 'The draft opens in your composer — nothing is posted.',
  post: 'You approve the post next, in Fiddy’s own composer.',
  remind: 'Your agent will get this as a message.',
};

/** The one line while the shell is doing the thing the reader approved. */
const ASK_WORKING: Record<PendingAgentAsk['kind'], string> = {
  draft: 'Asking your agent for the draft…',
  post: 'Your composer is open — press Cast when the words are right.',
  remind: 'Asking your agent…',
};

/** The host of an origin, which is what a person reads and what the mute says. */
export const askDomain = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

type AgentAskCardProps = {
  /** The store the decision lives in (§4). */
  approval: AgentAskApproval;
  /** The origin the window on screen was launched with, when there is one. */
  origin: string | undefined;
  /** The app's manifest name, as the shell read it — an aside, never the heading. */
  name?: string;
  /** Where the reader's mute lives (session storage, keyed by origin). */
  mutes: AgentAskMuteStore;
};

const CARD_CLASS =
  'absolute inset-x-0 bottom-0 z-30 m-3 rounded-xl border bg-app border-default p-4 shadow-2xl';

const AgentAskCard = memo(
  ({ approval, origin, name, mutes }: AgentAskCardProps) => {
    const [state, setState] = useState<AgentAskApprovalState>(() =>
      approval.getState(),
    );
    const [muted, setMuted] = useState<boolean>(() =>
      origin === undefined ? false : mutes.read(origin),
    );

    useEffect(
      () => approval.subscribe(() => setState(approval.getState())),
      [approval],
    );

    // A new window is a new app: the mute is the reader's, keyed by origin, and
    // what the card shows has to follow the origin on screen (§7 row 10).
    useEffect(() => {
      setMuted(origin === undefined ? false : mutes.read(origin));
    }, [mutes, origin]);

    const approve = useCallback(() => approval.approve(), [approval]);
    const decline = useCallback(() => approval.decline(), [approval]);
    const close = useCallback(() => approval.close(), [approval]);

    const mute = useCallback(() => {
      if (origin === undefined) {
        return;
      }
      mutes.write(origin, true);
      setMuted(true);
      // Muting is also a "not now" for the ask in front of the reader: the
      // sentence it ends in is the honest one, and no later ask from this
      // window raises anything at all (§4).
      approval.decline();
    }, [approval, mutes, origin]);

    const unmute = useCallback(() => {
      if (origin === undefined) {
        return;
      }
      mutes.write(origin, false);
      setMuted(false);
    }, [mutes, origin]);

    if (origin === undefined) {
      return null;
    }

    const domain = askDomain(origin);

    if (state.pending === null) {
      // Nothing is waiting. The one thing that can still be on screen is the
      // reader's own mute, with the way back — a line, not a card (§4).
      if (!muted) {
        return null;
      }
      return (
        <p
          className="absolute inset-x-0 bottom-0 z-30 m-3 rounded-lg border px-3 py-2 text-sm bg-app border-default text-tertiary"
          data-fiddy="agent-ask-muted"
        >
          {`${domain} is muted in this window · `}
          <button
            type="button"
            className="underline"
            data-fiddy="agent-ask-unmute"
            onClick={unmute}
          >
            allow asking again
          </button>
        </p>
      );
    }

    const { pending, phase, note } = state;
    const heading = `${domain} asks Fiddy to ${ASK_HEADING[pending.kind]}`;
    const next = ASK_NEXT[pending.kind];

    return (
      <aside
        aria-label={heading}
        className={CARD_CLASS}
        data-fiddy="agent-ask-card"
        data-agent-ask-origin={origin}
      >
        <h2
          className="text-base font-semibold text-primary"
          data-fiddy="agent-ask-heading"
        >
          {heading}
        </h2>

        <p className="mt-1 text-xs text-tertiary" data-fiddy="agent-ask-from">
          {`From ${origin}`}
          {name !== undefined && name.length > 0
            ? ` · the app calls itself “${name}”`
            : ''}
        </p>

        {/*
          The app's own words: quoted, verbatim, and inert. A blockquote with no
          handler, no link and no role that reads as a control — the app can put
          anything in here and all it can ever be is something the reader reads.
        */}
        <blockquote
          className="mt-3 rounded-lg border px-3 py-2 text-sm text-secondary bg-faint border-default"
          data-fiddy="agent-ask-text"
        >
          {`“${pending.text}”`}
        </blockquote>

        {pending.embeds !== undefined && pending.embeds.length > 0 && (
          <ul className="mt-2 space-y-1" data-fiddy="agent-ask-embeds">
            {pending.embeds.map((embed) => (
              <li key={embed} className="truncate text-xs text-tertiary">
                {`the app attached: ${embed}`}
              </li>
            ))}
          </ul>
        )}

        {phase === 'asking' && (
          <>
            <p
              className="mt-3 text-sm text-secondary"
              data-fiddy="agent-ask-next"
            >
              {next}
            </p>
            <div className="mt-3 flex flex-row items-center gap-2">
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-sm font-medium text-primary bg-app border-default"
                data-fiddy="agent-ask-approve"
                onClick={approve}
              >
                Ask Fiddy
              </button>
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-sm text-secondary"
                data-fiddy="agent-ask-decline"
                onClick={decline}
              >
                Not now
              </button>
            </div>
            <button
              type="button"
              className="mt-3 block text-xs underline text-tertiary"
              data-fiddy="agent-ask-mute"
              onClick={mute}
            >
              {`Don’t let ${domain} ask again in this window`}
            </button>
          </>
        )}

        {(phase === 'working' || phase === 'ended') && (
          <div className="mt-3" role="status">
            <p className="text-sm text-secondary" data-fiddy="agent-ask-note">
              {note ?? ASK_WORKING[pending.kind]}
            </p>
            {phase === 'ended' && (
              <button
                type="button"
                className="mt-3 rounded-lg border px-3 py-1.5 text-sm text-primary bg-app border-default"
                data-fiddy="agent-ask-close"
                onClick={close}
              >
                Close
              </button>
            )}
          </div>
        )}
      </aside>
    );
  },
);

AgentAskCard.displayName = 'AgentAskCard';

export { AgentAskCard };
