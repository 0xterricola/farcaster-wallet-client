/**
 * Claiming the @name: what is asked of the registry, and what is believed.
 *
 * Two things are pinned here. First, that the answer to "is this name free?" can
 * be "we do not know" — a registry that is unreachable must never be reported as
 * a free name, because the next step spends money. Second, that the claim is
 * signed by the account's own custody key over the exact struct the registry
 * checks, and that a name already belonging to this FID counts as done rather
 * than as a failure.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CustodyAccount } from '~/snapchain/accounts/phrase';
import {
  checkNameAvailability,
  claimName,
  FNAME_REGISTRY_URL,
  isClaimableName,
  nameProofTypedData,
} from '~/snapchain/accounts/username';

const CUSTODY_ADDRESS =
  '0x2222222222222222222222222222222222222222' as `0x${string}`;

const custody = (): CustodyAccount => ({
  address: CUSTODY_ADDRESS,
  signTransaction: vi.fn(async () => `0x${'ab'.repeat(100)}` as `0x${string}`),
  signTypedData: vi.fn(async () => `0x${'cd'.repeat(65)}` as `0x${string}`),
});

describe('what a name may look like', () => {
  it('accepts lowercase letters, digits and dashes, starting with either', () => {
    expect(isClaimableName('fiddy')).toBe(true);
    expect(isClaimableName('f1ddy-2')).toBe(true);
    expect(isClaimableName('a')).toBe(true);
  });

  it('refuses the shapes the registry refuses', () => {
    // Case is not one of them: a name is lowercased before it is asked about
    // (that is what "Fiddy" means here), so only the shapes below are wrong.
    expect(isClaimableName('-fiddy')).toBe(false);
    expect(isClaimableName('fiddy-')).toBe(false);
    expect(isClaimableName('fiddy.name')).toBe(false);
    expect(isClaimableName('')).toBe(false);
    expect(isClaimableName('a'.repeat(17))).toBe(false);
  });

  it('lowercases what it is given, so a capital letter is not an error', () => {
    expect(isClaimableName('Fiddy')).toBe(true);
    expect(isClaimableName('  FIDDY  ')).toBe(true);
  });
});

describe('asking whether a name is free', () => {
  it('reads 404 as free and 200 as taken', async () => {
    const free = vi.fn(async () => new Response('{}', { status: 404 }));
    const taken = vi.fn(async () => new Response('{}', { status: 200 }));

    await expect(
      checkNameAvailability({
        name: 'fiddy',
        fetchImpl: free as unknown as typeof fetch,
      }),
    ).resolves.toBe('free');

    await expect(
      checkNameAvailability({
        name: 'fiddy',
        fetchImpl: taken as unknown as typeof fetch,
      }),
    ).resolves.toBe('taken');
  });

  it('asks the registry about the lowercased name', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(String(url));
      return new Response('{}', { status: 404 });
    });

    await checkNameAvailability({
      name: 'Fiddy',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(seen[0]).toBe(`${FNAME_REGISTRY_URL}/transfers/current?name=fiddy`);
  });

  it('never reports a name as free when the registry cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(
      checkNameAvailability({
        name: 'fiddy',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe('unknown');
  });

  it('says "invalid" for a name it would not even ask about', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));

    await expect(
      checkNameAvailability({
        name: '-nope-',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe('invalid');

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('claiming the name', () => {
  it("signs the registry's own struct, and posts the signature with the FID", async () => {
    const account = custody();
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });

      if (String(url).includes('/transfers/current')) {
        return new Response('{}', { status: 404 });
      }

      return new Response('{}', { status: 200 });
    });

    const result = await claimName({
      name: 'fiddy',
      fid: 4242,
      custody: account,
      now: 1_700_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true });

    const typed = (account.signTypedData as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];

    expect(typed).toEqual(
      nameProofTypedData({
        name: 'fiddy',
        timestamp: 1_700_000_000,
        owner: CUSTODY_ADDRESS,
      }),
    );
    expect(typed.domain.verifyingContract).toBe(
      '0xe3be01d99baa8db9905b33a3ca391238234b79d1',
    );

    const post = calls.find(
      (call) => call.url === `${FNAME_REGISTRY_URL}/transfers`,
    );

    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      name: 'fiddy',
      from: 0,
      to: 4242,
      fid: 4242,
      timestamp: 1_700_000_000,
      owner: CUSTODY_ADDRESS,
      signature: `0x${'cd'.repeat(65)}`,
    });
  });

  it('treats a name this FID already holds as done', async () => {
    const account = custody();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ transfer: { to: 4242 } }), {
          status: 200,
        }),
    );

    await expect(
      claimName({
        name: 'fiddy',
        fid: 4242,
        custody: account,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ ok: true });

    expect(account.signTypedData).not.toHaveBeenCalled();
  });

  it('says who has the name when somebody else does', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ transfer: { to: 99 } }), { status: 200 }),
    );

    await expect(
      claimName({
        name: 'fiddy',
        fid: 4242,
        custody: custody(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: '@fiddy is already taken' });
  });

  it('reports a refused claim the way the registry worded it', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/transfers/current')) {
        return new Response('{}', { status: 404 });
      }

      return new Response(JSON.stringify({ code: 'invalid_signature' }), {
        status: 400,
      });
    });

    await expect(
      claimName({
        name: 'fiddy',
        fid: 4242,
        custody: custody(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'the name registry refused: invalid_signature',
    });
  });

  it('does not ask for a signature it cannot use', async () => {
    const account = custody();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));

    await expect(
      claimName({
        name: 'FIDDY!',
        fid: 4242,
        custody: account,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'that name uses characters the name registry does not accept',
    });

    expect(account.signTypedData).not.toHaveBeenCalled();
  });
});
