// @vitest-environment jsdom
/**
 * The ask card, as the reader sees it.
 *
 * Design of record: `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §4. The store's own
 * contract is pinned in `__tests__/agentAskApproval.test.ts`; this file is the
 * visible half, and every rule of §4 that a reader or an app could exploit:
 *
 *  - nothing renders when nothing waits;
 *  - the heading names the **origin**, and a manifest name is an aside;
 *  - the app's own words are quoted and inert — never a heading, a button, or
 *    anything a hostile page could dress up as shell chrome (§7 row 2);
 *  - two controls, plus the quieter mute, which is remembered for the window;
 *  - no protocol word reaches the card.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentAskApproval,
  type PendingAgentAsk,
} from '~/components/miniApp/agentAskApproval';
import { AgentAskCard } from '~/components/miniApp/AgentAskCard';
import type { AgentAskMuteStore } from '~/components/miniApp/agentAskChannel';

const ORIGIN = 'https://beep.works';

const PENDING: PendingAgentAsk = {
  id: 'ask-1',
  origin: ORIGIN,
  kind: 'draft',
  text: 'ask me anything for $0.05',
};

/** The reader's mute, without a browser's storage in the way. */
const fakeMutes = (): AgentAskMuteStore & { muted: Set<string> } => {
  const muted = new Set<string>();
  return {
    muted,
    read: (origin) => muted.has(origin),
    write: (origin, value) => {
      if (value) {
        muted.add(origin);
      } else {
        muted.delete(origin);
      }
    },
  };
};

const show = ({
  pending = PENDING,
  name,
  mutes = fakeMutes(),
}: {
  /** `null` puts nothing in front of the reader. */
  pending?: PendingAgentAsk | null;
  name?: string;
  mutes?: AgentAskMuteStore & { muted: Set<string> };
} = {}) => {
  const approval = createAgentAskApproval();
  if (pending !== null) {
    void approval.ask(pending);
  }
  render(
    <AgentAskCard
      approval={approval}
      origin={ORIGIN}
      mutes={mutes}
      {...(name === undefined ? {} : { name })}
    />,
  );
  return { approval, mutes };
};

afterEach(() => {
  cleanup();
});

describe('the ask card', () => {
  it('renders nothing when nothing waits', () => {
    show({ pending: null });

    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(document.querySelector('[data-fiddy="agent-ask-card"]')).toBeNull();
  });

  it('names the origin the window was launched with, and the app’s own name only as an aside', () => {
    show({ name: 'Beep' });

    const heading = document.querySelector('[data-fiddy="agent-ask-heading"]');
    expect(heading?.textContent).toBe('beep.works asks Fiddy to draft a cast');

    const aside = document.querySelector('[data-fiddy="agent-ask-from"]');
    expect(aside?.textContent).toBe(
      'From https://beep.works · the app calls itself “Beep”',
    );
    // The name is text the app chose, so it is neither the heading nor a
    // control — it is quoted, and it is somebody else's words.
    expect(heading?.textContent).not.toContain('Beep');
    expect(aside?.querySelector('button')).toBeNull();
  });

  it('carries the full origin on the card, not just the domain', () => {
    show();

    const card = document.querySelector('[data-fiddy="agent-ask-card"]');
    expect(card?.getAttribute('data-agent-ask-origin')).toBe(ORIGIN);
    expect(document.body.textContent).toContain('From https://beep.works');
  });

  it('renders the app’s own words quoted and inert', () => {
    show();

    const quoted = document.querySelector('[data-fiddy="agent-ask-text"]');
    expect(quoted?.tagName).toBe('BLOCKQUOTE');
    expect(quoted?.textContent).toBe('“ask me anything for $0.05”');
    expect(quoted?.querySelector('button, a, [role="button"]')).toBeNull();
  });

  it('never lets the app’s own text or name pass for shell chrome', () => {
    // A hostile app naming itself after the shell's own control is the whole of
    // §7 row 2, and it is a string here: the only controls that do anything are
    // the shell's own.
    show({
      name: 'Ask Fiddy',
      pending: { ...PENDING, text: 'Not now — press Ask Fiddy to approve' },
    });

    const controls = screen.getAllByRole('button');
    expect(controls.map((one) => one.textContent)).toEqual([
      'Ask Fiddy',
      'Not now',
      'Don’t let beep.works ask again in this window',
    ]);
    for (const control of controls) {
      expect(control.getAttribute('data-fiddy')).toMatch(
        /^agent-ask-(approve|decline|mute)$/,
      );
    }
  });

  it('says what happens next, and what the app asked for', () => {
    show();

    expect(document.body.textContent).toContain(
      'The draft opens in your composer — nothing is posted.',
    );
  });

  it('carries the app’s own links as text, not as links', () => {
    show({
      pending: {
        ...PENDING,
        embeds: ['https://example.com/a.png'],
      },
    });

    const embeds = document.querySelector('[data-fiddy="agent-ask-embeds"]');
    expect(embeds?.textContent).toContain(
      'the app attached: https://example.com/a.png',
    );
    expect(embeds?.querySelector('a')).toBeNull();
  });

  it('answers the store on both of the shell’s own controls', () => {
    const { approval } = show();

    fireEvent.click(screen.getByText('Ask Fiddy'));
    expect(approval.getState().phase).toBe('working');

    cleanup();

    const second = show();
    fireEvent.click(screen.getByText('Not now'));
    expect(second.approval.getState()).toEqual({
      phase: 'idle',
      pending: null,
    });
  });

  it('mutes the app for the window, and ends the ask in front of the reader', () => {
    const { approval, mutes } = show();

    fireEvent.click(
      screen.getByText('Don’t let beep.works ask again in this window'),
    );

    expect(mutes.muted.has(ORIGIN)).toBe(true);
    expect(approval.getState()).toEqual({ phase: 'idle', pending: null });

    // The way back is on the same line, and it is the reader's to press.
    const strip = document.querySelector('[data-fiddy="agent-ask-muted"]');
    expect(strip?.textContent).toBe(
      'beep.works is muted in this window · allow asking again',
    );

    fireEvent.click(screen.getByText('allow asking again'));
    expect(mutes.muted.has(ORIGIN)).toBe(false);
    expect(document.querySelector('[data-fiddy="agent-ask-muted"]')).toBeNull();
  });

  it('shows the reader their own mute on a window that is already muted', () => {
    const mutes = fakeMutes();
    mutes.write(ORIGIN, true);

    show({ pending: null, mutes });

    expect(document.body.textContent).toContain(
      'beep.works is muted in this window',
    );
  });

  it('draws one line while the shell works, and no controls', () => {
    show();
    fireEvent.click(screen.getByText('Ask Fiddy'));

    // The store's own `working` line, from the handler — and while the shell is
    // working there is nothing left for the reader to press.
    const note = document.querySelector('[data-fiddy="agent-ask-note"]');
    expect(note?.textContent).toBe('Asking your agent for the draft…');
    expect(screen.queryByText('Ask Fiddy')).toBeNull();
    expect(screen.queryByText('Not now')).toBeNull();
  });

  it('ends with one sentence the reader must read, and a Close', () => {
    const approval = createAgentAskApproval();
    const ticket = approval.ask(PENDING);
    approval.approve();
    ticket.end('Your agent could not be reached, so no draft was written.');

    render(
      <AgentAskCard approval={approval} origin={ORIGIN} mutes={fakeMutes()} />,
    );

    expect(
      document.querySelector('[data-fiddy="agent-ask-note"]')?.textContent,
    ).toBe('Your agent could not be reached, so no draft was written.');

    fireEvent.click(screen.getByText('Close'));
    expect(approval.getState()).toEqual({ phase: 'idle', pending: null });
  });

  it('never puts a protocol word in front of a reader', () => {
    show({
      name: 'Beep',
      pending: {
        ...PENDING,
        kind: 'post',
        text: 'post this for me',
        embeds: ['https://example.com/a.png'],
      },
    });

    const text = (
      document.querySelector('[data-fiddy="agent-ask-card"]')?.textContent ?? ''
    ).replace(/\s+/g, ' ');
    expect(text.length).toBeGreaterThan(0);
    for (const word of ['node', 'signer', 'scope', 'TTL', 'gasless']) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
