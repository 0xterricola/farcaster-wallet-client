/**
 * What a social sign-up leaves on this device, and what it must never claim.
 *
 * The tests that matter are the ones about not turning somebody else's wallet
 * into the account's owner, not inventing a handle out of an email, and refusing
 * to build an account at all when no wallet came back — because an account with
 * no custody address is not an account.
 */

import { describe, expect, it } from 'vitest';

import {
  buildSocialAccountRecord,
  describeSocialIdentity,
  isSocialAccount,
  pickSocialIdentity,
  pickSocialWallet,
  type PrivyUserLike,
  shortAddress,
} from '~/lib/socialAccount';
import { describeLocalAccount } from '~/snapchain/accounts/localAccounts';

const EMBEDDED = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';
const INJECTED = '0x1111111111111111111111111111111111111111';

const googleUser = (overrides: Partial<PrivyUserLike> = {}): PrivyUserLike => ({
  linkedAccounts: [
    {
      type: 'wallet',
      address: INJECTED,
      chainType: 'ethereum',
      walletClientType: 'metamask',
    },
    {
      type: 'google_oauth',
      subject: 'google-sub-1',
      email: 'you@gmail.com',
      name: 'You Person',
    },
    {
      type: 'wallet',
      address: EMBEDDED,
      chainType: 'ethereum',
      walletClientType: 'privy',
    },
  ],
  ...overrides,
});

describe('which wallet owns the account', () => {
  it('takes the wallet Privy holds, not the browser wallet that happens to be linked', () => {
    expect(pickSocialWallet(googleUser())).toBe(EMBEDDED);
  });

  it('refuses a Solana wallet, because the account is keyed by an Ethereum address', () => {
    expect(
      pickSocialWallet({
        linkedAccounts: [
          { type: 'wallet', address: EMBEDDED, chainType: 'solana' },
        ],
      }),
    ).toBeUndefined();
  });

  it('refuses anything that is not an address', () => {
    expect(
      pickSocialWallet({ wallet: { address: 'not-an-address' } }),
    ).toBeUndefined();
  });
});

describe('which provider answered', () => {
  it('reads Google, and keeps the provider’s own id for the person', () => {
    const identity = pickSocialIdentity(googleUser());

    expect(identity).toMatchObject({
      provider: 'google',
      subject: 'google-sub-1',
      email: 'you@gmail.com',
      name: 'You Person',
      walletAddress: EMBEDDED,
    });
    expect(identity?.handle).toBeUndefined();
  });

  it('reads X, handle and all', () => {
    const identity = pickSocialIdentity({
      linkedAccounts: [
        {
          type: 'twitter_oauth',
          subject: 'x-sub-9',
          username: 'you',
          name: 'You',
        },
        { type: 'wallet', address: EMBEDDED, chainType: 'ethereum' },
      ],
    });

    expect(identity?.provider).toBe('twitter');
    expect(identity?.handle).toBe('you');
  });

  it('returns nothing for a wallet-only session rather than guessing a provider', () => {
    expect(
      pickSocialIdentity({
        linkedAccounts: [
          { type: 'wallet', address: EMBEDDED, chainType: 'ethereum' },
        ],
      }),
    ).toBeUndefined();
  });

  it('falls back to the provider name when no subject came back', () => {
    const identity = pickSocialIdentity({
      linkedAccounts: [{ type: 'google_oauth', email: 'you@gmail.com' }],
    });

    expect(identity?.subject).toBe('google');
  });
});

describe('the record this device keeps', () => {
  it('is keyed by the wallet, lowercased, the way the book keys every account', () => {
    const record = buildSocialAccountRecord({
      identity: pickSocialIdentity(googleUser())!,
      now: 1_700_000_000_000,
    });

    expect(record?.id).toBe(EMBEDDED.toLowerCase());
    expect(record?.custodyAddress).toBe(EMBEDDED.toLowerCase());
    expect(record?.createdAt).toBe(1_700_000_000_000);
    expect(record?.walletCustody).toBe('privy');
    expect(record?.fid).toBeUndefined();
  });

  it('does not invent a handle out of an email', () => {
    const record = buildSocialAccountRecord({
      identity: pickSocialIdentity(googleUser())!,
    });

    expect(record?.username).toBeUndefined();
    expect(isSocialAccount(record)).toBe(true);
  });

  it('refuses to build one at all when no wallet came back', () => {
    expect(
      buildSocialAccountRecord({
        identity: {
          provider: 'google',
          subject: 'google-sub-1',
          email: 'you@gmail.com',
        },
      }),
    ).toBeUndefined();
  });
});

describe('how it reads on screen', () => {
  it('names the provider and the person, never the wallet first', () => {
    expect(describeSocialIdentity(pickSocialIdentity(googleUser())!)).toBe(
      'your Google account (you@gmail.com)',
    );
  });

  it('shows the email in the switcher rather than a hex address nobody has seen', () => {
    const record = buildSocialAccountRecord({
      identity: pickSocialIdentity(googleUser())!,
    })!;

    expect(describeLocalAccount(record)).toBe('you@gmail.com');
  });

  it('shows the handle for X, because that is what its owner calls themselves', () => {
    const record = buildSocialAccountRecord({
      identity: pickSocialIdentity({
        linkedAccounts: [
          { type: 'twitter_oauth', subject: 'x-sub-9', username: 'you' },
          { type: 'wallet', address: EMBEDDED, chainType: 'ethereum' },
        ],
      })!,
    })!;

    expect(describeLocalAccount(record)).toBe('@you');
  });

  it('shortens an address without pretending it is short', () => {
    expect(shortAddress(EMBEDDED)).toBe('0x8f3C…A063');
  });
});
