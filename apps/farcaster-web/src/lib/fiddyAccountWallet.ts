/**
 * The wallet that comes with a Fiddy account made here.
 *
 * A Fiddy account is made in two ways, and only one of them leaves a wallet on
 * this device: connecting a Farcaster account keeps custody where it belongs —
 * in the person's own Farcaster app — while making an account in the client
 * generates a wallet here, keeps its recovery phrase here, and pays the one-off
 * fee that creates the account. That is the wallet this module describes. It is
 * never a second wallet, and nothing here invents one.
 *
 * It exists so the wallet page can answer "does Fiddy hold a wallet for me?"
 * honestly: the address when this device has one, and one plain sentence about
 * what it is for when it does not. Nothing in it signs, spends, or reads the
 * network — the accounts it describes are already on the device.
 */

import type { LocalAccount } from '~/snapchain/accounts/localAccounts';

/** The heading both states use, so the answer is recognisably the same answer. */
export const ACCOUNT_WALLET_TITLE =
  'The wallet that comes with your Fiddy account';

export interface AccountWallet {
  /** Whether this device holds a Fiddy account with a wallet of its own. */
  hasWallet: boolean;
  /** The address, when there is one. */
  address: string | null;
  /** The heading. */
  title: string;
  /** One plain sentence, in the owner's words. */
  line: string;
}

export const describeAccountWallet = (
  account: LocalAccount | undefined,
): AccountWallet => {
  if (!account?.custodyAddress) {
    return {
      hasWallet: false,
      address: null,
      title: ACCOUNT_WALLET_TITLE,
      line: 'Nothing here has made one, and nothing needs to. An account you already hold keeps its wallet where it is — in your own Farcaster app — and the wallet you connect above is what pays for what your agent uses.',
    };
  }

  return {
    hasWallet: true,
    address: account.custodyAddress,
    title: ACCOUNT_WALLET_TITLE,
    line: 'Made with this account, here. Its recovery phrase is kept on this device and nowhere else, it is the wallet that owns the account, and it paid the one-off fee that created it. It does not pay for what your agent uses — the wallet you connect above does that.',
  };
};
