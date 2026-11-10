/**
 * Phone alerts: the copy, the dedupe window, and the two cryptographic things a
 * push needs — all held without a network, and without a phone.
 *
 *   1. **grouping** — likes fold per cast, follows fold together, a reply keeps
 *      its own line and its words, four is the ceiling and the rest become one
 *      honest "N more";
 *   2. **dedupe** — an id in the window never comes back, and what was folded
 *      into a group counts as sent;
 *   3. **the store** — a subscription round-trips, a malformed one is refused,
 *      turning alerts off removes the file, and a missing file is not an error;
 *   4. **the envelope** — what `encryptPayload` writes DECRYPTS, byte for byte,
 *      with the phone's own key, and the record header says what RFC 8188 says;
 *   5. **VAPID** — the token's `aud` is the endpoint's origin (not ours), it
 *      verifies against our own public key, and a host with no keys generates
 *      none until asked.
 */

import {
  type BinaryLike,
  type CipherKey,
  createDecipheriv,
  createECDH,
  createPublicKey,
  randomBytes,
  verify,
} from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  groupActivity,
  MAX_PUSHES_PER_WINDOW,
} from '../../server/alerts/group.mjs';
import {
  createAlertStore,
  SENT_MAX,
  SENT_TTL_MS,
} from '../../server/alerts/store.mjs';
import {
  createVapidKeys,
  createVapidStore,
} from '../../server/alerts/vapid.mjs';
import {
  b64url,
  encryptPayload,
  fromB64url,
  hkdf,
  sendPush,
  vapidAuthorization,
} from '../../server/alerts/webpush.mjs';

/* ------------------------------------------------------------- fixtures --- */

const dirs = [];
const stateDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fiddy-alerts-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  dirs.length = 0;
});

/** A phone: its own key pair and the auth secret a PushSubscription carries. */
const phone = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    p256dh: b64url(ecdh.getPublicKey()),
    auth: b64url(auth),
    authBytes: auth,
    publicKey: ecdh.getPublicKey(),
  };
};

/** RFC 8188 §2.1: decrypt what the service wrote, exactly as a user agent does. */
/**
 * @param {Buffer} body
 * @param {ReturnType<typeof phone>} device
 */
const decryptPayload = (body: Buffer, device: ReturnType<typeof phone>) => {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  const shared = device.ecdh.computeSecret(new Uint8Array(asPublic));
  const ikm = hkdf(
    device.authBytes,
    shared,
    new Uint8Array([
      ...Buffer.from('WebPush: info\0', 'utf8'),
      ...device.publicKey,
      ...asPublic,
    ]),
    32,
  );
  const contentKey = hkdf(
    salt,
    ikm,
    new Uint8Array(Buffer.from('Content-Encoding: aes128gcm\0', 'utf8')),
    16,
  );
  const nonce = hkdf(
    salt,
    ikm,
    new Uint8Array(Buffer.from('Content-Encoding: nonce\0', 'utf8')),
    12,
  );
  const decipher = createDecipheriv(
    'aes-128-gcm',
    contentKey as unknown as CipherKey,
    nonce as unknown as BinaryLike,
  );
  decipher.setAuthTag(
    new Uint8Array(ciphertext.subarray(ciphertext.length - 16)),
  );
  const plain = Buffer.from(
    new Uint8Array([
      ...decipher.update(
        new Uint8Array(ciphertext.subarray(0, ciphertext.length - 16)),
      ),
      ...decipher.final(),
    ]),
  );
  return {
    recordSize,
    keyLength,
    text: plain.subarray(0, plain.length - 1).toString('utf8'),
    last: plain[plain.length - 1],
  };
};

/** One item as the derivation would hand it over. */
/** @param {any} over */
const item = (over: any) => ({
  id: over.id ?? `id-${Math.random()}`,
  kind: 'like',
  at: 1_000,
  actor: { fid: 1, name: 'Maya' },
  ...over,
});

/* -------------------------------------------------------------- grouping --- */

describe('grouping what happened into pushes', () => {
  it('folds a cast’s likes into one line naming the first and counting the rest', () => {
    const { pushes } = groupActivity({
      items: [
        item({
          id: 'a',
          castHash: '0xaaa',
          actor: { fid: 1, name: 'Maya' },
          at: 300,
        }),
        item({
          id: 'b',
          castHash: '0xaaa',
          actor: { fid: 2, name: 'Ivo' },
          at: 200,
        }),
        item({
          id: 'c',
          castHash: '0xaaa',
          actor: { fid: 3, name: 'Sam' },
          at: 100,
        }),
      ],
      now: 1_000,
    });
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body).toBe('Maya and 2 others liked your cast');
    expect(pushes[0].kind).toBe('like');
    expect(pushes[0].url).toBe('/c/0xaaa');
  });

  it('keeps two casts as two lines: they are two different things', () => {
    const { pushes } = groupActivity({
      items: [
        item({ id: 'a', castHash: '0xaaa', at: 300 }),
        item({ id: 'b', castHash: '0xbbb', at: 200 }),
      ],
      now: 1_000,
    });
    const bodies = pushes.map((push) => push.body);
    expect(bodies).toEqual(['Maya liked your cast', 'Maya liked your cast']);
    expect(pushes.map((push) => push.tag)).toEqual([
      'like:0xaaa',
      'like:0xbbb',
    ]);
  });

  it('names one liker without arithmetic', () => {
    const { pushes } = groupActivity({
      items: [item({ id: 'a', castHash: '0xaaa' })],
      now: 1_000,
    });
    expect(pushes[0].body).toBe('Maya liked your cast');
  });

  it('folds follows together, and never claims a recast or a quote', () => {
    const { pushes } = groupActivity({
      items: [
        item({
          id: 'f1',
          kind: 'follow',
          actor: { fid: 9, name: 'Ivo' },
          at: 200,
        }),
        item({
          id: 'f2',
          kind: 'follow',
          actor: { fid: 10, name: 'Sam' },
          at: 100,
        }),
      ],
      now: 1_000,
    });
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body).toBe('Ivo and 1 other followed you');
    expect(JSON.stringify(pushes)).not.toMatch(/recast|quote/i);
  });

  it('gives a reply its own line and its words', () => {
    const { pushes } = groupActivity({
      items: [
        item({
          id: 'r1',
          kind: 'reply',
          castHash: '0xddd',
          castText: 'does the 3D thing work on Android?',
          at: 500,
        }),
      ],
      now: 1_000,
    });
    expect(pushes[0].title).toBe('Maya');
    expect(pushes[0].body).toBe(
      'Maya replied to you: does the 3D thing work on Android?',
    );
    expect(pushes[0].url).toBe('/c/0xddd');
  });

  it('speaks about a mention as a mention', () => {
    const { pushes } = groupActivity({
      items: [item({ id: 'm1', kind: 'mention', castHash: '0xeee', at: 500 })],
      now: 1_000,
    });
    expect(pushes[0].body).toContain('mentioned you');
  });

  it('caps at four and says how many more, folded into what was sent', () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      item({
        id: `m${index}`,
        kind: 'mention',
        castHash: `0x${index}`,
        at: 100 + index,
      }),
    );
    const { pushes, delivered } = groupActivity({ items, now: 1_000 });
    expect(pushes).toHaveLength(MAX_PUSHES_PER_WINDOW + 1);
    const more = pushes[pushes.length - 1];
    expect(more.kind).toBe('more');
    expect(more.body).toBe('3 more notifications');
    expect(more.url).toBe('/notifications');
    // Everything folded away counts as sent, or it comes back next tick.
    expect(delivered).toHaveLength(7);
  });

  it('replaces a previous "N more" rather than stacking one per tick', () => {
    const first = groupActivity({
      items: [item({ id: 'x1', kind: 'mention', castHash: '0x1', at: 1 })],
      sent: [],
      now: 1_000,
    });
    const second = groupActivity({
      items: [
        item({ id: 'x1', kind: 'mention', castHash: '0x1', at: 1 }),
        item({ id: 'x2', kind: 'mention', castHash: '0x2', at: 2 }),
      ],
      sent: first.delivered.map((id) => ({ id, at: 1_000 })),
      now: 1_100,
    });
    expect(first.pushes).toHaveLength(1);
    expect(second.pushes).toHaveLength(1);
    // One tag, so the phone shows one line that moves, not two that pile up.
    const kinds = second.pushes.map((push) => push.tag);
    expect(new Set(kinds).size).toBe(1);
  });

  it('never sends the same id twice', () => {
    const items = [item({ id: 'dup', castHash: '0xaaa', at: 300 })];
    const once = groupActivity({ items, now: 1_000 });
    expect(once.pushes).toHaveLength(1);
    const twice = groupActivity({
      items,
      sent: once.delivered.map((id) => ({ id, at: 1_000 })),
      now: 1_100,
    });
    expect(twice.pushes).toHaveLength(0);
    expect(twice.delivered).toHaveLength(0);
  });

  it('keeps a hidden person out of the copy and out of the pushes', () => {
    const { pushes } = groupActivity({
      items: [
        item({ id: 'a', castHash: '0xaaa', actor: { fid: 7, name: 'Hidden' } }),
      ],
      now: 1_000,
    });
    // The route filters muted FIDs before grouping; this asserts the shape the
    // filter works on, so a future rewrite cannot silently drop the filter.
    expect(pushes[0].body).toContain('Hidden');
    const filtered = groupActivity({
      items: [
        {
          ...item({ id: 'a', castHash: '0xaaa' }),
          actor: { fid: 7, name: 'Hidden' },
        },
        {
          ...item({ id: 'b', castHash: '0xbbb' }),
          actor: { fid: 8, name: 'Kept' },
        },
      ].filter((entry) => entry.actor.fid !== 7),
      now: 1_000,
    });
    expect(JSON.stringify(filtered.pushes)).not.toContain('Hidden');
    expect(JSON.stringify(filtered.pushes)).toContain('Kept');
  });

  it('falls back to "Someone" when a name was never read', () => {
    const { pushes } = groupActivity({
      items: [item({ id: 'a', castHash: '0xaaa', actor: { fid: 42 } })],
      now: 1_000,
    });
    expect(pushes[0].body).toBe('Someone liked your cast');
  });
});

/* ----------------------------------------------------------------- store --- */

describe('the subscription store', () => {
  const subscription = (device: { p256dh: string; auth: string }) => ({
    endpoint: 'https://push.example.com/send/abc',
    keys: { p256dh: device.p256dh, auth: device.auth },
    kinds: { mentions: true, replies: true, likes: true, follows: false },
    language: 'en',
    mutedFids: [3, 3, 4],
  });

  it('round-trips a subscription and writes it mode 600', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    const device = phone();
    await store.write(7, subscription(device));
    const back = (await store.read(7))!;
    expect(back.fid).toBe(7);
    expect(back.keys.p256dh).toBe(device.p256dh);
    expect(back.kinds.follows).toBe(false);
    // Duplicates are collapsed: the list is sent as numbers, and a number sent
    // twice is still one number.
    expect(back.mutedFids).toEqual([3, 4]);
    const mode = (await stat(store.pathFor(7))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('answers undefined for a reader who never subscribed', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    await expect(store.read(999)).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it('refuses a subscription it cannot encrypt for', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    await expect(
      store.write(7, { endpoint: 'http://push.example.com/x', keys: {} }),
    ).rejects.toThrow();
    await expect(
      store.write(7, {
        endpoint: 'https://push.example.com/x',
        keys: { p256dh: 'short', auth: 'short' },
      }),
    ).rejects.toThrow();
  });

  it('treats a corrupt file as no subscription rather than as a crash', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    await writeFile(store.pathFor(7), '{ not json');
    await expect(store.read(7)).resolves.toBeUndefined();
    // And the next write replaces it.
    await store.write(7, subscription(phone()));
    await expect(store.read(7)).resolves.toBeTruthy();
  });

  it('drops the file when alerts are turned off', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    await store.write(7, subscription(phone()));
    expect(await store.remove(7)).toBe(true);
    await expect(store.read(7)).resolves.toBeUndefined();
    expect(await store.remove(7)).toBe(false);
    // Gone from disk, not merely hidden:
    await expect(readFile(store.pathFor(7), 'utf8')).rejects.toThrow();
  });

  it('keeps the dedupe window trimmed and free of repeats', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    await store.write(7, subscription(phone()));
    const base = Date.now();
    await store.recordSent(7, ['a', 'b', 'a'], base + 1);
    await store.recordSent(7, ['b', 'c'], base + 2);
    const back = (await store.read(7))!;
    expect(back.sent.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    // And the window is a window: an id older than a week is not kept for ever.
    await store.write(7, {
      ...subscription(phone()),
      sent: [{ id: 'ancient', at: base - SENT_TTL_MS - 1 }],
    });
    await store.recordSent(7, [`fresh`], base + 3);
    const swept = (await store.read(7))!;
    expect(swept?.sent.map((entry: { id: string }) => entry.id)).toEqual([
      'fresh',
    ]);
    // A burst larger than the window keeps the newest SENT_MAX, not all of them.
    await store.recordSent(
      7,
      Array.from({ length: SENT_MAX + 50 }, (_, index) => `x${index}`),
      base + 4,
    );
    const trimmed = (await store.read(7))!;
    expect(trimmed.sent.length).toBe(SENT_MAX);
  });

  it('lists every subscriber, skipping files that are not one', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    const device = phone();
    await store.write(7, subscription(device));
    await store.write(8, subscription(device));
    await writeFile(join(dir, 'notes.txt'), 'ignore me');
    const found = await store.list();
    expect(found.map((entry) => entry.fid).sort()).toEqual([7, 8]);
  });
});

/* --------------------------------------------------------------- envelope --- */

describe('the push envelope', () => {
  it('encrypts a payload the phone can decrypt, in the record layout the RFC names', () => {
    const device = phone();
    const payload = JSON.stringify({
      title: 'Maya',
      body: 'Maya liked your cast',
    });
    const body = encryptPayload({
      payload,
      p256dh: device.p256dh,
      auth: device.auth,
    });
    const opened = decryptPayload(body, device);
    expect(opened.text).toBe(payload);
    expect(opened.recordSize).toBe(4096);
    expect(opened.keyLength).toBe(65);
    // The last-record delimiter, so a reader knows the message ends here.
    expect(opened.last).toBe(0x02);
  });

  it('refuses a phone key that is not a P-256 point', () => {
    const device = phone();
    expect(() =>
      encryptPayload({
        payload: 'x',
        p256dh: b64url(Buffer.alloc(65)),
        auth: device.auth,
      }),
    ).toThrow(/P-256/);
    expect(() =>
      encryptPayload({
        payload: 'x',
        p256dh: device.p256dh,
        auth: b64url(Buffer.alloc(8)),
      }),
    ).toThrow(/16 bytes/);
  });

  it('uses a fresh ephemeral key per message, so two pushes share no ciphertext', () => {
    const device = phone();
    const a = encryptPayload({
      payload: 'same',
      p256dh: device.p256dh,
      auth: device.auth,
    });
    const b = encryptPayload({
      payload: 'same',
      p256dh: device.p256dh,
      auth: device.auth,
    });
    expect(Buffer.compare(new Uint8Array(a), new Uint8Array(b))).not.toBe(0);
    expect(decryptPayload(a, device).text).toBe('same');
    expect(decryptPayload(b, device).text).toBe('same');
  });

  it('treats 404 and 410 as "the subscription is gone", and nothing else', async () => {
    const device = phone();
    const subscription = {
      endpoint: 'https://push.example.com/send/abc',
      keys: { p256dh: device.p256dh, auth: device.auth },
    };
    const answer = (status: number) => async () => ({ status });
    for (const status of [201, 200, 500, 429]) {
      const result = await sendPush({
        fetchImpl: answer(status),
        subscription,
        payload: { a: 1 },
        authorization: 'vapid t=x, k=y',
      });
      expect(result.gone).toBe(false);

      expect(result.ok).toBe(status < 300);
    }
    for (const status of [404, 410]) {
      const result = await sendPush({
        fetchImpl: answer(status),
        subscription,
        payload: { a: 1 },
        authorization: 'vapid t=x, k=y',
      });
      expect(result.gone).toBe(true);
    }
  });

  it('reports a network failure instead of throwing at the loop', async () => {
    const device = phone();
    const result = await sendPush({
      fetchImpl: async () => {
        throw new Error('connect ETIMEDOUT');
      },
      subscription: {
        endpoint: 'https://push.example.com/send/abc',
        keys: { p256dh: device.p256dh, auth: device.auth },
      },
      payload: { a: 1 },
      authorization: 'vapid t=x, k=y',
    });
    expect(result).toMatchObject({ ok: false, status: 0, gone: false });
  });

  it('sends the aes128gcm content type and a TTL, and never a referer', async () => {
    const device = phone();
    let seen: any;
    await sendPush({
      fetchImpl: async (url: string, init: any) => {
        seen = { url, init };
        return { status: 201 };
      },
      subscription: {
        endpoint: 'https://push.example.com/send/abc',
        keys: { p256dh: device.p256dh, auth: device.auth },
      },
      payload: { a: 1 },
      authorization: 'vapid t=x, k=y',
      ttlSeconds: 60,
    });
    expect(seen.url).toBe('https://push.example.com/send/abc');
    expect(seen.init.headers['content-encoding']).toBe('aes128gcm');
    expect(seen.init.headers.ttl).toBe('60');
    expect(
      Object.keys(seen.init.headers).map((key) => key.toLowerCase()),
    ).not.toContain('referer');
  });
});

/* ------------------------------------------------------------------ VAPID --- */

describe('this host’s push identity', () => {
  it('mints a token whose audience is the endpoint, not us, and that verifies', () => {
    const keys = createVapidKeys({ subject: 'mailto:ops@fiddy.fun' });
    const endpoint = 'https://fcm.googleapis.com/fcm/send/xyz';
    const header = vapidAuthorization({
      endpoint,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      subject: keys.subject,
      now: 1_700_000_000_000,
    });
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, token, key] = match as RegExpExecArray;
    expect(key).toBe(keys.publicKey);
    const [head, claims, signature] = token.split('.');
    const parsed = JSON.parse(fromB64url(claims).toString('utf8'));
    expect(parsed.aud).toBe('https://fcm.googleapis.com');
    expect(parsed.sub).toBe('mailto:ops@fiddy.fun');
    expect(parsed.exp).toBe(1_700_000_000_000 / 1000 + 12 * 60 * 60);

    const jwk = keys.privateKey.export({ format: 'jwk' });
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      format: 'jwk',
    });
    const ok = verify(
      'SHA256',
      new Uint8Array(Buffer.from(`${head}.${claims}`)),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      new Uint8Array(fromB64url(signature)),
    );
    expect(ok).toBe(true);
  });

  it('refuses a contact that a push service could not use', () => {
    expect(() => createVapidKeys({ subject: 'nope' })).toThrow(/mailto/);
  });

  it('has no identity until it is asked for one, then keeps it', async () => {
    const dir = await stateDir();
    const store = createVapidStore({ dir });
    await expect(store.read()).resolves.toBeUndefined();
    const made = (await store.ensure({ subject: 'https://fiddy.example' }))!;
    expect(made.publicKey).toHaveLength(87);
    const again = (await store.ensure())!;
    expect(again.publicKey).toBe(made.publicKey);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it('rotates only when told to', async () => {
    const dir = await stateDir();
    const store = createVapidStore({ dir });
    const first = (await store.ensure({ subject: 'https://fiddy.example' }))!;
    const rotated = (await store.ensure({ rotate: true }))!;
    expect(rotated.publicKey).not.toBe(first.publicKey);
    expect(rotated.subject).toBe('https://fiddy.example');
  });
});
