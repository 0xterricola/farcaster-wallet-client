/**
 * This host's own push identity, generated here or not at all.
 *
 * A VAPID key pair is what a push service uses to tell one host from another.
 * Fiddy does not ship one and never points a self-hosted install at
 * fiddy.fun's: a push sent under somebody else's identity is a push the
 * reader's browser will refuse, and a host that quietly borrowed ours would be
 * sending notifications in our name. So the pair is EITHER in this host's own
 * state directory or the feature is off, with the reason said out loud.
 *
 *   <state dir>/vapid.json   { privateJwk, publicKey, subject, createdAt }
 *
 * The public key is also the number the browser needs (`applicationServerKey`),
 * so it is stored in the one form both sides agree on: the uncompressed P-256
 * point, base64url — 65 bytes starting 0x04.
 *
 * The file is mode 600 and the private half never leaves this host. Rotating it
 * invalidates every existing subscription, which is why rotation is an explicit
 * act (`rotate: true`) rather than something a restart can decide.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';

import { b64url, fromB64url } from './webpush.mjs';

/** The default contact a push service can use when it must complain to somebody. */
export const DEFAULT_SUBJECT = 'https://fiddy.fun';

const isContact = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  // RFC 8292 wants a `mailto:` or an https URL. Anything else is refused so the
  // failure is at setup, where a person can fix it, not at 3am in a push call.
  (/^mailto:[^@\s]+@[^@\s]+$/.test(value) || /^https:\/\/[^\s]+$/.test(value));

const publicKeyFrom = (privateKey) => {
  const jwk = privateKey.export({ format: 'jwk' });
  return b64url(Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]));
};

/**
 * A new key pair, in the two forms this service uses.
 *
 * Exported because the setup path calls it directly: an install that wants
 * alerts asks for a pair once and writes it, rather than discovering at the
 * first like that it has no identity.
 */
export const createVapidKeys = ({ subject = DEFAULT_SUBJECT } = {}) => {
  if (!isContact(subject)) {
    throw new Error('a push contact must be a mailto: address or an https URL');
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateJwk: privateKey.export({ format: 'jwk' }),
    privateKey,
    publicKey: publicKeyFrom(privateKey),
    subject,
  };
};

const cleanStored = (raw) => {
  if (!raw || typeof raw !== 'object' || !raw.privateJwk) {
    return undefined;
  }
  try {
    const privateKey = createPrivateKey({ key: raw.privateJwk, format: 'jwk' });
    return {
      privateJwk: raw.privateJwk,
      privateKey,
      publicKey: publicKeyFrom(privateKey),
      subject: isContact(raw.subject) ? raw.subject : DEFAULT_SUBJECT,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    };
  } catch {
    return undefined;
  }
};

/**
 * The keys this host holds.
 *
 * `read()` answers `undefined` when there are none — the honest state for
 * "this instance never set push up", which the capability route reports as a
 * reason rather than as a broken feature.
 */
export const createVapidStore = ({ dir, now = () => Date.now() }) => {
  if (!dir) {
    throw new Error('createVapidStore needs a directory');
  }
  const path = join(dir, 'vapid.json');

  const read = async () => {
    try {
      const text = await readFile(path, 'utf8');
      return cleanStored(JSON.parse(text));
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) {
        return undefined;
      }
      throw error;
    }
  };

  const write = async (keys) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const body = {
      privateJwk: keys.privateJwk,
      subject: isContact(keys.subject) ? keys.subject : DEFAULT_SUBJECT,
      createdAt: now(),
    };
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
    return cleanStored(body);
  };

  /**
   * Generate if absent. Called from setup, never from a request path.
   *
   * @param {{subject?: string, rotate?: boolean}} [options]
   */
  const ensure = async ({ subject, rotate = false } = {}) => {
    const existing = await read();
    if (existing && !rotate) {
      return existing;
    }
    return write(createVapidKeys({ subject: subject ?? existing?.subject }));
  };

  return { read, write, ensure, path };
};