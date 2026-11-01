// @vitest-environment jsdom
/**
 * What the trial box does when it is on screen.
 *
 * The claims worth measuring are the ones a screenshot cannot make: a press on
 * an opener sends that opener (it does not just fill the field), an answer
 * replaces the input, a service that cannot answer says so in words and leaves
 * the visitor able to try again, and the box reports the reply upward exactly
 * once so the primary action can change with it.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TrialChat } from '~/components/fiddy/TrialChat';
import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { defaultFiddySetup } from '~/lib/fiddySetup';
import { loadTrialExchange, TRIAL_STARTERS } from '~/lib/trialChat';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const mount = (onAnswered = vi.fn()) => {
  render(
    <TrialChat
      agentName="Momo"
      setup={defaultFiddySetup()}
      onAnswered={onAnswered}
    />,
  );
  return onAnswered;
};

beforeEach(() => {
  installFakeStorage();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the trial box on the ready sheet', () => {
  it('asks the agent by name and offers three openers instead of a blank field', () => {
    mount();
    expect(screen.getByText('Say hi to Momo…')).toBeTruthy();
    for (const starter of TRIAL_STARTERS) {
      expect(screen.getByText(starter)).toBeTruthy();
    }
    expect(
      document
        .querySelector('[data-fiddy="trial"]')
        ?.getAttribute('data-trial'),
    ).toBe('idle');
  });

  it('sends the opener that was pressed, and shows the real reply', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, reply: 'I can watch your mentions for you.' }),
      );
    vi.stubGlobal('fetch', fetchImpl);
    const onAnswered = mount();

    fireEvent.click(screen.getByText('Watch my mentions'));

    await waitFor(() =>
      expect(
        document
          .querySelector('[data-fiddy="trial"]')
          ?.getAttribute('data-trial'),
      ).toBe('answered'),
    );
    expect(screen.getByText('Watch my mentions')).toBeTruthy();
    expect(screen.getByText('I can watch your mentions for you.')).toBeTruthy();
    // The input is gone: the one message is spent, and the screen says so.
    expect(document.querySelector('[data-trial="input"]')).toBeNull();
    expect(document.querySelector('[data-trial="starters"]')).toBeNull();
    expect(
      JSON.parse(
        String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body),
      ),
    ).toMatchObject({
      message: 'Watch my mentions',
      agentName: 'Momo',
    });
    expect(onAnswered).toHaveBeenCalledTimes(1);
    expect(loadTrialExchange()?.reply).toBe(
      'I can watch your mentions for you.',
    );
  });

  it('says the trial is not open in words, and leaves the visitor another try', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          code: 'TRIAL_NOT_OPEN',
          message:
            'The live trial is not open on this service yet. Sign in and your first message goes straight to your agent.',
        },
        503,
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const onAnswered = mount();

    fireEvent.change(screen.getByPlaceholderText('Type a short message…'), {
      target: { value: 'hi' },
    });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() =>
      expect(
        document.querySelector('[data-trial="refusal"]')?.textContent,
      ).toContain('not open on this service yet'),
    );
    // No invented reply anywhere on the screen.
    expect(document.querySelector('[data-trial="reply"]')).toBeNull();
    expect(document.querySelector('[data-trial="input"]')).toBeTruthy();
    expect(onAnswered).not.toHaveBeenCalled();
  });

  it('does not answer twice: a second press while one is in flight is ignored', async () => {
    const deferred: { resolve?: (value: Response) => void } = {};
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          deferred.resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    mount();

    fireEvent.click(screen.getByText(TRIAL_STARTERS[0]));
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-fiddy="trial"]')
          ?.getAttribute('data-trial'),
      ).toBe('sending'),
    );
    fireEvent.click(screen.getByText(TRIAL_STARTERS[1]));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    deferred.resolve?.(jsonResponse({ ok: true, reply: 'Here.' }));
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-fiddy="trial"]')
          ?.getAttribute('data-trial'),
      ).toBe('answered'),
    );
  });

  it('shows the exchange a previous visit already made, and says the message is used', () => {
    window.localStorage.setItem(
      'fiddy.trial',
      JSON.stringify({
        agentName: 'Momo',
        message: 'Draft a morning intro cast',
        reply: 'Here is one.',
        note: null,
        at: Date.now(),
      }),
    );
    const onAnswered = mount();

    expect(screen.getByText('Here is one.')).toBeTruthy();
    expect(
      document.querySelector('[data-trial="budget"]')?.textContent,
    ).toContain('your one free message');
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });
});
