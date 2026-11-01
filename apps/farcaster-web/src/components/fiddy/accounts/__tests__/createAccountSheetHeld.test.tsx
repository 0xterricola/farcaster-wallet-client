// @vitest-environment jsdom
/**
 * Claiming a number for an account that is already here, as a person meets it.
 *
 * Two claims are pinned here rather than left to the browser probe: the flow for
 * a held account never shows words this device does not hold (there is no phrase
 * step at all), and the fee is asked for at the address of the account the
 * person signed up with — not at a second, freshly generated one. The third
 * claim, that the record saved afterwards is that same account by id, is pinned
 * on `accountAfterRegistration` itself.
 *
 * And the flow this replaces is pinned too: an account made here still shows its
 * twelve words and still funds its own new address.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modalRootId } from '~/constants/modals';

const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: vi.fn(
    async ({ key, fallback }: { key: string; fallback: unknown }) =>
      store.has(key) ? store.get(key) : fallback,
  ),
  setItem: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  }),
  deleteItem: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

vi.mock('~/contexts/AuthProvider', () => ({
  useAuth: () => ({ signIn: vi.fn() }),
}));

// No node: the screens are what is under test, and a registration is not begun.
vi.mock('~/snapchain/useNodeClient', () => ({
  useNodeClient: () => null,
}));

import {
  accountAfterRegistration,
  CreateAccountSheet,
  type HeldAccountSetup,
} from '~/components/fiddy/accounts/CreateAccountSheet';
import type { CustodyAccount } from '~/snapchain/accounts/phrase';

const HELD_WALLET = '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063';

const heldAccount = {
  id: HELD_WALLET,
  custodyAddress: HELD_WALLET,
  createdAt: 1_700_000_000_000,
  walletCustody: 'privy' as const,
  provider: 'google',
  email: 'probe@gmail.com',
};

const held: HeldAccountSetup = {
  account: heldAccount,
  custody: {
    address: HELD_WALLET as `0x${string}`,
    signTransaction: async () => '0x00' as `0x${string}`,
  } as unknown as CustodyAccount,
  providerName: 'Google',
};

beforeEach(() => {
  store.clear();
  // The sheet draws itself through a portal into the modal root, so a test that
  // wants to read it has to have one (the same setup SpaceAlertModal's test uses).
  const modalRoot = document.createElement('div');
  modalRoot.id = modalRootId;
  document.body.appendChild(modalRoot);
  // The name registry answers "free" (404) for everything, and the Optimism
  // endpoint does not answer at all: neither is what this screen is about.
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
});

afterEach(() => {
  document.body.innerHTML = '';
});

const typeNameAndContinue = async () => {
  const input = document.querySelector('input.fiddy-input');

  expect(input).not.toBeNull();

  fireEvent.change(input as HTMLInputElement, {
    target: { value: 'probe' },
  });

  await screen.findByText('@probe is free.');

  fireEvent.click(screen.getByText('Continue'));
};

describe('an account whose words are held for it', () => {
  it('asks for the fee at the account’s own address, with no words to write down', async () => {
    render(<CreateAccountSheet onClose={vi.fn()} held={held} />);

    await typeNameAndContinue();

    await screen.findByText('Claim your Farcaster number');

    expect(document.querySelector('[data-fiddy="recovery-phrase"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Write these twelve words/);

    const address = document.querySelector('[data-fiddy="custody-address"]');

    expect(address?.textContent).toBe(HELD_WALLET);
    expect(
      document.querySelector('[data-fiddy="held-account-note"]'),
    ).not.toBeNull();
    // Which window will ask for the approval is said out loud.
    expect(document.body.textContent).toMatch(/Google will ask you to approve/);
  });

  it('goes back to the name step, not to a phrase step it never showed', async () => {
    render(<CreateAccountSheet onClose={vi.fn()} held={held} />);

    await typeNameAndContinue();
    await screen.findByText('Claim your Farcaster number');

    fireEvent.click(screen.getByText('Back'));

    await screen.findByText('Pick your name');

    expect(document.querySelector('[data-fiddy="recovery-phrase"]')).toBeNull();
  });
});

describe('an account this device makes', () => {
  it('still shows its twelve words and funds its own new address', async () => {
    render(<CreateAccountSheet onClose={vi.fn()} />);

    await typeNameAndContinue();

    await screen.findByText('Write these twelve words down');

    const phrase = document.querySelector('[data-fiddy="recovery-phrase"]');

    expect(phrase?.textContent?.split(/\s+/)).toHaveLength(12);

    fireEvent.click(
      screen
        .getByText('I have written them down somewhere safe')
        .closest('label')
        ?.querySelector('input') as HTMLInputElement,
    );
    fireEvent.click(screen.getByText('I saved them - continue'));

    await waitFor(() => {
      expect(
        document.querySelector('[data-fiddy="custody-address"]')?.textContent,
      ).not.toBe(HELD_WALLET);
    });
  });
});

describe('the record a finished registration keeps', () => {
  it('is the account that signed up, by id, with its number filled in', () => {
    const saved = accountAfterRegistration({
      held,
      custodyAddress: heldAccount.custodyAddress,
      fid: 4242,
      username: 'probe',
      displayName: 'Probe Person',
      now: 1_700_000_500_000,
    });

    expect(saved.id).toBe(heldAccount.id);
    expect(saved.custodyAddress).toBe(heldAccount.custodyAddress);
    expect(saved.fid).toBe(4242);
    expect(saved.username).toBe('probe');
    // The identity the person signed up with is not replaced by a new one.
    expect(saved.provider).toBe('google');
    expect(saved.email).toBe('probe@gmail.com');
    // And there is still no phrase on this device.
    expect(saved.phrase).toBeUndefined();
  });

  it('is a new account, with its own words, when this device made it', () => {
    const saved = accountAfterRegistration({
      custodyAddress: '0xaaa',
      phrase: 'apple banana cherry',
      fid: 4243,
      username: 'made',
      now: 1_700_000_500_000,
    });

    expect(saved.id).toBe('0xaaa');
    expect(saved.phrase).toBe('apple banana cherry');
    expect(saved.createdAt).toBe(1_700_000_500_000);
    expect(saved.fid).toBe(4243);
  });
});
