import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  base64UrlToBytes,
  bytesToBase64Url,
  utf8ToBytes,
} from '~/lib/sealed/encoding';
import {
  CAST_TEXT_LIMIT_BYTES,
  decodeEnvelope,
  LONG_CAST_TEXT_LIMIT_BYTES,
  plaintextBudgetBytes,
  SEALED_CAST_PREFIX,
} from '~/lib/sealed/envelope';
import { createIdentity, type SealedIdentity } from '~/lib/sealed/keys';
import {
  openSealedCast,
  sealBudgetBytes,
  sealCast,
  sealedCastRecipients,
} from '~/lib/sealed/sealedCast';

const MESSAGE = 'meet me at the pier at six — bring the dog';

let recipient: SealedIdentity;
let stranger: SealedIdentity;

beforeEach(async () => {
  [recipient, stranger] = await Promise.all([
    createIdentity(),
    createIdentity(),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sealing', () => {
  it('seals for one person, and that person opens it', async () => {
    const sealed = await sealCast({
      plaintext: MESSAGE,
      recipientShares: [recipient.share],
    });

    expect(sealed.text.startsWith(SEALED_CAST_PREFIX)).toBe(true);
    expect(sealed.recipients).toBe(1);
    expect(sealed.textBytes).toBeLessThanOrEqual(CAST_TEXT_LIMIT_BYTES);

    const opened = await openSealedCast({
      text: sealed.text,
      identity: recipient,
    });

    expect(opened.status).toBe('opened');
    expect(opened.status === 'opened' && opened.plaintext).toBe(MESSAGE);
  });

  it('never puts the message in the cast', async () => {
    const sealed = await sealCast({
      plaintext: MESSAGE,
      recipientShares: [recipient.share],
    });

    expect(sealed.text).not.toContain('pier');
    expect(sealed.text).not.toContain(MESSAGE);

    const raw = base64UrlToBytes(sealed.text.slice(SEALED_CAST_PREFIX.length));
    const rawText = new TextDecoder('utf-8', { fatal: false }).decode(raw);

    expect(rawText).not.toContain('pier');
  });

  it('does not reach the network, at any point', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the sealed modules reached the network');
    });

    const sealed = await sealCast({
      plaintext: MESSAGE,
      recipientShares: [recipient.share],
    });
    const opened = await openSealedCast({
      text: sealed.text,
      identity: recipient,
    });

    expect(opened.status).toBe('opened');
  });

  it('gives a different cast every time, from the same message', async () => {
    const first = await sealCast({
      plaintext: MESSAGE,
      recipientShares: [recipient.share],
    });
    const second = await sealCast({
      plaintext: MESSAGE,
      recipientShares: [recipient.share],
    });

    expect(first.text).not.toBe(second.text);
  });

  it('seals for several people at once, and each of them opens it', async () => {
    /* Two people do not fit an ordinary 320-byte cast — that is what the budget
       test pins — so this is the long-cast path, which the codec carries up to
       eight people on. */
    const sealed = await sealCast({
      plaintext: MESSAGE,
      recipientShares: [recipient.share, stranger.share],
      recipientLimit: 2,
      limitBytes: LONG_CAST_TEXT_LIMIT_BYTES,
    });

    expect(sealed.recipients).toBe(2);

    for (const identity of [recipient, stranger]) {
      const opened = await openSealedCast({ text: sealed.text, identity });

      expect(opened.status === 'opened' && opened.plaintext).toBe(MESSAGE);
    }
  });

  it('counts the message in bytes, not characters, and reports the room left', async () => {
    const sealed = await sealCast({
      plaintext: '🔒🔒🔒',
      recipientShares: [recipient.share],
    });

    expect(sealed.plaintextBytes).toBe(12);
    expect(sealed.remainingBytes).toBe(
      plaintextBudgetBytes(1, CAST_TEXT_LIMIT_BYTES) - 12,
    );
  });

  it('uses the long-cast budget when it is told to', async () => {
    const longMessage = 'x'.repeat(500);
    const sealed = await sealCast({
      plaintext: longMessage,
      recipientShares: [recipient.share],
      limitBytes: LONG_CAST_TEXT_LIMIT_BYTES,
    });

    expect(sealed.textBytes).toBeGreaterThan(CAST_TEXT_LIMIT_BYTES);
    expect(sealed.textBytes).toBeLessThanOrEqual(LONG_CAST_TEXT_LIMIT_BYTES);

    const opened = await openSealedCast({
      text: sealed.text,
      identity: recipient,
    });

    expect(opened.status === 'opened' && opened.plaintext).toBe(longMessage);
  });

  it('refuses a message that does not fit, and says both numbers', async () => {
    const tooLong = 'x'.repeat(plaintextBudgetBytes(1) + 1);

    await expect(
      sealCast({ plaintext: tooLong, recipientShares: [recipient.share] }),
    ).rejects.toThrow(
      new RegExp(
        `${tooLong.length} bytes and a sealed cast of this size holds ${plaintextBudgetBytes(1)}`,
      ),
    );
  });

  it('refuses an empty message, no recipients, a bad key, and more people than v1 names', async () => {
    await expect(
      sealCast({ plaintext: '   ', recipientShares: [recipient.share] }),
    ).rejects.toThrow(/nothing to seal/);

    await expect(
      sealCast({ plaintext: MESSAGE, recipientShares: [] }),
    ).rejects.toThrow(/one person/);

    await expect(
      sealCast({ plaintext: MESSAGE, recipientShares: ['fdy-key-1:nope'] }),
    ).rejects.toThrow(/not a key we can seal to/);

    await expect(
      sealCast({
        plaintext: MESSAGE,
        recipientShares: [recipient.share, stranger.share],
      }),
    ).rejects.toThrow(/one person at a time/);
  });

  it('promises the same budget the surface shows', () => {
    expect(sealBudgetBytes(1)).toBe(plaintextBudgetBytes(1));
    expect(sealBudgetBytes(1, LONG_CAST_TEXT_LIMIT_BYTES)).toBe(
      plaintextBudgetBytes(1, LONG_CAST_TEXT_LIMIT_BYTES),
    );
  });
});

describe('opening', () => {
  it('tells a stranger the cast is not theirs, without attempting to open it', async () => {
    const sealed = await sealCast({
      plaintext: MESSAGE,
      recipientShares: [recipient.share],
    });

    const opened = await openSealedCast({
      text: sealed.text,
      identity: stranger,
    });

    expect(opened.status).toBe('not-addressed');
    expect(opened.status !== 'opened' && opened.reason).toMatch(/someone else/);
  });

  it('refuses text that was altered, even one byte of it', async () => {
    const sealed = await sealCast({
      plaintext: MESSAGE,
      recipientShares: [recipient.share],
    });

    const raw = base64UrlToBytes(sealed.text.slice(SEALED_CAST_PREFIX.length));
    const envelope = decodeEnvelope(sealed.text);

    /* The last byte is inside the content tag. */
    const ciphertextTampered = new Uint8Array(raw);
    ciphertextTampered[ciphertextTampered.length - 1]! ^= 0x01;

    const openedCiphertext = await openSealedCast({
      text: SEALED_CAST_PREFIX + bytesToBase64Url(ciphertextTampered),
      identity: recipient,
    });

    expect(openedCiphertext.status).toBe('failed');

    /* The one-time key is in the header, which the content is authenticated
       against — so altering it breaks the seal rather than redirecting it. */
    const headerTampered = new Uint8Array(raw);
    headerTampered[5]! ^= 0x01;

    const openedHeader = await openSealedCast({
      text: SEALED_CAST_PREFIX + bytesToBase64Url(headerTampered),
      identity: recipient,
    });

    expect(openedHeader.status).toBe('failed');

    /* The recipient block itself. */
    const wrappedTampered = new Uint8Array(raw);
    wrappedTampered[1 + 33 + 1 + 4 + 12]! ^= 0x01;

    const openedWrapped = await openSealedCast({
      text: SEALED_CAST_PREFIX + bytesToBase64Url(wrappedTampered),
      identity: recipient,
    });

    expect(openedWrapped.status).toBe('failed');

    expect(envelope.ciphertext.length).toBe(utf8ToBytes(MESSAGE).length + 16);
  });

  it('says what is wrong with text that is not a sealed cast at all', async () => {
    const opened = await openSealedCast({
      text: 'just a normal cast',
      identity: recipient,
    });

    expect(opened.status).toBe('failed');
    expect(opened.status !== 'opened' && opened.reason).toMatch(
      /not a sealed cast/,
    );
  });

  it('describes a cast it cannot open without any key at all', async () => {
    const one = await sealCast({
      plaintext: MESSAGE,
      recipientShares: [recipient.share],
    });
    const two = await sealCast({
      plaintext: MESSAGE,
      recipientShares: [recipient.share, stranger.share],
      recipientLimit: 2,
      limitBytes: LONG_CAST_TEXT_LIMIT_BYTES,
    });

    expect(sealedCastRecipients(one.text)).toBe(1);
    expect(sealedCastRecipients(two.text)).toBe(2);
    expect(sealedCastRecipients('not sealed')).toBeNull();
    expect(sealedCastRecipients('fdy-seal-1:ab')).toBeNull();
  });
});
