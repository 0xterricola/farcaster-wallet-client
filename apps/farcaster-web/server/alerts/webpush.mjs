/**
 * The two cryptographic things a push needs, and nothing else.
 *
 * NO NEW DEPENDENCY. `web-push` would bring a tree of transitive packages into
 * a release ritual whose whole promise is "a release is a commit you can read";
 * the specs are small and `node:crypto` implements every primitive. So they are
 * written out here, and held by a unit test that decrypts what this module
 * encrypts — the test is the only reason to trust the code below.
 *
 *   1. **aes128gcm payload encryption** (RFC 8291 + RFC 8188): the message a
 *      push service carries is unreadable by that service. The phone's public
 *      key and auth secret come from the browser's `PushSubscription`; an
 *      ephemeral P-256 key is generated per message.
 *   2. **a VAPID token** (RFC 8292): an ES256 JWT naming this host's own key,
 *      so the push service can tell who is asking. `aud` is the ENDPOINT's
 *      origin, never ours, and the token is short-lived.
 *
 * The record layout below is spelled out in bytes because a single wrong field
 * is an undecryptable message that a push service accepts with a 201 — the
 * failure is silent, so the format is written where it can be checked against
 * the RFC.
 */

import { createCipheriv, createECDH, createHmac, createSign } from 'node:crypto';
import { randomBytes } from 'node:crypto';

/** The record size the body header advertises. 4096 is the interoperable value. */
export const RECORD_SIZE = 4096;

export const b64url = (value) => Buffer.from(value).toString('base64url');

export const fromB64url = (value) => Buffer.from(String(value), 'base64url');

/**
 * HKDF-SHA256 (RFC 5869).
 *
 * `info` already carries the trailing zero byte the Web Push specs specify, so
 * it is passed whole rather than assembled here.
 */
export const hkdf = (salt, inputKeyMaterial, info, length) => {
  const prk = createHmac('sha256', salt).update(inputKeyMaterial).digest();
  const blocks = [];
  let previous = Buffer.alloc(0);
  let counter = 1;
  let produced = 0;
  while (produced < length) {
    previous = createHmac('sha256', prk)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    blocks.push(previous);
    produced += previous.length;
    counter += 1;
  }
  return Buffer.concat(blocks).subarray(0, length);
};

/**
 * The header a Web Push body carries: salt, record size, key length, then the
 * sender's ephemeral public key (RFC 8188 §2.1).
 */
const header = ({ salt, publicKey }) => {
  const bytes = Buffer.alloc(16 + 4 + 1);
  salt.copy(bytes, 0);
  bytes.writeUInt32BE(RECORD_SIZE, 16);
  bytes.writeUInt8(publicKey.length, 20);
  return bytes;
};

/**
 * Encrypt one message for one phone.
 *
 * @param {object} input
 * @param {string|Buffer} input.payload  the JSON the service worker will read
 * @param {string} input.p256dh          the subscription's public key (base64url)
 * @param {string} input.auth            the subscription's auth secret (base64url)
 * @param {Buffer} [input.salt]          only a test passes this
 * @param {import('node:crypto').ECDH} [input.ephemeral]  only a test passes this
 */
export const encryptPayload = ({
  payload,
  p256dh,
  auth,
  salt = randomBytes(16),
  ephemeral = createECDH('prime256v1'),
}) => {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('the phone’s public key is not a P-256 point');
  }
  if (authSecret.length !== 16) {
    throw new Error('the phone’s auth secret is not 16 bytes');
  }
  ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey();
  const sharedSecret = ephemeral.computeSecret(uaPublic);

  const info = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, info, 32);
  const contentKey = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  return Buffer.concat([header({ salt, publicKey: asPublic }), asPublic, body]);
};

/**
 * The `Authorization` header for one request (RFC 8292).
 *
 * `aud` is the ORIGIN OF THE ENDPOINT. A token minted for our own origin is
 * rejected by the push service, and the rejection looks exactly like an expired
 * subscription if you only log the status code — hence the test that asserts
 * `aud`.
 */
export const vapidAuthorization = ({
  endpoint,
  privateKey,
  publicKey,
  subject,
  now = Date.now(),
  expiresInMs = 12 * 60 * 60 * 1000,
}) => {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(
    JSON.stringify({
      aud,
      exp: Math.floor((now + expiresInMs) / 1000),
      sub: subject,
    }),
  );
  const signature = createSign('SHA256')
    .update(`${header}.${claims}`)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
};

/**
 * Send one push. `fetchImpl` is injected so a test can answer without a network
 * and so nothing here can ever reach a real phone by accident.
 *
 * A 404 or 410 means the subscription is GONE (uninstalled, permission revoked,
 * expired) and the caller deletes it. Everything else is reported and retried on
 * the next tick rather than treated as a fault of the reader's.
 */
export const sendPush = async ({
  fetchImpl,
  subscription,
  payload,
  authorization,
  ttlSeconds = 3600,
  timeoutMs = 8000,
  headers = {},
}) => {
  const body = encryptPayload({
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        ttl: String(ttlSeconds),
        urgency: 'normal',
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      gone: response.status === 404 || response.status === 410,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      gone: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(deadline);
  }
};