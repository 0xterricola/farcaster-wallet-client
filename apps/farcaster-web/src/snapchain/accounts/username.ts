/**
 * The @name: is it free, and can we prove it is ours?
 *
 * An FID gives you a number. The handle people type is a separate claim, held by
 * the name registry: you ask for a name, you sign a message proving you speak for
 * the FID you want it moved to, and the registry records the transfer. This
 * client signs that message with the account's own custody key — locally, on the
 * device that generated the phrase — so no Fiddy server is in the loop and no
 * phrase is asked for twice.
 *
 * The registry is the only authority here, and it is asked, not assumed: a name
 * is offered only after the registry says the name is free, and a claim is only
 * reported as done after the registry accepts the transfer.
 */

import type { CustodyAccount } from './phrase';

/** Where names live. One https endpoint, no key, no account. */
export const FNAME_REGISTRY_URL = 'https://fnames.farcaster.xyz';

/** The name-verification contract the registry checks the signature against. */
const NAME_VERIFICATION_CONTRACT =
  '0xe3be01d99baa8db9905b33a3ca391238234b79d1' as const;

/**
 * What a name may look like: lowercase letters, digits and dashes, 1–16
 * characters, starting AND ending with a letter or a digit.
 *
 * This is the client's own rule and it is deliberately the strict side: the
 * registry is the final judge of a name, and a claim it refuses comes back with
 * the registry's own words rather than ours. It is written to match the rule the
 * client already applies to channel keys (see CreateChannelModal), so a person
 * cannot be told two different things about what a valid name is — the one
 * difference being that a name may not end in a dash, which is a shape nobody
 * means to type.
 */
export const NAME_PATTERN = /^[0-9a-z](?:[0-9a-z-]{0,14}[0-9a-z])?$/;

/** The longest a display name may be, matching the profile field's own limit. */
export const DISPLAY_NAME_MAX_LENGTH = 32;

export type NameAvailability = 'free' | 'taken' | 'invalid' | 'unknown';

export class UsernameClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsernameClaimError';
  }
}

/** Is this a name we can even ask about? */
export const isClaimableName = (name: string): boolean =>
  NAME_PATTERN.test(name.trim().toLowerCase());

/**
 * Ask the registry whether a name is spoken for.
 *
 * `unknown` is a real answer and it is not an error: the registry being
 * unreachable must not stop a person from reading the rest of the screen, and
 * the caller is expected to say "we couldn't check" rather than "free".
 */
export const checkNameAvailability = async ({
  name,
  fetchImpl = fetch,
}: {
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<NameAvailability> => {
  const candidate = name.trim().toLowerCase();

  if (!isClaimableName(candidate)) {
    return 'invalid';
  }

  try {
    const response = await fetchImpl(
      `${FNAME_REGISTRY_URL}/transfers/current?name=${encodeURIComponent(candidate)}`,
    );

    if (response.status === 404) {
      return 'free';
    }

    return response.ok ? 'taken' : 'unknown';
  } catch {
    return 'unknown';
  }
};

export type NameClaimResult = { ok: true } | { ok: false; reason: string };

/** What the registry wants signed to move a name to an FID. A flat struct, so
 *  the phrase-derived key here and an external wallet sign the same thing. */
const nameProofTypedData = ({
  name,
  timestamp,
  owner,
}: {
  name: string;
  timestamp: number;
  owner: string;
}) =>
  ({
    domain: {
      name: 'Farcaster name verification',
      version: '1',
      chainId: 1,
      verifyingContract: NAME_VERIFICATION_CONTRACT,
    },
    primaryType: 'UserNameProof',
    types: {
      UserNameProof: [
        { name: 'name', type: 'string' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'owner', type: 'address' },
      ],
    },
    message: { name, timestamp, owner },
  }) as const;

/**
 * Claim a name for an FID, signed by the account's own custody key.
 *
 * Idempotent in the way that matters: a name that is already this FID's is a
 * success rather than an error, because the caller's question is "does this
 * account hold this name", not "did this exact request change anything".
 */
export const claimName = async ({
  name,
  fid,
  custody,
  now = Math.floor(Date.now() / 1000),
  fetchImpl = fetch,
}: {
  name: string;
  fid: number;
  custody: CustodyAccount;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<NameClaimResult> => {
  const candidate = name.trim().toLowerCase();

  if (!isClaimableName(candidate)) {
    return {
      ok: false,
      reason: 'that name uses characters the name registry does not accept',
    };
  }

  let current: { transfer?: { to?: number } };

  try {
    const response = await fetchImpl(
      `${FNAME_REGISTRY_URL}/transfers/current?name=${encodeURIComponent(candidate)}`,
    );

    if (response.status !== 404) {
      current = (await response.json().catch(() => ({}))) as {
        transfer?: { to?: number };
      };

      if (current.transfer?.to === fid) {
        return { ok: true };
      }

      if (typeof current.transfer?.to === 'number') {
        return { ok: false, reason: `@${candidate} is already taken` };
      }
    }
  } catch {
    return {
      ok: false,
      reason: "we couldn't reach the name registry - try again in a moment",
    };
  }

  let signature: `0x${string}`;

  try {
    signature = await custody.signTypedData(
      nameProofTypedData({
        name: candidate,
        timestamp: now,
        owner: custody.address,
      }),
    );
  } catch {
    return { ok: false, reason: 'your account refused to sign the name claim' };
  }

  try {
    const response = await fetchImpl(`${FNAME_REGISTRY_URL}/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: candidate,
        from: 0,
        to: fid,
        fid,
        timestamp: now,
        owner: custody.address,
        signature,
      }),
    });

    if (response.ok) {
      return { ok: true };
    }

    const body = (await response.json().catch(() => ({}))) as { code?: string };

    return {
      ok: false,
      reason: body.code
        ? `the name registry refused: ${body.code}`
        : `the name registry refused @${candidate} (${response.status})`,
    };
  } catch {
    return {
      ok: false,
      reason: "we couldn't reach the name registry - try again in a moment",
    };
  }
};

/** The typed data, for tests and for anyone auditing what gets signed. */
export { nameProofTypedData };
