// @vitest-environment jsdom

/**
 * The cashtag chip, pinned where a feed probe cannot reach it.
 *
 * A built client with no signed-in session and no node has no feed to render, so
 * `scripts/verify-mask-surfaces.mjs --visual` cannot drive a chip the way a
 * reader meets one. What matters about the chip is a contract, and it holds in
 * jsdom: nothing is asked for until the chip is looked at; a price that arrives
 * is shown with the market it came from and nothing more; a price that does not
 * arrive becomes a sentence rather than a blank; and the chip adds no tab stop
 * or click target of its own, because it lives inside the link the cast body
 * already renders.
 *
 * The network is stubbed here on purpose — this pins the contract, not
 * Dexscreener (that round trip is a fact about the live API, not about this
 * component).
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CashtagChip } from '~/components/casts/CashtagChip';
import { clearPriceCache } from '~/lib/tokens/price';

const pairFor = (overrides: Record<string, unknown> = {}) => ({
  chainId: 'base',
  url: 'https://dexscreener.com/base/pair',
  priceUsd: '3.42',
  liquidity: { usd: 250_000 },
  baseToken: { symbol: 'DEGEN', address: '0xdeadbeef' },
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const chipIn = (container: HTMLElement) =>
  container.querySelector('[data-cashtag="$DEGEN"]') as HTMLElement;

beforeEach(() => {
  clearPriceCache();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the cashtag chip', () => {
  it('shows the ticker immediately and asks for nothing until it is looked at', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ pairs: [pairFor()] }));

    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<CashtagChip ticker="$DEGEN" />);
    const chip = chipIn(container);

    expect(chip.textContent).toBe('$DEGEN');
    expect(chip.getAttribute('data-price-state')).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.mouseEnter(chip);

    await waitFor(() =>
      expect(chip.getAttribute('data-price-state')).toBe('priced'),
    );

    expect(chip.textContent).toBe('$DEGEN$3.42');
    expect(chip.getAttribute('title')).toContain('base');
    expect(chip.getAttribute('title')).toContain(
      'https://dexscreener.com/base/pair',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('turns a failed lookup into a sentence, and still shows the ticker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 503)),
    );

    const { container } = render(<CashtagChip ticker="DEGEN" />);
    const chip = chipIn(container);

    fireEvent.mouseEnter(chip);

    await waitFor(() =>
      expect(chip.getAttribute('data-price-state')).toBe('unavailable'),
    );

    expect(chip.textContent).toBe('$DEGEN');
    expect(chip.getAttribute('title')).toMatch(
      /could not be reached|answered 503/,
    );
  });

  it('looks up by contract address when the cast carried one', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ pairs: [pairFor()] }),
    );

    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(
      <CashtagChip ticker="DEGEN" address="0xabc" chain="base" />,
    );

    fireEvent.mouseEnter(chipIn(container));

    await waitFor(() =>
      expect(chipIn(container).getAttribute('data-price-state')).toBe('priced'),
    );

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/latest/dex/tokens/0xabc',
    );
  });

  it('adds no tab stop and no click target', () => {
    const { container } = render(<CashtagChip ticker="$DEGEN" />);

    expect(container.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
    expect(chipIn(container).getAttribute('aria-label')).toBe('$DEGEN');
  });
});
