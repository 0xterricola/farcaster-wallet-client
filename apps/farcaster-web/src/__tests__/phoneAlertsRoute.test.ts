/**
 * The routes a browser meets: capability, subscribe, off. Tested against the
 * real handler with everything else stubbed, because the honest states are the
 * product: a host that never opted in, a host that opted in without keys, and a
 * host that is on. And the off-route refuses a claim minted for a phone
 * address, because a witnessed subscribe request must not double as a kill
 * switch.
 */

import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalClaim,
  createSubscribeGuard,
} from '../../server/alerts/subscribe.mjs';
import { createVapidStore } from '../../server/alerts/vapid.mjs';
import { createUnfurlHandler } from '../../server/unfurl/handler.mjs';

const bareHandler = (alerts: any) =>
  createUnfurlHandler({
    origin: 'https://fiddy.fun',
    shellSource: () => '<html></html>',
    siteCard: () => Buffer.from('89504e470d0a1a0a', 'hex'),
    renderCard: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
    reader: { size: () => 0, feedSize: () => 0 },
    ...(alerts === undefined ? {} : { alerts }),
  } as never);

describe('GET /api/alerts, the capability', () => {
  it('a host that never opted in says so, and the browser draws no toggle', async () => {
    const answer = await bareHandler(undefined).handle({
      method: 'GET',
      path: '/api/alerts',
      ip: '203.0.113.9',
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(String(answer.body))).toEqual({
      on: false,
      reason: 'not-configured',
    });
  });

  it('a host that opted in but never made keys says no-keys', async () => {
    const answer = await bareHandler({
      capability: async () => ({ on: false, reason: 'no-keys' }),
    }).handle({ method: 'GET', path: '/api/alerts', ip: '203.0.113.9' });
    expect(JSON.parse(String(answer.body))).toEqual({
      on: false,
      reason: 'no-keys',
    });
  });

  it('a host that is on answers with the number the browser needs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fiddy-alerts-route-'));
    const keys = (await createVapidStore({ dir }).ensure({
      subject: 'https://fiddy.example',
    }))!;
    const answer = await bareHandler({
      capability: async () => ({
        on: true,
        publicKey: keys.publicKey,
        kinds: ['mentions', 'replies', 'likes', 'follows'],
      }),
    }).handle({ method: 'GET', path: '/api/alerts', ip: '203.0.113.9' });
    const parsed = JSON.parse(String(answer.body));
    expect(parsed.on).toBe(true);
    expect(parsed.publicKey).toHaveLength(87);
    expect(parsed.kinds).toEqual(['mentions', 'replies', 'likes', 'follows']);
  });
});

describe('POST /api/alerts/off, turning it off', () => {
  it('refuses a claim minted for a phone address', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer =
      '0x' +
      publicKey
        .export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('hex');
    const guard = createSubscribeGuard({
      nodeGet: async () => ({ signer: { fid: 7, key: signer, keyType: 1 } }),
    });
    const handler = bareHandler({
      capability: async () => ({ on: true, publicKey: 'k' }),
      subscribe: async () => ({ status: 200, headers: {}, body: '{}' }),
      off: async (body: any) => {
        const checked = await guard.check({
          fid: body?.fid,
          signer: body?.signer,
          signature: body?.signature,
          endpoint: 'off',
          issuedAt: body?.issuedAt,
        });
        if (!checked.ok) {
          return {
            status: 403,
            headers: {},
            body: JSON.stringify({ reason: checked.reason }),
          };
        }
        return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) };
      },
    });

    const issuedAt = Date.now();
    // A perfectly valid subscribe claim — for a phone address.
    const signature = cryptoSign(
      null,
      new Uint8Array(
        Buffer.from(
          await canonicalClaim({
            fid: 7,
            endpoint: 'https://push.example.com/send/abc',
            issuedAt,
          }),
        ),
      ),
      privateKey,
    ).toString('hex');

    const refused = await handler.handle({
      method: 'POST',
      path: '/api/alerts/off',
      body: JSON.stringify({ fid: 7, signer, signature, issuedAt }),
      ip: '203.0.113.9',
    });
    expect(refused.status).toBe(403);
    expect(JSON.parse(String(refused.body)).reason).toBe('not-your-signature');
  });
});
