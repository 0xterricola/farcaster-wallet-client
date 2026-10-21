/**
 * Which wallet pays, stated honestly for every state the client can be in.
 *
 * The load-bearing case is the second option: `Create a fresh wallet for me`
 * is a wallet the owner's Fiddy account makes, in the other repo, and this
 * build must say so rather than quietly creating a second implementation of it.
 * The other cases are the ones that would otherwise produce a failed signature
 * with no explanation — no wallet, a Solana wallet, a wallet on the wrong chain.
 */

import { describe, expect, it } from 'vitest';

import {
  describeWalletHome,
  PAYMENT_CHAIN_ID,
  shortAddress,
  WALLET_OPTIONS,
} from '~/lib/surp/walletChoice';
import { EMPTY_WALLET_CONNECTIONS } from '~/utils/walletFamily';
import type { WalletConnections } from '~/utils/walletFamily';

const BASE = '0x1111111111111111111111111111111111111111';

const evmConnected = (
  address = BASE,
  walletName?: string,
): WalletConnections => ({
  ...EMPTY_WALLET_CONNECTIONS,
  evm: { status: 'connected', address, walletName },
});

describe('the two choices', () => {
  it('offers bringing your own wallet, which this build can do', () => {
    const choice = WALLET_OPTIONS.find((option) => option.id === 'farcaster')!;
    expect(choice.available).toBe(true);
    expect(choice.line).toContain('pays for Surp');
  });

  it('offers a fresh wallet, and says who makes it', () => {
    const choice = WALLET_OPTIONS.find((option) => option.id === 'fresh')!;
    expect(choice.available).toBe(false);
    expect(choice.unavailableReason).toBeDefined();
    expect(choice.unavailableReason).toContain('Fiddy account');
    // It must not promise to create one here.
    expect(choice.unavailableReason).toContain('not this page');
  });
});

describe('the wallet home', () => {
  it('names the wallet that will pay', () => {
    const home = describeWalletHome({
      choice: 'farcaster',
      connections: evmConnected(BASE, 'Rainbow'),
      chainId: PAYMENT_CHAIN_ID,
    });
    expect(home.canPay).toBe(true);
    expect(home.address).toBe(BASE);
    expect(home.family).toBe('evm');
    expect(home.summary).toContain('Rainbow');
    expect(home.summary).toContain(shortAddress(BASE));
    expect(home.summary).toContain('only when you approve it');
  });

  it('asks for a wallet when there is none', () => {
    const home = describeWalletHome({
      choice: 'farcaster',
      connections: EMPTY_WALLET_CONNECTIONS,
    });
    expect(home.canPay).toBe(false);
    expect(home.address).toBeNull();
    expect(home.summary).toContain('Connect the wallet');
  });

  it('points a fresh-wallet owner at their account, not at a dead end', () => {
    const home = describeWalletHome({
      choice: 'fresh',
      connections: EMPTY_WALLET_CONNECTIONS,
    });
    expect(home.canPay).toBe(false);
    expect(home.summary).toContain('Fiddy account can make you one');
  });

  it('explains a Solana wallet instead of failing to sign with it', () => {
    const home = describeWalletHome({
      choice: 'farcaster',
      connections: {
        ...EMPTY_WALLET_CONNECTIONS,
        solana: { status: 'connected', address: 'So1anaAddr', walletName: 'Phantom' },
      },
    });
    expect(home.canPay).toBe(false);
    expect(home.family).toBe('solana');
    expect(home.summary).toContain('paid on Base');
    expect(home.summary).toContain('untouched');
  });

  it('names the chain to switch to when the wallet is elsewhere', () => {
    const home = describeWalletHome({
      choice: 'farcaster',
      connections: evmConnected(),
      chainId: 1,
    });
    expect(home.canPay).toBe(false);
    expect(home.address).toBe(BASE);
    expect(home.summary).toContain('not on Base');
  });

  it('does not block a wallet whose chain this client does not know yet', () => {
    const home = describeWalletHome({
      choice: 'farcaster',
      connections: evmConnected(),
    });
    expect(home.canPay).toBe(true);
  });

  it('masks the address the same way everywhere', () => {
    expect(shortAddress(BASE)).toBe('0x1111…1111');
    expect(shortAddress('short')).toBe('short');
  });
});