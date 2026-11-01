// @vitest-environment jsdom

/**
 * The pair the reader actually meets: the hook and the top hat, over a cast in
 * another language, with the service answering as our own origin does.
 *
 * The top hat and the toggle were already shipped against `cast.translation`, a
 * field only the hosted API shape has — so on the node-backed build fiddy.fun
 * serves, no cast could ever carry one. This file holds the half that makes the
 * bar appear at all, and the three sentences it can say:
 *
 *   - `Written in Spanish` · `Translate from Spanish` — offered, because the
 *     origin answered `GET /api/translate` with `{on:true}`;
 *   - `translated from Spanish` · `Show original` — after the press;
 *   - `Show translation` — back and forth between the two texts.
 *
 * A host that cannot translate (a self-hosted copy with no service, or no model
 * key) draws NOTHING: a cast it cannot translate is a cast with no bar, never a
 * button that fails.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { ApiCast } from 'farcaster-client-data';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CastTranslationTopHat } from '~/components/casts/CastTranslationTopHat';
import { useCastTranslationDisplay } from '~/hooks/casts/useCastTranslationDisplay';
import { forgetCastTranslations } from '~/utils/castTranslationService';

const SPANISH =
  'Hoy es un gran día para construir en Farcaster, ¿qué están haciendo ustedes?';
const ENGLISH =
  'Today is a great day to build on Farcaster, what are you doing?';
const TRANSLATED =
  'Today is a great day to build on Farcaster, what are you up to?';
const HASH = '0x1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5';

const castOf = (text: string): ApiCast =>
  ({
    hash: HASH,
    text,
    author: { fid: 3 },
  }) as unknown as ApiCast;

/** Exactly what the two render sites (`FocusedCast`, `UnfocusedCast`) draw. */
const Harness = ({ cast }: { cast: ApiCast }) => {
  const {
    displayText,
    hasTranslation,
    isTranslationPending,
    isTranslationOffered,
    isAsking,
    notice,
    offerTranslation,
    showOriginal,
    sourceLanguageName,
    toggleLabel,
    toggleTranslation,
  } = useCastTranslationDisplay(cast);

  return (
    <div>
      {(hasTranslation || isTranslationPending || isTranslationOffered) && (
        <CastTranslationTopHat
          isPending={isTranslationPending}
          isOffered={isTranslationOffered}
          isAsking={isAsking}
          notice={notice}
          onOffer={offerTranslation}
          sourceLanguageName={sourceLanguageName}
          showOriginal={showOriginal}
          toggleLabel={toggleLabel}
          onToggle={toggleTranslation}
        />
      )}
      <p data-fiddy="cast-body">{displayText}</p>
    </div>
  );
};

/** Our own origin, answering the way the release's server does. */
const originAnswering = ({ on }: { on: boolean }) => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/translate' && (init?.method ?? 'GET') === 'GET') {
        return { ok: true, json: async () => ({ on }) } as unknown as Response;
      }
      if (url === '/api/translations') {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      if (url === '/api/translate') {
        return {
          ok: true,
          json: async () => ({ from: 'es', text: TRANSLATED }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as unknown as Response;
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const body = () =>
  document.querySelector('[data-fiddy="cast-body"]')?.textContent ?? null;

describe('the top hat, when the origin can translate', () => {
  beforeEach(() => {
    forgetCastTranslations();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers the translation and swaps the text, then back', async () => {
    const fetchMock = originAnswering({ on: true });
    await act(async () => {
      render(<Harness cast={castOf(SPANISH)} />);
    });

    // Offered, not yet translated: the bar names the language, once.
    const offer = await screen.findByRole('button', {
      name: /translate from spanish/i,
    });
    expect(screen.getByText(/written in spanish/i)).toBeTruthy();
    expect(body()).toBe(SPANISH);

    // The press asks our own origin for THIS cast, by its author.
    await act(async () => {
      fireEvent.click(offer);
    });

    const asked = fetchMock.mock.calls.find(([url, init]) => {
      return String(url) === '/api/translate' && init?.method === 'POST';
    });
    expect(JSON.parse(String(asked?.[1]?.body))).toEqual({
      hash: HASH,
      to: 'en',
      fid: 3,
    });

    expect(body()).toBe(TRANSLATED);
    expect(screen.getByText(/translated from spanish/i)).toBeTruthy();

    // …and back to the words the author wrote.
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /show original text/i }),
      );
    });
    expect(body()).toBe(SPANISH);
    expect(
      screen.getByRole('button', { name: /show translated text/i }).textContent,
    ).toBe('Show translation');
  });

  it('draws nothing at all for a cast in the reader’s own language', async () => {
    originAnswering({ on: true });
    await act(async () => {
      render(<Harness cast={castOf(ENGLISH)} />);
    });

    expect(screen.queryByRole('button', { name: /translate/i })).toBeNull();
    expect(screen.queryByText(/translated from/i)).toBeNull();
    expect(body()).toBe(ENGLISH);
  });
});

describe('the top hat, when it cannot', () => {
  beforeEach(() => {
    forgetCastTranslations();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('draws nothing when the host answers {on:false}', async () => {
    originAnswering({ on: false });
    await act(async () => {
      render(<Harness cast={castOf(SPANISH)} />);
    });

    expect(screen.queryByRole('button', { name: /translate/i })).toBeNull();
    expect(screen.queryByText(/written in/i)).toBeNull();
    expect(body()).toBe(SPANISH);
  });

  it('draws nothing when there is no service there at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no service at this origin');
      }),
    );
    await act(async () => {
      render(<Harness cast={castOf(SPANISH)} />);
    });

    expect(screen.queryByRole('button', { name: /translate/i })).toBeNull();
    expect(body()).toBe(SPANISH);
  });
});
