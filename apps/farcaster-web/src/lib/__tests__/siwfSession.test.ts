// @vitest-environment node
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildLocalAuthToken,
  buildLocalOnboardingState,
  createSiwfChannel,
  isLocalSessionToken,
  SiwfRelayError,
  SiwfTimeoutError,
  verifySiwfCompletion,
  watchSiwfChannel,
} from '~/lib/siwfSession';
import { isSignedIn } from '~/utils/userUtils';

const DOMAIN = 'localhost:5173';
const SIWE_URI = 'https://localhost:5173/login';

// A throwaway key, generated for this test and used nowhere else.
const ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const signMessage = async ({
  domain = DOMAIN,
  nonce,
}: {
  domain?: string;
  nonce: string;
}) => {
  const message = createSiweMessage({
    address: ACCOUNT.address,
    chainId: 10,
    domain,
    nonce,
    uri: SIWE_URI,
    version: '1',
  });

  const signature = await ACCOUNT.signMessage({ message });

  return { message, signature };
};

describe('verifySiwfCompletion', () => {
  const nonce = 'a'.repeat(128);

  it('accepts a signature that proves the address and nonce it claims', async () => {
    const { message, signature } = await signMessage({ nonce });

    const result = await verifySiwfCompletion({
      message,
      signature,
      nonce,
      domain: DOMAIN,
    });

    expect(result.verified).toBe(true);
    expect(result.address?.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
  });

  it('rejects a signature made for a different nonce', async () => {
    const { message, signature } = await signMessage({ nonce });

    const result = await verifySiwfCompletion({
      message,
      signature,
      nonce: 'b'.repeat(128),
      domain: DOMAIN,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('nonce');
  });

  it('rejects a signature made for a different domain', async () => {
    const { message, signature } = await signMessage({
      nonce,
      domain: 'evil.example',
    });

    const result = await verifySiwfCompletion({
      message,
      signature,
      nonce,
      domain: DOMAIN,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('evil.example');
  });

  it('rejects a tampered message rather than trusting the relay', async () => {
    const { message, signature } = await signMessage({ nonce });
    const tampered = message.replace(ACCOUNT.address, '0x'.padEnd(42, '1'));

    const result = await verifySiwfCompletion({
      message: tampered,
      signature,
      nonce,
      domain: DOMAIN,
    });

    expect(result.verified).toBe(false);
  });

  it('reports unparseable input as unverified instead of throwing', async () => {
    const result = await verifySiwfCompletion({
      message: 'not a siwe message',
      signature: '0xdeadbeef',
      nonce,
      domain: DOMAIN,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('createSiwfChannel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the relay channel and URL the QR should show', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        channelToken: 'ABC12345',
        url: 'https://farcaster.xyz/~/siwf?channelToken=ABC12345',
        nonce: 'n'.repeat(128),
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const channel = await createSiwfChannel({
      siweUri: SIWE_URI,
      domain: DOMAIN,
    });

    expect(channel.channelToken).toBe('ABC12345');
    expect(channel.url).toBe(
      'https://farcaster.xyz/~/siwf?channelToken=ABC12345',
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe('https://relay.farcaster.xyz/v1/channel');
    expect(JSON.parse(init.body)).toEqual({
      siweUri: SIWE_URI,
      domain: DOMAIN,
    });
  });

  it('turns a dead relay into a typed relay error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    await expect(
      createSiwfChannel({ siweUri: SIWE_URI, domain: DOMAIN }),
    ).rejects.toBeInstanceOf(SiwfRelayError);
  });

  it('turns a non-ok relay answer into a typed relay error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );

    await expect(
      createSiwfChannel({ siweUri: SIWE_URI, domain: DOMAIN }),
    ).rejects.toBeInstanceOf(SiwfRelayError);
  });
});

describe('watchSiwfChannel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('polls past pending and resolves on completed', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return {
          ok: true,
          status: calls < 3 ? 202 : 200,
          json: async () =>
            calls < 3
              ? { state: 'pending', nonce: 'n' }
              : {
                  state: 'completed',
                  nonce: 'n',
                  message: 'msg',
                  signature: '0xabc',
                  fid: 4242,
                },
        };
      }),
    );

    const completion = await watchSiwfChannel({
      channelToken: 'ABC12345',
      pollIntervalMs: 1,
    });

    expect(completion.fid).toBe(4242);
    expect(calls).toBe(3);
  });

  it('sends the channel token as a bearer token, which the relay requires', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        state: 'completed',
        nonce: 'n',
        message: 'm',
        signature: '0xabc',
        fid: 1,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await watchSiwfChannel({ channelToken: 'ABC12345', pollIntervalMs: 1 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toContain('/v1/channel/status?channelToken=ABC12345');
    expect(init.headers.authorization).toBe('Bearer ABC12345');
  });

  it('times out instead of waiting forever on a QR nobody scans', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 202,
        json: async () => ({ state: 'pending', nonce: 'n' }),
      })),
    );

    await expect(
      watchSiwfChannel({
        channelToken: 'ABC12345',
        pollIntervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(SiwfTimeoutError);
  });
});

describe('local session', () => {
  it('marks the token so the app can tell it is not a server token', () => {
    const token = buildLocalAuthToken({ fid: 4242 });

    expect(token.secret.startsWith('siwf-local:')).toBe(true);
    expect(isLocalSessionToken(token)).toBe(true);
    expect(isLocalSessionToken({ secret: 'a-real-api-token' })).toBe(false);
    expect(isLocalSessionToken(undefined)).toBe(false);
  });

  it('expires, rather than pretending to last forever', () => {
    const now = Date.now();
    const token = buildLocalAuthToken({ fid: 1, now });

    expect(token.expiresAt).toBeGreaterThan(now);
  });

  it('opens the app signed-in gate with the fid and handle from the handshake', () => {
    const onboardingState = buildLocalOnboardingState({
      fid: 4242,
      username: 'fiddy',
      displayName: 'Fiddy',
      pfpUrl: 'https://example.com/pfp.png',
    });

    // The real gate the router uses, not a re-implementation of it.
    expect(isSignedIn({ onboardingState })).toBe(true);

    const user = onboardingState.result.state.user;
    expect(user?.fid).toBe(4242);
    expect(user?.username).toBe('fiddy');
    expect(user?.pfp?.url).toBe('https://example.com/pfp.png');
  });

  it('does not claim a server-side registration it never made', () => {
    const state = buildLocalOnboardingState({ fid: 1 }).result.state;

    expect(state.hasCompletedRegistration).toBe(true);
    expect(state.hasStorage).toBe(false);
    expect(state.hasDelegatedSigner).toBe(false);
    expect(state.hasConfirmedEmail).toBe(false);
  });
});
