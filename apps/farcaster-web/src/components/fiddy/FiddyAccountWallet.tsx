/**
 * "Does Fiddy hold a wallet for me?" — answered from this device's own accounts.
 *
 * Two halves again, for the same reason as the wallet home: the card is a pure
 * function of the account it is handed (so every state can be read in a test),
 * and the component below it only reads which accounts this device holds and
 * re-reads when that changes.
 *
 * While the accounts are still being read nothing is drawn at all. A card that
 * says "nothing here has made one" for the half-second before it finds one is
 * the same kind of wrong answer this page was rewritten to remove.
 */

import React, { memo } from 'react';

import { describeAccountWallet } from '~/lib/fiddyAccountWallet';
import { shortAddress } from '~/lib/surp/walletChoice';
import type { LocalAccount } from '~/snapchain/accounts/localAccounts';
import { useLocalAccounts } from '~/snapchain/accounts/session';

export const FiddyAccountWalletCard = memo(
  ({ account }: { account: LocalAccount | undefined }) => {
    const wallet = describeAccountWallet(account);

    return (
      <section
        className="fiddy-connect"
        data-fiddy="account-wallet"
        data-state={wallet.hasWallet ? 'has-wallet' : 'no-wallet'}
      >
        <div className="fiddy-field">
          <span className="fiddy-field-label">{wallet.title}</span>
          {wallet.address ? (
            <span
              className="fiddy-card-line"
              data-fiddy="account-wallet-address"
            >
              {shortAddress(wallet.address)}
            </span>
          ) : null}
          <p className="fiddy-honest-note">
            <span>{wallet.line}</span>
          </p>
        </div>
      </section>
    );
  },
);

FiddyAccountWalletCard.displayName = 'FiddyAccountWalletCard';

/** The card, reading the accounts this device holds — and re-reading on change. */
export const FiddyAccountWallet = memo(() => {
  const { current, loading } = useLocalAccounts();

  if (loading) {
    return null;
  }

  return <FiddyAccountWalletCard account={current} />;
});

FiddyAccountWallet.displayName = 'FiddyAccountWallet';
