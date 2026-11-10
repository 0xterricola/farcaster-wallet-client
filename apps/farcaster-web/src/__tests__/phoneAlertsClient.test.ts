/**
 * The browser's half of phone alerts: the claim, the copy, and nothing that
 * needs a phone.
 *
 *   1. **the claim cannot drift.** The bytes the browser signs are built by
 *      `canonicalClaim` here AND by `server/alerts/subscribe.mjs` there; this
 *      test imports both and holds them to the same string, because a claim
 *      the host cannot read is a switch that does nothing and the reader never
 *      learns which side changed;
 *   2. **the copy never says a plumbing word.** No push, no subscription, no
 *      endpoint, no VAPID, no service worker — in any sentence, ever;
 *   3. **the honest paths.** A browser that cannot be reached says so, iOS is
 *      told to add Fiddy to the Home Screen, and the app-key absence says
 *      which one-time step is missing.
 */

import { describe, expect, it } from 'vitest';

import {
  ALERT_KINDS,
  applicationServerKey,
  assessPhone,
  blockFor,
  canonicalClaim,
  CLAIM_VERSION,
} from '~/snapchain/alerts/phoneAlerts';

import {
  canonicalClaim as serverClaim,
  CLAIM_VERSION as SERVER_VERSION,
} from '../../server/alerts/subscribe.mjs';

/* ----------------------------------------------------------------- claim --- */

describe('the claim both sides must read the same way', () => {
  it('byte for byte, browser and host', async () => {
    const input = {
      fid: 7,
      endpoint: 'https://push.example.com/send/abc',
      issuedAt: 123_456,
    };
    expect(await canonicalClaim(input)).toBe(serverClaim(input));
  });

  it('names the same version, so old claims die together', () => {
    expect(CLAIM_VERSION).toBe(SERVER_VERSION);
    expect(CLAIM_VERSION).toBe('fiddy-alerts-v1');
  });
});

/* ------------------------------------------------------------------ copy --- */

describe('what the reader is told', () => {
  const PLUMBING = /push|subscription|endpoint|vapid|service worker|sw\.js/i;

  it('never says a plumbing word, in any sentence', () => {
    for (const reason of [
      'unsupported',
      'no-permission',
      'ios-home-screen',
      'no-app-key',
      'offered',
    ]) {
      const sentence = blockFor(reason as never).sentence;
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence).not.toMatch(PLUMBING);
    }
  });

  it('tells an iPhone reader to add Fiddy to the Home Screen, in one sentence', () => {
    expect(blockFor('ios-home-screen').sentence).toContain('Home Screen');
  });

  it('says which one-time step is missing when there is no key', () => {
    expect(blockFor('no-app-key').sentence).toContain('Issue app key');
  });
});

/* --------------------------------------------------------------- honest --- */

describe('the honest paths', () => {
  it('a browser with no service worker at all is told so, not left guessing', async () => {
    const state = await assessPhone(
      { on: true, publicKey: 'k' },
      {
        hasAppKey: true,
        permission: 'granted',
      },
    );
    expect('ok' in state ? 'ok' : state.sentence).toBe(
      blockFor('unsupported').sentence,
    );
  });

  it('the kinds are the four a read node can answer, and no others', () => {
    expect([...ALERT_KINDS]).toEqual([
      'mentions',
      'replies',
      'likes',
      'follows',
    ]);
  });
});

/* ------------------------------------------------------------------ key --- */

describe('the host’s key as the browser hands it back', () => {
  it('base64url becomes the bytes the phone expects', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 255]);
    const encoded = Buffer.from(bytes).toString('base64url');
    const back = applicationServerKey(encoded) as unknown as Uint8Array;
    expect(Array.from(back)).toEqual([1, 2, 3, 250, 255]);
  });
});
