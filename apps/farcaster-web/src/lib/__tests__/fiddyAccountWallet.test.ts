/**
 * "Does Fiddy hold a wallet for me?" — the two honest answers.
 *
 * The load-bearing assertion is the middle one: the wallet that comes with an
 * account made here owns that account and paid the one-off fee to create it,
 * and it is NOT the wallet that pays for what the agent uses. A surface that
 * blurs those two would send a person looking for money in the wrong wallet.
 */

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_WALLET_TITLE,
  describeAccountWallet,
} from '~/lib/fiddyAccountWallet';
import type { LocalAccount } from '~/snapchain/accounts/localAccounts';

const account: LocalAccount = {
  id: '0xabc0000000000000000000000000000000000001',
  custodyAddress: '0xAbC0000000000000000000000000000000000001',
  phrase: 'one two three',
  fid: 4242,
  createdAt: 1,
};

describe('the wallet that comes with a Fiddy account', () => {
  it('names the account wallet this device holds', () => {
    const wallet = describeAccountWallet(account);
    expect(wallet.hasWallet).toBe(true);
    expect(wallet.address).toBe(account.custodyAddress);
    expect(wallet.title).toBe(ACCOUNT_WALLET_TITLE);
    expect(wallet.line).toContain('recovery phrase is kept on this device');
  });

  it('keeps it separate from the wallet that pays for the agent', () => {
    expect(describeAccountWallet(account).line).toContain(
      'does not pay for what your agent uses',
    );
  });

  it('says nothing was made when this device holds no account', () => {
    const wallet = describeAccountWallet(undefined);
    expect(wallet.hasWallet).toBe(false);
    expect(wallet.address).toBeNull();
    expect(wallet.line).toContain('nothing needs to');
    expect(wallet.line).toContain('Farcaster app');
  });

  it('never invents an address for an account without one', () => {
    const wallet = describeAccountWallet({ ...account, custodyAddress: '' });
    expect(wallet.hasWallet).toBe(false);
    expect(wallet.address).toBeNull();
  });
});
