/**
 * The first thing you say to the agent you just named.
 *
 * This is the one warm moment in the way in, and it is deliberately small: one
 * line of prompt, one input, three openers you can press instead of typing, and
 * one real reply. Everything it shows comes from `~/lib/trialChat`, which asks
 * the service on this origin — so there is no key in the page and no cross-origin
 * request to explain away.
 *
 * THREE STATES, AND NONE OF THEM LIE:
 *   idle     the input and the openers; the count says one message is free;
 *   sending  the button says so and takes no second press;
 *   answered the message and the reply, in the order they happened.
 * A fourth outcome — no brain could be reached — renders the server's own
 * sentence in place of a reply. Nothing here ever types out a canned answer: a
 * fake "hello!" is the one thing an onboarding cannot do, because the visitor
 * finds out on their second message.
 *
 * WHY THE OPENERS ARE PRESSES AND NOT TEXT: a visitor who has never used an AI
 * agent does not know what to ask one, and the first message is the whole point
 * of this screen. Pressing one sends it — a chip that only fills the field
 * spends the visitor's one turn on a second press.
 */

import { Send } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import type { FiddySetup } from '~/lib/fiddySetup';
import {
  askTrialAgent,
  loadTrialState,
  TRIAL_MESSAGE_MAX,
  TRIAL_STARTERS,
  TrialExchange,
  TrialUnavailableError,
} from '~/lib/trialChat';

export interface TrialChatProps {
  agentName: string;
  setup: FiddySetup;
  /** Fired when a real reply lands, so the primary action can answer to it. */
  onAnswered?: (exchange: TrialExchange) => void;
}

/** What the server said about the brain, in the visitor's words. */
const NOTE_LINES: Record<string, string> = {
  BRAIN_NEEDS_SIGN_IN:
    'The trial runs on Fiddy’s own brain — the one you picked takes over after sign-in.',
  KEY_REFUSED:
    'The key from step 1 was not accepted, so Fiddy’s own brain answered. Yours takes over after sign-in.',
  PAYMENT_REQUIRED:
    'That service wanted paying before it answered, so Fiddy’s own brain answered.',
  BRAIN_UNAVAILABLE:
    'That service could not be reached, so Fiddy’s own brain answered.',
};

type Status = 'idle' | 'sending' | 'answered' | 'blocked';

export const TrialChat = ({ agentName, setup, onAnswered }: TrialChatProps) => {
  const [turnsLeft, setTurnsLeft] = useState(
    () => loadTrialState().turns === 0,
  );
  const [exchange, setExchange] = useState<TrialExchange | null>(
    () => loadTrialState().exchange,
  );
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<Status>(() =>
    loadTrialState().exchange ? 'answered' : 'idle',
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const answeredOnce = useRef(false);

  // A reply that is already in storage has already been announced: it was shown
  // to this visitor on the screen they are still looking at.
  useEffect(() => {
    if (exchange && !answeredOnce.current) {
      answeredOnce.current = true;
      onAnswered?.(exchange);
    }
  }, [exchange, onAnswered]);

  const send = async (message: string) => {
    if (status === 'sending' || !turnsLeft) {
      return;
    }
    setStatus('sending');
    setRefusal(null);
    setPending(message.trim());
    try {
      const result = await askTrialAgent({ message, agentName, setup });
      setExchange(result);
      setTurnsLeft(false);
      setStatus('answered');
      answeredOnce.current = true;
      onAnswered?.(result);
    } catch (error) {
      const line =
        error instanceof TrialUnavailableError
          ? error.ownerLine
          : 'The trial could not answer just now. Signing in still works.';
      // A turn the server refused for a reason the visitor can fix (a used-up
      // budget) does not leave them able to try again; anything else does not
      // spend their one message.
      if (error instanceof TrialUnavailableError && error.code === 'BUSY') {
        setTurnsLeft(false);
      }
      setRefusal(line);
      setStatus('blocked');
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="fiddy-trial" data-fiddy="trial" data-trial={status}>
      <label className="fiddy-trial-label" htmlFor="fiddy-trial-input">
        Say hi to {agentName}…
      </label>

      {status === 'answered' && exchange ? (
        <div className="fiddy-trial-thread">
          <p
            className="fiddy-trial-bubble fiddy-trial-bubble-me"
            data-trial="message"
          >
            {exchange.message}
          </p>
          <p
            className="fiddy-trial-bubble fiddy-trial-bubble-agent"
            data-trial="reply"
            aria-live="polite"
          >
            {exchange.reply}
          </p>
          {exchange.note && NOTE_LINES[exchange.note] ? (
            <p className="fiddy-trial-note" data-trial="note">
              {NOTE_LINES[exchange.note]}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="fiddy-trial-row">
            <input
              id="fiddy-trial-input"
              ref={inputRef}
              className="fiddy-input"
              type="text"
              data-trial="input"
              autoComplete="off"
              spellCheck={false}
              maxLength={TRIAL_MESSAGE_MAX}
              placeholder="Type a short message…"
              value={draft}
              disabled={status === 'sending' || !turnsLeft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && draft.trim()) {
                  void send(draft);
                }
              }}
            />
            <button
              type="button"
              className="fiddy-trial-send"
              data-trial="send"
              disabled={status === 'sending' || !draft.trim() || !turnsLeft}
              onClick={() => void send(draft)}
            >
              <Send aria-hidden="true" />
              <span>{status === 'sending' ? 'Sending…' : 'Send'}</span>
            </button>
          </div>

          {status === 'sending' && pending ? (
            <p className="fiddy-trial-note" data-trial="pending">
              Sent “{pending}” — {agentName} is answering.
            </p>
          ) : null}
        </>
      )}

      {status !== 'answered' && turnsLeft ? (
        <div className="fiddy-trial-starters" data-trial="starters">
          {TRIAL_STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              className="fiddy-trial-chip"
              data-trial-starter={starter}
              disabled={status === 'sending'}
              onClick={() => void send(starter)}
            >
              {starter}
            </button>
          ))}
        </div>
      ) : null}

      {refusal ? (
        <p
          className="fiddy-trial-note fiddy-trial-refusal"
          data-trial="refusal"
          role="status"
        >
          {refusal}
        </p>
      ) : null}

      <p className="fiddy-trial-note" data-trial="budget">
        {status === 'answered'
          ? 'That was your one free message. Everything after this goes to your own agent.'
          : turnsLeft
            ? `One free message — ${agentName} answers this one for real. Nothing is posted, and no account is needed yet.`
            : 'Your one free message is used. Sign in and keep talking to your agent.'}
      </p>
    </section>
  );
};
