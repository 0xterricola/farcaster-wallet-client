// @vitest-environment node
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { describe, expect, it, vi } from 'vitest';

import {
  fidFromSignedMessage,
  isInsideMiniAppHost,
  loadMiniAppHostSdk,
  signInInsideMiniApp,
} from '~/lib/miniAppSession';
import { isLocalSessionToken } from '~/lib/siwfSession';
import { isSignedIn } from '~/utils/userUtils';

const DOMAIN = 'fiddy.fun';
const SIWE_URI = 'https://fiddy.fun/login';

// A throwaway key, generated for this test and used nowhere else.
const ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const CONTEXT_FID = 191554;

/**
 * A SIWF message of the shape a Farcaster host signs.
 *
 * The fid travels in the message's `resources`, which is where the host-side
 * `createSiwfMessage` (`farcaster-client-data`) puts it when this client hosts a
 * Mini App — so the account a signature covers is checkable, not just claimed.
 */
const hostSignedMessage = async ({
  nonce,
  fid = CONTEXT_FID,
  address = ACCOUNT.address,
  domain = DOMAIN,
  withFidResource = true,
}: {
  nonce: string;
  fid?: number;
  address?: `0x${string}`;
  domain?: string;
  withFidResource?: boolean;
}) => {
  const message = createSiweMessage({
    address,
    chainId: 10,
    domain,
    nonce,
    uri: SIWE_URI,
    version: '1',
    statement: 'Farcaster Auth',
    resources: withFidResource ? [`farcaster://fid/${fid}`] : undefined,
  });

  const signature = await ACCOUNT.signMessage({ message });

  return { message, signature };
};

/** A host, as the app-side SDK presents one. Only what we drive is here. */
const host = ({
  inHost = true,
  fid = CONTEXT_FID,
  username = 'ivc',
  displayName = 'Ivc',
  pfpUrl = 'https://example.com/pfp.png',
  ready,
  signIn,
}: {
  inHost?: boolean;
  fid?: number | undefined;
  username?: string;
  displayName?: string;
  pfpUrl?: string;
  ready?: () => Promise<void>;
  signIn?: (options: { nonce: string }) => Promise<{
    message: string;
    signature: `0x${string}`;
  }>;
} = {}) => {
  const readySpy = vi.fn(ready ?? (async () => undefined));
  const signInSpy = vi.fn(
    signIn ??
      (async ({ nonce }: { nonce: string }) =>
        await hostSignedMessage({ nonce })),
  );

  return {
    sdk: {
      isInMiniApp: async () => inHost,
      context: Promise.resolve({
        client: { clientFid: 9152, added: false },
        user: { fid: fid as number, username, displayName, pfpUrl },
      }),
      actions: { ready: readySpy, signIn: signInSpy },
    },
    readySpy,
    signInSpy,
  };
};

describe('isInsideMiniAppHost', () => {
  it('believes the SDK, which is what actually knows', async () => {
    expect(await isInsideMiniAppHost({ sdk: host({ inHost: true }).sdk })).toBe(
      true,
    );
    expect(
      await isInsideMiniAppHost({ sdk: host({ inHost: false }).sdk }),
    ).toBe(false);
  });

  it('answers false rather than throwing when the host never replies', async () => {
    const sdk = host().sdk;
    sdk.isInMiniApp = async () => {
      throw new Error('no host, no answer');
    };

    expect(await isInsideMiniAppHost({ sdk })).toBe(false);
  });
});

describe('loadMiniAppHostSdk', () => {
  it('loads a real SDK with the two things this flow drives', async () => {
    const sdk = await loadMiniAppHostSdk();

    expect(sdk).toBeTruthy();
    expect(typeof sdk?.isInMiniApp).toBe('function');
    expect(typeof sdk?.actions?.ready).toBe('function');
    expect(typeof sdk?.actions?.signIn).toBe('function');
  });
});

describe('fidFromSignedMessage', () => {
  it('reads the fid out of the message the host signed', async () => {
    const { message } = await hostSignedMessage({ nonce: 'a'.repeat(32) });

    expect(message).toContain('farcaster://fid/191554');
    expect(fidFromSignedMessage(message)).toBe(191554);
  });

  it('says undefined rather than guessing when the message names no fid', () => {
    const plain = createSiweMessage({
      address: ACCOUNT.address,
      chainId: 10,
      domain: DOMAIN,
      nonce: 'a'.repeat(32),
      uri: SIWE_URI,
      version: '1',
    });

    expect(fidFromSignedMessage(plain)).toBeUndefined();
    expect(fidFromSignedMessage('not a siwe message')).toBeUndefined();
  });
});

describe('signInInsideMiniApp', () => {
  it('signs in from the host context with no QR and no typing', async () => {
    const { sdk, readySpy, signInSpy } = host({});

    const outcome = await signInInsideMiniApp({ sdk, domain: DOMAIN });

    expect(outcome.status).toBe('signed-in');

    if (outcome.status !== 'signed-in') {
      return;
    }

    // The host's own splash came down...
    expect(readySpy).toHaveBeenCalledTimes(1);
    expect(outcome.readyAnnounced).toBe(true);

    // ...the fid is the signed one, and it opens the app's real signed-in gate.
    expect(outcome.fid).toBe(CONTEXT_FID);
    expect(outcome.fidBoundToSignature).toBe(true);
    expect(outcome.username).toBe('ivc');
    expect(isLocalSessionToken(outcome.authToken)).toBe(true);
    expect(isSignedIn({ onboardingState: outcome.onboardingState })).toBe(true);
    expect(outcome.onboardingState.result.state.user?.pfp?.url).toBe(
      'https://example.com/pfp.png',
    );

    // The nonce we asked for is the nonce inside the message that was signed:
    // this is what makes a signature from another session useless here.
    const asked = signInSpy.mock.calls[0][0].nonce;
    expect(asked).toHaveLength(64);
    expect(outcome.readyAnnounced).toBe(true);
  });

  it('refuses a host that will not name an account, and asks for no signature', async () => {
    const { sdk, signInSpy } = host({});
    // A host that hands over a context with nobody in it.
    (sdk as { context: Promise<unknown> }).context = Promise.resolve({
      client: { clientFid: 9152, added: false },
      user: {},
    });

    const outcome = await signInInsideMiniApp({ sdk, domain: DOMAIN });

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toContain(
      'did not say who you are',
    );
    expect(signInSpy).not.toHaveBeenCalled();
  });

  it('refuses a signature made for a different nonce', async () => {
    const { sdk } = host({
      signIn: async () => await hostSignedMessage({ nonce: 'b'.repeat(32) }),
    });

    const outcome = await signInInsideMiniApp({ sdk, domain: DOMAIN });

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toContain('nonce');
  });

  it('refuses a signature made for another domain', async () => {
    const { sdk } = host({
      signIn: async ({ nonce }) =>
        await hostSignedMessage({ nonce, domain: 'evil.example' }),
    });

    const outcome = await signInInsideMiniApp({ sdk, domain: DOMAIN });

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toContain(
      'evil.example',
    );
  });

  it('refuses when the signature names a different account than the host', async () => {
    const { sdk } = host({
      signIn: async ({ nonce }) => await hostSignedMessage({ nonce, fid: 3 }),
    });

    const outcome = await signInInsideMiniApp({ sdk, domain: DOMAIN });

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toContain('fid 3');
    expect(outcome.status === 'refused' && outcome.reason).toContain(
      `fid ${CONTEXT_FID}`,
    );
  });

  it('refuses a tampered message rather than trusting the host', async () => {
    const { sdk } = host({
      signIn: async ({ nonce }) => {
        const proof = await hostSignedMessage({ nonce });
        return {
          ...proof,
          message: proof.message.replace(ACCOUNT.address, '0x'.padEnd(42, '1')),
        };
      },
    });

    const outcome = await signInInsideMiniApp({ sdk, domain: DOMAIN });

    expect(outcome.status).toBe('refused');
  });

  it('takes a "no" from the person as an outcome, not an exception', async () => {
    const { sdk } = host({
      signIn: async () => {
        throw new Error('SignIn.RejectedByUser');
      },
    });

    const outcome = await signInInsideMiniApp({ sdk, domain: DOMAIN });

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toContain(
      'not approved',
    );
  });

  it('gives up on a host that never answers, rather than waiting forever', async () => {
    const { sdk } = host({
      signIn: () => new Promise<never>(() => undefined),
    });

    const outcome = await signInInsideMiniApp({
      sdk,
      domain: DOMAIN,
      timeoutMs: 25,
    });

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toContain(
      'did not answer',
    );
  });

  it('still signs in when the host will not take ready()', async () => {
    const { sdk } = host({
      ready: async () => {
        throw new Error('unsupported');
      },
    });

    const outcome = await signInInsideMiniApp({ sdk, domain: DOMAIN });

    expect(outcome.status).toBe('signed-in');
    expect(outcome.status === 'signed-in' && outcome.readyAnnounced).toBe(
      false,
    );
  });

  it('does nothing at all when the page is not inside a host', async () => {
    const { sdk, readySpy, signInSpy } = host({ inHost: false });

    const outcome = await signInInsideMiniApp({ sdk, domain: DOMAIN });

    expect(outcome.status).toBe('not-a-host');
    expect(readySpy).not.toHaveBeenCalled();
    expect(signInSpy).not.toHaveBeenCalled();
  });

  it('falls back to the host context, and says the fid is unproven, when the message names no fid', async () => {
    const { sdk } = host({
      signIn: async ({ nonce }) =>
        await hostSignedMessage({ nonce, withFidResource: false }),
    });

    const outcome = await signInInsideMiniApp({ sdk, domain: DOMAIN });

    expect(outcome.status).toBe('signed-in');
    expect(outcome.status === 'signed-in' && outcome.fid).toBe(CONTEXT_FID);
    expect(outcome.status === 'signed-in' && outcome.fidBoundToSignature).toBe(
      false,
    );
  });
});
