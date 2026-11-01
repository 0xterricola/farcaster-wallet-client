/**
 * The recovery phrase: made here, checked here, used here.
 *
 * A new Farcaster account in this client starts as twelve words generated in
 * this browser. They are the account's custody key — the thing that can add or
 * remove signing keys, claim a username, and prove who owns the FID — so they
 * are never sent to Fiddy, never logged, and never typed into a field we hold on
 * a server. Everything downstream (registration on Optimism, the profile, the
 * app key) is derived from them locally.
 *
 * PATH AND COMPATIBILITY: the key is derived exactly the way Warpcast, Quorum
 * and other clients derive it — BIP-39 seed, path m/44'/60'/0'/0/0 — so a phrase
 * this client generates opens the same account anywhere else it is entered, and
 * a phrase from another client opens the same account here.
 *
 * VALIDATION without adding a dependency: viem ships the BIP-39 English wordlist
 * and the derivation, but not a validator. The check below is the real one — the
 * words must be in the list AND the trailing checksum bits must match SHA-256 of
 * the entropy those words spell out — so a mistyped word is caught before it is
 * used to derive an address that would own nothing.
 */

import { bytesToHex, generateAppKey } from 'farcaster-node-client';
import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';

/** Twelve words: 128 bits of entropy, the length every Farcaster client uses. */
export const PHRASE_ENTROPY_BITS = 128;

/** The lengths BIP-39 defines, in words. */
const VALID_PHRASE_LENGTHS = [12, 15, 18, 21, 24] as const;

/** One word is eleven bits. */
const BITS_PER_WORD = 11n;

const wordlist = english as readonly string[];

let wordIndex: Map<string, number> | undefined;

const indexOfWord = (word: string): number | undefined => {
  if (!wordIndex) {
    wordIndex = new Map(wordlist.map((entry, index) => [entry, index]));
  }

  return wordIndex.get(word);
};

/**
 * Trim, lowercase and collapse whitespace: what a person pastes from a note is
 * the same phrase as what they type, and case never carries meaning in BIP-39.
 */
const normalizePhrase = (phrase: string): string =>
  phrase
    .normalize('NFKD')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(' ');

/** A fresh twelve-word phrase, generated on this device. */
export const generateRecoveryPhrase = (): string =>
  generateMnemonic(english, PHRASE_ENTROPY_BITS);

const sha256Bits = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as unknown as BufferSource,
  );
  return new Uint8Array(digest);
};

export type PhraseCheck =
  | { valid: true; normalized: string }
  | { valid: false; reason: string };

/**
 * Is this a real recovery phrase? The words, then the checksum.
 *
 * Returns a sentence for the reason, because the only reader of this is someone
 * who typed something and needs to know which part is wrong.
 */
export const checkRecoveryPhrase = async (
  phrase: string,
): Promise<PhraseCheck> => {
  const normalized = normalizePhrase(phrase);

  if (normalized.length === 0) {
    return { valid: false, reason: 'no words yet' };
  }

  const words = normalized.split(' ');

  if (!VALID_PHRASE_LENGTHS.includes(words.length as 12)) {
    return {
      valid: false,
      reason: `${words.length} words is not a recovery phrase - they are 12, 15, 18, 21 or 24 words`,
    };
  }

  const indices: number[] = [];

  for (const word of words) {
    const index = indexOfWord(word);

    if (index === undefined) {
      return {
        valid: false,
        reason: `"${word}" is not one of the words a recovery phrase can contain`,
      };
    }

    indices.push(index);
  }

  const totalBits = BITS_PER_WORD * BigInt(words.length);
  const checksumBits = totalBits / 33n;
  const entropyBits = totalBits - checksumBits;

  // The words, read back as one big bit string.
  let bits = 0n;
  for (const index of indices) {
    bits = (bits << BITS_PER_WORD) | BigInt(index);
  }

  const checksum = bits & ((1n << checksumBits) - 1n);
  const entropyNumber = bits >> checksumBits;
  const entropy = new Uint8Array(Number(entropyBits / 8n));
  for (let i = entropy.length - 1; i >= 0; i--) {
    entropy[i] = Number(
      (entropyNumber >> BigInt(8 * (entropy.length - 1 - i))) & 0xffn,
    );
  }

  const digest = await sha256Bits(entropy);

  let expected = 0n;
  const neededBytes = Number((checksumBits + 7n) / 8n);
  for (let i = 0; i < neededBytes; i++) {
    expected = (expected << 8n) | BigInt(digest[i] ?? 0);
  }
  expected >>= BigInt(neededBytes * 8) - checksumBits;

  if (expected !== checksum) {
    return {
      valid: false,
      reason:
        'one of those words is not the word that belongs there - check the order and the spelling',
    };
  }

  return { valid: true, normalized };
};

/** What this client needs from a custody key: an address, a signature, an
 *  EIP-712 signature, and a signing key for the app key it will add. */
export interface CustodyAccount {
  address: `0x${string}`;
  signTransaction: (transaction: unknown) => Promise<`0x${string}`>;
  signTypedData: (parameters: unknown) => Promise<`0x${string}`>;
}

/** The custody account a phrase spells out. Same phrase, same address, anywhere. */
export const custodyAccountFromPhrase = (phrase: string): CustodyAccount =>
  mnemonicToAccount(normalizePhrase(phrase)) as unknown as CustodyAccount;

/**
 * A fresh signing key for this device, as the hex a key is stored in.
 *
 * The protocol's message signers are Ed25519, which is a different key type from
 * the Ethereum key above on purpose: the app key can sign casts and likes, and
 * it can never move the account.
 */
export const generateDeviceSigningKey = async (): Promise<string> =>
  bytesToHex((await generateAppKey()).privateKey);

export { normalizePhrase };
