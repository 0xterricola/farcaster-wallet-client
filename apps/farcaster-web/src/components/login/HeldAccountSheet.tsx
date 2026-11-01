/**
 * Claiming a Farcaster number for an account whose words are held for it.
 *
 * THE GAP THIS CLOSES. A Google or X sign-up makes a real account on this
 * device, and it does not make a Farcaster account. The honest ways to get one
 * were "sign in with an account you already have" and "make a new one here" —
 * and the second one made a SECOND account, owned by a fresh wallet this sheet
 * generated, so the identity the person signed up with still owned nothing on
 * Farcaster. This is the third shape, and the one the account screen offers
 * first: the number is claimed BY the account they signed up with, signed by the
 * wallet their sign-up is holding.
 *
 * WHY IT IS ITS OWN COMPONENT, AND WHY IT IS LOADED ON DEMAND. The signing comes
 * out of the sign-up provider's browser window, so the only code that can ask
 * for it must run under that provider — which is mounted late and only when the
 * build has the app id (`~/providers/PrivyRoot`). Everything else in the client
 * must keep working with no provider at all, so this module is reached through a
 * dynamic import exactly like the sign-up itself, and it decides between three
 * honest answers: the flow, "one moment" while the provider arrives, and a
 * sentence about which half is missing.
 *
 * IT REFUSES TO MAKE A SECOND ACCOUNT. If the provider is not answering, or the
 * person is no longer signed in to it, there is no key that can own the number —
 * and making a different account instead is exactly the defect this replaces. So
 * it says so and offers to sign in again, rather than quietly producing a wallet
 * with no Farcaster account on it.
 */

import { useLogin, usePrivy, useWallets } from '@privy-io/react-auth';
import React, { FC, memo, useCallback, useState } from 'react';

import { CreateAccountSheet } from '~/components/fiddy/accounts/CreateAccountSheet';
import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { heldWalletCustody, type HeldWalletProvider } from '~/lib/heldWallet';
import { SOCIAL_PROVIDERS, type SocialProviderId } from '~/lib/socialSignUp';
import { usePrivyRoot } from '~/providers/PrivyRoot';
import type { LocalAccount } from '~/snapchain/accounts/localAccounts';

export interface HeldAccountSheetProps {
  /** The account that will own the FID: the wallet the sign-up is holding. */
  account: LocalAccount;
  onClose: () => void;
  onCreated?: (account: LocalAccount) => void;
}

/** What the account's sign-up is called in a sentence ('Google', 'X'). */
const providerNameFor = (account: LocalAccount): string | undefined =>
  SOCIAL_PROVIDERS.find(
    (provider) => provider.id === (account.provider as SocialProviderId),
  )?.name;

const HeldAccountSheet: FC<HeldAccountSheetProps> = memo((props) => {
  const { ready, configured } = usePrivyRoot();

  if (!configured) {
    return (
      <HeldAccountSheetNotice
        title="Google and X are not set up in this copy of Fiddy."
        sub="Nothing is wrong with your account. This build has no sign-up provider, so it cannot ask one to sign for you."
        onClose={props.onClose}
      />
    );
  }

  if (!ready) {
    return (
      <HeldAccountSheetNotice
        title="One moment."
        sub="Getting your sign-up ready. Nothing is happening to your account."
        onClose={props.onClose}
      />
    );
  }

  return <HeldAccountSheetInner {...props} />;
});

HeldAccountSheet.displayName = 'HeldAccountSheet';

/** A one-sentence answer when the flow cannot be offered at all. */
const HeldAccountSheetNotice: FC<{
  title: string;
  sub: string;
  onClose: () => void;
}> = memo(({ title, sub, onClose }) => (
  <FiddySheet
    name="held-account-unavailable"
    egg="small"
    title={title}
    sub={sub}
    primary={{ label: 'Close', onClick: onClose }}
    note="Your account is unchanged."
  />
));

HeldAccountSheetNotice.displayName = 'HeldAccountSheetNotice';

/** The half that may ask for the provider's own hooks, under the provider. */
const HeldAccountSheetInner: FC<HeldAccountSheetProps> = memo(
  ({ account, onClose, onCreated }) => {
    const { wallets } = useWallets();
    const { authenticated } = usePrivy();
    const providerName = providerNameFor(account);

    const [waiting, setWaiting] = useState(false);
    const [message, setMessage] = useState<string | undefined>();

    const { login } = useLogin({
      onComplete: () => {
        // The wallet is only reachable once this page has the provider's own
        // session, so the flow is offered again on a fresh load.
        window.location.reload();
      },
      onError: (error) => {
        setWaiting(false);
        setMessage(
          typeof error === 'string' && error.length > 0
            ? `That sign-in did not finish: ${error}`
            : 'That sign-in did not finish. Nothing was changed, try again.',
        );
      },
    });

    // The wallet this account is keyed by, asked for by name AND by address: a
    // browser with an extension installed has other wallets, and none of them
    // may be mistaken for the one holding this account's words.
    const wanted = account.custodyAddress.toLowerCase();
    const wallet =
      wallets.find(
        (candidate) =>
          candidate.walletClientType === 'privy' &&
          candidate.address.toLowerCase() === wanted,
      ) ?? wallets.find((candidate) => candidate.walletClientType === 'privy');

    const signInAgain = useCallback(() => {
      setMessage(undefined);
      setWaiting(true);
      login({
        loginMethods: [
          (account.provider as SocialProviderId) ?? SOCIAL_PROVIDERS[0].id,
        ],
      });
    }, [account.provider, login]);

    if (wallet && authenticated) {
      return (
        <CreateAccountSheet
          onClose={onClose}
          {...(onCreated ? { onCreated } : {})}
          held={{
            account,
            custody: heldWalletCustody({
              address: wallet.address as `0x${string}`,
              provider:
                wallet.getEthereumProvider() as unknown as HeldWalletProvider,
              label: `your ${providerName ?? 'sign-up'} sign-up`,
            }),
            ...(providerName ? { providerName } : {}),
          }}
        />
      );
    }

    return (
      <FiddySheet
        name="held-account-sign-in"
        egg="small"
        title={`Sign in with ${providerName ?? 'Google or X'} again`}
        sub={
          authenticated
            ? "This browser can't find the wallet your account is held in. Signing in again brings it back, nothing is lost."
            : `Your account's words are held by ${providerName ?? 'your sign-up'}, and signing in again is how Fiddy asks for them. Nothing is lost, and no second account is made.`
        }
        primary={{
          label: waiting
            ? 'Waiting…'
            : `Continue with ${providerName ?? 'your sign-up'}`,
          onClick: signInAgain,
          disabled: waiting,
        }}
        quiet={{ label: 'Close', onClick: onClose }}
        note="Your Farcaster number is only claimed once, and never by a wallet you did not sign up with."
      >
        {message ? <p className="fiddy-error">{message}</p> : null}
      </FiddySheet>
    );
  },
);

HeldAccountSheetInner.displayName = 'HeldAccountSheetInner';

export { HeldAccountSheet };
