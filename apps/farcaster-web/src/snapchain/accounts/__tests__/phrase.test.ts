/**
 * The recovery phrase: generated here, checked here.
 *
 * The checksum test is the one that matters. A validator that only asked "are
 * these words in the wordlist?" would accept twelve real words in the wrong
 * order, derive an address from them, and let someone fund an account that the
 * phrase they wrote down does not own. The canonical BIP-39 vectors below are
 * the published ones, so this file proves the implementation against the
 * standard rather than against itself.
 */

import { mnemonicToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  checkRecoveryPhrase,
  custodyAccountFromPhrase,
  generateDeviceSigningKey,
  generateRecoveryPhrase,
  normalizePhrase,
  PHRASE_ENTROPY_BITS,
} from '~/snapchain/accounts/phrase';

/** The published BIP-39 vector for 128 bits of entropy. */
const VECTOR_VALID =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('a phrase this device makes', () => {
  it('is twelve words, and passes the same check a typed one does', async () => {
    const phrase = generateRecoveryPhrase();

    expect(phrase.split(' ')).toHaveLength(12);
    expect(PHRASE_ENTROPY_BITS).toBe(128);

    const check = await checkRecoveryPhrase(phrase);

    expect(check.valid).toBe(true);
  });

  it('derives the same account viem does, on the path every client uses', async () => {
    const phrase = generateRecoveryPhrase();

    expect(custodyAccountFromPhrase(phrase).address).toBe(
      mnemonicToAccount(phrase).address,
    );
  });

  it('gives the same address for the same words, every time', () => {
    const first = custodyAccountFromPhrase(VECTOR_VALID).address;

    expect(
      custodyAccountFromPhrase(`  ${VECTOR_VALID.toUpperCase()}  `).address,
    ).toBe(first);
  });
});

describe('checking words someone typed', () => {
  it('accepts the published vector', async () => {
    await expect(checkRecoveryPhrase(VECTOR_VALID)).resolves.toEqual({
      valid: true,
      normalized: VECTOR_VALID,
    });
  });

  it('survives a paste: extra spaces, mixed case, a trailing newline', async () => {
    const messy = `  Abandon   abandon abandon abandon abandon abandon\nabandon abandon abandon abandon abandon  About `;

    await expect(checkRecoveryPhrase(messy)).resolves.toEqual({
      valid: true,
      normalized: VECTOR_VALID,
    });
  });

  it('refuses twelve real words whose checksum does not match', async () => {
    const wrong = VECTOR_VALID.replace(/about$/, 'abandon');

    const check = await checkRecoveryPhrase(wrong);

    expect(check.valid).toBe(false);
    expect(check.valid === false && check.reason).toMatch(
      /not the word that belongs there/,
    );
  });

  it('refuses a word that is not in the wordlist, and names it', async () => {
    const typo = VECTOR_VALID.replace(/^abandon/, 'abandom');

    const check = await checkRecoveryPhrase(typo);

    expect(check.valid).toBe(false);
    expect(check.valid === false && check.reason).toContain('"abandom"');
  });

  it('refuses the wrong number of words before anything else', async () => {
    const check = await checkRecoveryPhrase('abandon abandon abandon');

    expect(check.valid).toBe(false);
    expect(check.valid === false && check.reason).toMatch(/3 words/);
  });

  it('says "no words yet" for an empty box, not a scary error', async () => {
    const check = await checkRecoveryPhrase('   ');

    expect(check.valid).toBe(false);
    expect(check.valid === false && check.reason).toBe('no words yet');
  });
});

describe("this device's signing key", () => {
  it('is a fresh 32-byte key every time', async () => {
    const [first, second] = await Promise.all([
      generateDeviceSigningKey(),
      generateDeviceSigningKey(),
    ]);

    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });
});

describe('normalising', () => {
  it('collapses whitespace and lowercases, because BIP-39 never carries case', () => {
    expect(normalizePhrase('  ABANDON\tAbout \n')).toBe('abandon about');
  });
});
