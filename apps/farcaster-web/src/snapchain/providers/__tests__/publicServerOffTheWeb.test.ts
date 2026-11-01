/**
 * The sentences this client uses when a request would have gone to Farcaster's
 * own public server — and the fact that it asks nothing of it.
 *
 * The measurement behind them (2026-10-21, the live release, a real browser):
 * every `/v1/**` and `/v2/**` read on `api.farcaster.xyz` was blocked by CORS
 * from `https://fiddy.fun` — eleven distinct paths, every poll — while `curl`
 * with `Origin: https://fiddy.fun` showed `Vary: Origin` and no
 * `Access-Control-Allow-Origin` on any of them. See
 * `~/snapchain/providers/publicServerOffTheWeb`.
 */

import { describe, expect, it } from 'vitest';

import { publicServerCannotAnswer } from '~/snapchain/providers/publicServerOffTheWeb';

describe('publicServerCannotAnswer', () => {
  it('says a read of the protocol needs a node', () => {
    const sentence = publicServerCannotAnswer({
      kind: 'node',
      method: 'GET',
      path: '/v2/unseen',
      why: 'counts are derived from mentions, reactions and follows since your watermark',
    });

    expect(sentence).toContain('/v2/unseen is read from a node');
    expect(sentence).toContain('cannot be read from a web page');
    // The sentence must not pretend the server tried and failed: the point of
    // the fix is that it was never asked.
    expect(sentence).not.toContain('did not answer');
  });

  it('gives a hosted-only feature its own classification, then says there is no other source', () => {
    const sentence = publicServerCannotAnswer({
      kind: 'hosted',
      method: 'GET',
      path: '/v1/audio-rooms',
      why: 'audio rooms are a hosted product, not protocol messages',
    });

    expect(sentence).toContain(
      'audio rooms are a hosted product, not protocol messages.',
    );
    expect(sentence).toContain('cannot be read from a web page');
    expect(sentence).toContain('no other source for it');
  });

  it('keeps a write’s own answer', () => {
    const sentence = publicServerCannotAnswer({
      kind: 'hosted',
      method: 'POST',
      path: '/v2/cast-attachments',
      why: 'attachments are resolved by the hosted indexer',
    });

    expect(sentence).toContain('does not take writes from this client');
    expect(sentence).toContain('Posting goes through your node');
  });
});
