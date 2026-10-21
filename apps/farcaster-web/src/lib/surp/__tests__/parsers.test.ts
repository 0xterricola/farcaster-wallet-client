/**
 * Parsers against what the live service actually served.
 *
 * Every fixture in this folder is a verbatim capture from https://surp.ivc.lol
 * on 2026-10-21 (see `fixtures/README.md`). The point of the parsers is that a
 * shape this code does not recognise produces an honest failure rather than a
 * wrong number, so most of what follows is about the refusal path.
 */

import { describe, expect, it } from 'vitest';

import chat402 from './fixtures/chat-402.json';
import keyBalance from './fixtures/key-balance.json';
import keyCreated from './fixtures/key-created.json';
import priceBoard from './fixtures/price-board.json';
import { parsePriceBoard, parseRequestQuote } from '~/lib/surp/pricing';
import {
  looksLikeSurpKey,
  parseCreatedKey,
  parseKeyBalance,
  surpKeyMask,
} from '~/lib/surp/keys';

describe('the price board', () => {
  it('reads every model Surp listed', () => {
    const board = parsePriceBoard(priceBoard, 0.7)!;
    expect(board.models).toHaveLength(priceBoard.models.length);
    expect(board.inputShare).toBe(0.7);
    expect(board.sourceAgeSeconds).toBeTypeOf('number');
  });

  it('keeps the fields the savings line needs and nothing invented', () => {
    const board = parsePriceBoard(priceBoard, 0.7)!;
    const first = board.models[0];
    expect(first.model).toBe(priceBoard.models[0].model);
    expect(first.usdPerMillion).toBe(priceBoard.models[0].surp_usd_per_1m);
    expect(first.sellers).toBe(priceBoard.models[0].sellers);
  });

  it('refuses a payload it does not recognise instead of guessing', () => {
    expect(parsePriceBoard({ models: [] }, 0.7)).toBeNull();
    expect(parsePriceBoard({ models: [{ name: 'no id' }] }, 0.7)).toBeNull();
    expect(parsePriceBoard(null, 0.7)).toBeNull();
    expect(parsePriceBoard({ models: 'lots' }, 0.7)).toBeNull();
  });
});

describe('the request price', () => {
  it('reads the exact charge out of a real 402', () => {
    const quote = parseRequestQuote(chat402)!;
    expect(quote.priceUsd).toBe(0.01);
    expect(quote.amountAtomicUsdc).toBe(10000n);
    expect(quote.combo).toBe('value');
    expect(quote.routedModel).toBeTypeOf('string');
  });

  it('prefers the atomic amount to the human string', () => {
    const quote = parseRequestQuote({
      ...chat402,
      price_usd: '$9.99',
    })!;
    expect(quote.priceUsd).toBe(0.01);
  });

  it('falls back to the human string when there is no acceptance', () => {
    const quote = parseRequestQuote({ price_usd: '$0.0125', combo: 'x' })!;
    expect(quote.priceUsd).toBe(0.0125);
    expect(quote.amountAtomicUsdc).toBeNull();
  });

  it('refuses a 402 with no price in it at all', () => {
    expect(parseRequestQuote({ accepts: [] })).toBeNull();
    expect(parseRequestQuote({ price_usd: 'free' })).toBeNull();
    expect(parseRequestQuote('nope')).toBeNull();
  });
});

describe('a created key', () => {
  it('reads the key Surp returned once', () => {
    const record = parseCreatedKey(keyCreated, 1_700_000_000_000)!;
    expect(looksLikeSurpKey(record.key)).toBe(true);
    expect(record.label).toBe(keyCreated.label);
    expect(record.createdAt).toBe(1_700_000_000_000);
  });

  it('refuses anything that is not a Surp key', () => {
    expect(parseCreatedKey({ key: 'sk-other-abc' }, 0)).toBeNull();
    expect(parseCreatedKey({ key: 'sk-surp-short' }, 0)).toBeNull();
    expect(parseCreatedKey({ label: 'no key' }, 0)).toBeNull();
    expect(parseCreatedKey(null, 0)).toBeNull();
  });

  it('never shows the whole key on a screen', () => {
    const mask = surpKeyMask(keyCreated.key);
    expect(mask).not.toBe(keyCreated.key);
    expect(mask.startsWith('sk-surp-')).toBe(true);
    expect(mask).toContain('…');
    expect(mask.length).toBeLessThan(keyCreated.key.length);
  });
});

describe('a key balance', () => {
  it('reads the read-only check the key endpoint answers', () => {
    const balance = parseKeyBalance(keyBalance)!;
    expect(balance.label).toBe(keyBalance.label);
    expect(balance.balanceUsdCents).toBe(0);
    expect(balance.totalRequests).toBe(0);
    expect(balance.lastUsed).toBeNull();
  });

  it('refuses a balance it cannot trust', () => {
    expect(parseKeyBalance({ label: 'x' })).toBeNull();
    expect(parseKeyBalance({ error: 'invalid key' })).toBeNull();
  });
});