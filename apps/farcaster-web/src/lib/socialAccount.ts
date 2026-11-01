/**
 * What a social sign-up leaves behind, and how this device names it.
 *
 * THE MAPPING, IN ONE PLACE. A completed Google or X sign-up hands back three
 * things that matter: which provider answered, that provider's own id for the
 * person (the `sub` claim, stable and unguessable), and — because the app is
 * mounted with `createOnLogin: 'users-without-wallets'` — an Ethereum wallet
 * Privy created and holds for them. The Fiddy identity this device keeps is that
 * wallet: it is the account's custody address, the thing that will own a
 * Farcaster account when one is attached, and the key a switcher row is keyed by.
 * That last part is why a social account is stored through the SAME account
 * book the rest of the client uses (`~/snapchain/accounts/localAccounts`) rather
 * than a store of its own: an account made here and an account made with Google
 * are the same kind of thing to this device, and there is exactly one place that
 * knows the list.
 *
 * WHY THE MAPPING IS WRITTEN STRUCTURALLY. It reads a plain object with the few
 * fields Privy's user carries, not the SDK's own `User` type. Two reasons: the
 * SDK does not have to be loaded for the mapping to be exercised, so its tests
 * are ordinary tests; and a provider added to `SOCIAL_PROVIDERS` is picked up by
 * the same loop rather than by a new branch here.
 *
 * WHAT IS HONEST ABOUT AN ACCOUNT WITH NO NUMBER YET. A social sign-up produces
 * an account with a wallet and no FID: nothing has been registered on Farcaster.
 * This client's own rule, in `~/snapchain/accounts/session`, is that such an
 * account can be held but cannot sign in — "an account without a FID yet cannot
 * sign in, because there is nothing to sign in as". Nothing here breaks that
 * rule or pretends around it: the account is created, selectable, named, and it
 * says out loud what is still missing.
 */

import { SOCIAL_PROVIDERS, type SocialProviderId } from '~/lib/socialSignUp';
import {
  accountIdFor,
  type LocalAccount,
} from '~/snapchain/accounts/localAccounts';

/** The linked-account shapes this mapping reads, and nothing more. */
export type PrivyLinkedAccountLike = {
  type?: string;
  address?: string;
  subject?: string;
  email?: string;
  username?: string | null;
  name?: string | null;
  chainType?: string | null;
  walletClientType?: string | null;
};

export type PrivyUserLike = {
  linkedAccounts?: PrivyLinkedAccountLike[];
  /** The first verified wallet — a fallback when the list is not populated. */
  wallet?: { address?: string };
};

export type SocialIdentity = {
  provider: SocialProviderId;
  /** The provider's own stable id for this person. */
  subject: string;
  email?: string;
  /** The handle the provider gave, when it gave one (X does, Google does not). */
  handle?: string;
  /** The person's name at the provider, when it gave one. */
  name?: string;
  /** The wallet that owns the account, when one was created for them. */
  walletAddress?: `0x${string}`;
};

/**
 * An account that came from a social sign-up, in the book's own shape.
 *
 * `walletCustody: 'privy'` is the marker that says the words behind this
 * account are not held on this device — which is what the backup notice has to
 * know to say something true (see `~/lib/seedBackup`). The identity fields are
 * additive: the book's own type tolerates them, and they are what make a
 * switcher row readable.
 */
export interface SocialAccountRecord extends LocalAccount {
  walletCustody: 'privy';
  provider: SocialProviderId;
  subject: string;
  email?: string;
}

/** The linked-account type each provider answers with. */
const PROVIDER_LINKED_ACCOUNT_TYPE: Record<SocialProviderId, string> = {
  google: 'google_oauth',
  twitter: 'twitter_oauth',
};

/** A 20-byte hex address, as anything downstream is allowed to trust. */
export const isEthereumAddress = (value?: string): value is `0x${string}` =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.trim());

/** "0x1a2b…9f0e" — an address a person can compare, not read out. */
export const shortAddress = (address: string): string =>
  address.length <= 12
    ? address
    : `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * The wallet Privy holds for this account.
 *
 * The embedded one is asked for by name (`walletClientType === 'privy'`) and by
 * chain (`ethereum`), and only then is anything else considered — a person who
 * signed up with Google and happened to have MetaMask installed must not end up
 * with their browser wallet as the account's custody address.
 */
export const pickSocialWallet = (
  user: PrivyUserLike,
): `0x${string}` | undefined => {
  const wallets = (user.linkedAccounts ?? []).filter(
    (account) => account.type === 'wallet' && account.chainType === 'ethereum',
  );

  const embedded = wallets.find(
    (account) => account.walletClientType === 'privy',
  );

  const chosen = embedded ?? wallets[0] ?? user.wallet;

  return isEthereumAddress(chosen?.address) ? chosen.address : undefined;
};

/**
 * Which provider answered, and what it said about the person.
 *
 * Read in `SOCIAL_PROVIDERS` order, so a person who somehow has both linked is
 * named the same way every time. Returns undefined when nothing in the list
 * matches — a wallet-only Privy session, say — and the caller must then not
 * invent one.
 */
export const pickSocialIdentity = (
  user: PrivyUserLike,
): SocialIdentity | undefined => {
  const linked = user.linkedAccounts ?? [];

  for (const provider of SOCIAL_PROVIDERS) {
    const match = linked.find(
      (account) => account.type === PROVIDER_LINKED_ACCOUNT_TYPE[provider.id],
    );

    if (!match) {
      continue;
    }

    const subject = match.subject?.trim() ?? '';

    return {
      provider: provider.id,
      // A provider that answered without a subject cannot be re-asked about
      // later, so the account is keyed by the provider's own name for the
      // person instead. Better a weaker id than a missing one.
      subject: subject === '' ? provider.id : subject,
      email: match.email?.trim() || undefined,
      handle: match.username?.trim() || undefined,
      name: match.name?.trim() || undefined,
      walletAddress: pickSocialWallet(user),
    };
  }

  return undefined;
};

/** "your Google account (you@gmail.com)" — how the account is spoken about. */
export const describeSocialIdentity = (identity: SocialIdentity): string => {
  const provider = SOCIAL_PROVIDERS.find(
    (candidate) => candidate.id === identity.provider,
  );

  const label = provider ? `your ${provider.name} account` : 'your account';

  const detail = identity.email ?? identity.handle ?? identity.name;

  return detail ? `${label} (${detail})` : label;
};

/**
 * The record this device stores for a social sign-up.
 *
 * The id is the wallet address, lowercased through the book's own
 * `accountIdFor`, so one wallet is one account here exactly as one custody
 * address is one account there. `username` carries a handle only when the
 * provider gave one: an account named @you on X, and an email on Google. No
 * handle is ever invented from an email.
 */
export const buildSocialAccountRecord = ({
  identity,
  now = Date.now(),
}: {
  identity: SocialIdentity;
  now?: number;
}): SocialAccountRecord | undefined => {
  if (!identity.walletAddress) {
    return undefined;
  }

  const address = identity.walletAddress.toLowerCase();

  return {
    id: accountIdFor(address),
    custodyAddress: address,
    createdAt: now,
    walletCustody: 'privy',
    provider: identity.provider,
    subject: identity.subject,
    email: identity.email,
    username: identity.handle,
    displayName: identity.name ?? identity.email ?? identity.handle,
  };
};

/** True when this account's words are held for it rather than written down. */
export const isSocialAccount = (
  account: LocalAccount | undefined,
): account is SocialAccountRecord =>
  Boolean(account) &&
  (account as SocialAccountRecord).walletCustody === 'privy';
