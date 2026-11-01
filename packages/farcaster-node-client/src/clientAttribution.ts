/**
 * Which app made a cast. Resolved from the protocol, never guessed.
 *
 * A Farcaster cast carries no "client" field. What it carries is the `signer`
 * public key that signed it, and the protocol keeps a record of *who asked for
 * that key*: every `KEY_ADD` (gasless or on-chain) carries a
 * `SignedKeyRequestMetadata` whose `requestFid` is the FID of the app that
 * requested the key. So "which client is this cast from" is answerable from the
 * node alone:
 *
 *   - the gasless form puts `requestFid` straight on the signer record
 *     (`GET /v1/signer` — verified against a live node);
 *   - the on-chain form ABI-encodes it into the signer event's `metadata`
 *     (`SignedKeyRequestMetadata.requestFid`, word 1 of the tuple). MEASURED
 *     2026-10-24 against a live mainnet node: 15 casts taken from an open
 *     channel feed, every one resolved to the SAME app FID the hosted indexer
 *     reports (`app.fid`), and never once to a different one — 9152 for the
 *     posts made through Warpcast, 3356396 and 16823 for the other apps in the
 *     window.
 *
 * The *name* is a second read, and it is not invented either: an app FID is a
 * real Farcaster account with its own profile, so the name of the app is that
 * account's own `USER_DATA_ADD` messages. FID 9152 says `warpcast` /
 * `Warpcast`; FID 3356372 says `fiddy-one` / `fiddy one`. An app FID with no
 * profile stays nameless (`app 3356396`) rather than being given a vendor name
 * this package made up.
 *
 * Both halves are cached per signer key / per app FID, because one page of
 * feed is ~25 casts from ~20 keys.
 */

import type { SnapchainNodeClient } from './http';
import type { NodeSigner, NodeUserDataTypeName } from './types';

/** The ABI-decoded `SignedKeyRequestMetadata` a signed key request carries. */
export interface SignedKeyRequestMetadata {
  /** FID of the app that requested the key. */
  requestFid?: number;
  /** Address of the app's request signer, when the metadata is well-formed. */
  requestSigner?: string;
  /** Unix seconds after which the request is void. */
  deadline?: number;
}

/** `METADATA_TYPE_SIGNED_KEY_REQUEST` in the Farcaster protobuf. */
const METADATA_TYPE_SIGNED_KEY_REQUEST = 1;

/**
 * The largest uint256 word that can still be a plausible ABI *offset*: a real
 * encoded tuple is a few hundred bytes, so a first word in the millions is a
 * value (a FID, an address) rather than a pointer.
 */
const MAX_PLAUSIBLE_TUPLE_OFFSET = 4096;

/** A FID fits in 32 bits; anything larger is a mis-read word. */
const MAX_PLAUSIBLE_FID = 0xffff_ffff;

const utf8ToBytes = (value: string): Uint8Array | undefined => {
  if (typeof atob === 'function') {
    try {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * The node's signer JSON gives the metadata as base64; the protobuf field is
 * bytes. Some servers hand back 0x-hex instead, so both are accepted — the
 * decoder refuses anything it cannot read rather than guessing.
 */
export const signerMetadataBytes = (
  metadata: string | undefined,
): Uint8Array | undefined => {
  if (!metadata) {
    return undefined;
  }
  const trimmed = metadata.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/^0x[0-9a-fA-F]*$/.test(trimmed)) {
    const hex = trimmed.slice(2);
    if (hex.length % 2 !== 0) {
      return undefined;
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) {
        return undefined;
      }
      bytes[i] = byte;
    }
    return bytes;
  }
  return utf8ToBytes(trimmed);
};

/**
 * Decode `abi.encode(SignedKeyRequestMetadata)`.
 *
 * The struct is `(uint256 requestFid, address requestSigner, bytes signature,
 * uint256 deadline)`, and what the chain holds is the whole encoding, whose
 * first word is sometimes the offset to the tuple (a dynamic-struct encoding)
 * and sometimes the first field. Both shapes are real, so the offset is only
 * honoured when it actually points inside the data — a decoder that trusted it
 * blindly would read a FID out of an address.
 */
export const decodeSignedKeyRequestMetadata = (
  metadata: string | undefined,
): SignedKeyRequestMetadata | undefined => {
  const bytes = signerMetadataBytes(metadata);
  if (!bytes || bytes.length < 64) {
    return undefined;
  }
  const wordCount = Math.floor(bytes.length / 32);
  const rawWord = (index: number): Uint8Array | undefined => {
    if (index < 0 || index >= wordCount) {
      return undefined;
    }
    return bytes.subarray(index * 32, index * 32 + 32);
  };
  /** A word as a Number, or -1 when it cannot be one (an address, a signature). */
  const word = (index: number): number => {
    const raw = rawWord(index);
    if (!raw) {
      return -1;
    }
    let value = 0;
    for (const byte of raw) {
      value = value * 256 + byte;
      if (value > Number.MAX_SAFE_INTEGER) {
        // The only fields we want are small (a FID, a deadline); a word this
        // large is an address or a signature, and it is not one of ours.
        return -1;
      }
    }
    return value;
  };

  const first = word(0);
  let tupleStart = 0;
  if (
    first >= 0 &&
    first % 32 === 0 &&
    first > 0 &&
    first <= MAX_PLAUSIBLE_TUPLE_OFFSET &&
    first / 32 + 1 < wordCount
  ) {
    tupleStart = first / 32;
  }

  const requestFid = word(tupleStart);
  if (requestFid <= 0 || requestFid > MAX_PLAUSIBLE_FID) {
    return undefined;
  }

  const deadline = word(tupleStart + 3);
  const requestSignerWord = rawWord(tupleStart + 1);
  const decoded: SignedKeyRequestMetadata = { requestFid };
  if (deadline > 0) {
    decoded.deadline = deadline;
  }
  if (requestSignerWord) {
    // The low 20 bytes of the word are the address; hex it as such.
    const address = requestSignerWord.subarray(12);
    if (address.some((byte) => byte !== 0)) {
      decoded.requestSigner = `0x${[...address]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')}`;
    }
  }
  return decoded;
};

/**
 * The app FID behind a signer record, from whichever half of the protocol
 * carries it: the gasless record names the requester directly, an on-chain
 * record carries it ABI-encoded in the signer event's metadata.
 */
export const appFidFromSignerRecord = (
  signer: NodeSigner | undefined,
): number | undefined => {
  if (!signer) {
    return undefined;
  }
  if (
    typeof signer.requestFid === 'number' &&
    Number.isSafeInteger(signer.requestFid) &&
    signer.requestFid > 0
  ) {
    return signer.requestFid;
  }
  if (
    typeof signer.metadataType === 'number' &&
    signer.metadataType !== METADATA_TYPE_SIGNED_KEY_REQUEST
  ) {
    // Some other metadata kind: it does not carry a signed key request.
    return undefined;
  }
  return decodeSignedKeyRequestMetadata(signer.metadata)?.requestFid;
};

/** An app FID's own profile — what the app calls itself on the protocol. */
export interface AppClientName {
  fid: number;
  /** The app account's handle, when it has one (`warpcast`). */
  username?: string;
  /** The app account's display name, when it has one (`Warpcast`). */
  displayName?: string;
  /** The app account's picture, when it has one. */
  pfpUrl?: string;
}

/** What an app FID calls itself, or `undefined` when nothing could be read. */
export type AppClientNameLookup = (
  appFid: number,
) => Promise<AppClientName | undefined>;

const NAME_TTL_MS = 30 * 60_000;

interface NameCacheEntry {
  at: number;
  value: AppClientName | undefined;
}

/**
 * Read an app FID's own profile from the node, once per app FID per half hour.
 *
 * One page of feed names at most a handful of apps, and an app's profile
 * changes on the order of never, so the read is cached hard. A read that fails
 * is cached too (briefly) — a deleted account or a dropped request must not
 * turn into one retry per cast.
 */
export const createAppClientNameLookup = ({
  node,
  ttlMs = NAME_TTL_MS,
}: {
  node: SnapchainNodeClient;
  ttlMs?: number;
}): AppClientNameLookup => {
  const cache = new Map<number, NameCacheEntry>();
  const inFlight = new Map<number, Promise<AppClientName | undefined>>();

  const valueFor = (
    fid: number,
    messages: { userDataType?: NodeUserDataTypeName; value?: string }[],
  ): AppClientName => {
    // User data is a log: the newest message for a field is the current value.
    const latest = (type: NodeUserDataTypeName): string | undefined => {
      let value: string | undefined;
      for (const message of messages) {
        if (message.userDataType === type && message.value) {
          value = message.value;
        }
      }
      return value;
    };
    const name: AppClientName = { fid };
    const username = latest('USER_DATA_TYPE_USERNAME');
    const displayName = latest('USER_DATA_TYPE_DISPLAY');
    const pfpUrl = latest('USER_DATA_TYPE_PFP');
    if (username) {
      name.username = username;
    }
    if (displayName) {
      name.displayName = displayName;
    }
    if (pfpUrl) {
      name.pfpUrl = pfpUrl;
    }
    return name;
  };

  return async (appFid: number): Promise<AppClientName | undefined> => {
    const cached = cache.get(appFid);
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.value;
    }
    const pending = inFlight.get(appFid);
    if (pending) {
      return pending;
    }
    const read = (async () => {
      try {
        const page = await node.userDataByFid({ fid: appFid, pageSize: 32 });
        const name = valueFor(
          appFid,
          page.messages.map((m) => m.userData ?? {}),
        );
        cache.set(appFid, { at: Date.now(), value: name });
        return name;
      } catch {
        cache.set(appFid, { at: Date.now(), value: undefined });
        return undefined;
      } finally {
        inFlight.delete(appFid);
      }
    })();
    inFlight.set(appFid, read);
    return read;
  };
};
