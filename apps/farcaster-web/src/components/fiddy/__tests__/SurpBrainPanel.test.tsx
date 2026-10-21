// @vitest-environment jsdom
/**
 * The Surp panel, and what it says when it cannot reach Surp.
 *
 * The deps are injected so every case is exercised on the recorded live
 * captures instead of the network: a live board, a blocked origin, and a
 * service that answers with something unreadable. The last two are the point —
 * a pricing panel that invents a number when it cannot reach the pricer is
 * worse than one that admits it, and these tests hold it to that.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import chat402 from '~/lib/surp/__tests__/fixtures/chat-402.json';
import priceBoard from '~/lib/surp/__tests__/fixtures/price-board.json';
import keyCreated from '~/lib/surp/__tests__/fixtures/key-created.json';
import { SurpBrainPanel } from '~/components/fiddy/SurpBrainPanel';
import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { parsePriceBoard, parseRequestQuote } from '~/lib/surp/pricing';
import { SurpUnreachableError } from '~/lib/surp/transport';

const board = parsePriceBoard(priceBoard, 0.7)!;
const quote = parseRequestQuote(chat402)!;

const liveDeps = {
  loadBoard: async () => board,
  loadQuote: async () => quote,
};

beforeEach(() => {
  installFakeStorage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('with Surp reachable', () => {
  it('shows the savings line, computed from the live prices', async () => {
    render(<SurpBrainPanel deps={liveDeps} />);
    const savings = await screen.findByText(/whether you use it or not/);
    expect(savings.textContent).toContain('$20.00 a month');
    expect(savings.textContent).toContain('on Surp');
  });

  it('says where both numbers came from', async () => {
    render(<SurpBrainPanel deps={liveDeps} />);
    const provenance = await screen.findByText(
      /Surp's prices were read from surp.ivc.lol/,
    );
    expect(provenance.textContent).toContain('read from');
    expect(provenance.textContent).toContain(board.generatedAt.slice(0, 10));
  });

  it('recomputes the month when the owner says they use it more', async () => {
    render(<SurpBrainPanel deps={liveDeps} />);
    await screen.findByText(/whether you use it or not/);
    const before = document.querySelector('[data-fiddy-surp="savings"]')
      ?.textContent;
    fireEvent.change(screen.getByLabelText(/How much you use it/i), {
      target: { value: '100' },
    });
    await waitFor(() => {
      const after = document.querySelector('[data-fiddy-surp="savings"]')
        ?.textContent;
      expect(after).not.toBe(before);
    });
  });

  it('compares against whichever plan the owner says they pay for', async () => {
    render(<SurpBrainPanel deps={liveDeps} />);
    await screen.findByText(/whether you use it or not/);
    fireEvent.click(
      document.querySelector('[data-fiddy-surp-plan="chatgpt-plus"]') as HTMLElement,
    );
    await waitFor(() => {
      expect(
        document.querySelector('[data-fiddy-surp="savings"]')?.textContent,
      ).toContain('ChatGPT Plus');
    });
  });

  it('makes a key here, keeps it out of the setup file, and shows a mask', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => keyCreated,
      })),
    );
    render(<SurpBrainPanel deps={liveDeps} />);
    await screen.findByText(/whether you use it or not/);

    fireEvent.click(document.querySelector('[data-fiddy-surp="make-key"]') as HTMLElement);

    const shown = await screen.findByText(/A key is saved on this device/);
    expect(shown.textContent).toContain('sk-surp-');
    expect(shown.textContent).not.toContain(keyCreated.key);
    expect(shown.textContent).toContain('…');
    // The key is not in the preference file, and never will be.
    expect(JSON.stringify(window.localStorage.getItem('fiddy.setup'))).not.toContain(
      'sk-surp-',
    );
  });
});

describe('with Surp blocked by the browser', () => {
  it('says why, and shows no price at all', async () => {
    const deps = {
      loadBoard: async () => {
        throw new SurpUnreachableError('CROSS_ORIGIN', 'Your browser blocked this page from reading Surp directly. Surp has to allow fiddy.fun before this can work.');
      },
      loadQuote: async () => {
        throw new SurpUnreachableError('CROSS_ORIGIN', 'blocked');
      },
    };
    render(<SurpBrainPanel deps={deps} />);
    await screen.findByText(/blocked this page from reading Surp/);
    // No invented numbers, and the key button stays shut.
    expect(document.querySelector('[data-fiddy-surp="savings"]')).toBeNull();
    expect(document.querySelector('[data-fiddy-surp="provenance"]')).toBeNull();
    const make = document.querySelector('[data-fiddy-surp="make-key"]') as HTMLButtonElement;
    expect(make.disabled).toBe(true);
  });

  it('distinguishes a service that answered oddly from one it could not reach', async () => {
    const deps = {
      loadBoard: async () => {
        throw new Error('surp-price-board-unreadable');
      },
      loadQuote: async () => {
        throw new Error('surp-quote-unreadable');
      },
    };
    render(<SurpBrainPanel deps={deps} />);
    await screen.findByText(/did not answer in a way this page could read/);
    expect(document.querySelector('[data-fiddy-surp="savings"]')).toBeNull();
  });
});