/**
 * Holding more than one account.
 *
 * The tests that matter here are the ones about not mixing accounts up: one
 * entry per address, one selected account at a time, and a removal that leaves
 * the device pointing at something real. `localforage` is mocked, so these
 * assert the exact keys written rather than trusting a wrapper.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  accountIdFor,
  clearLocalAccounts,
  describeLocalAccount,
  loadCurrentAccount,
  loadCurrentAccountId,
  loadLocalAccounts,
  type LocalAccount,
  removeLocalAccount,
  saveLocalAccount,
  selectLocalAccount,
  signedInAsLabel,
} from '~/snapchain/accounts/localAccounts';
import { buildLocalSessionForAccount } from '~/snapchain/accounts/session';

const account = (overrides: Partial<LocalAccount> = {}): LocalAccount => ({
  id: overrides.id ?? '0xaaa',
  custodyAddress: overrides.custodyAddress ?? '0xAAA',
  phrase: 'apple banana',
  createdAt: 1,
  ...overrides,
});

beforeEach(() => {
  store.clear();
});

describe('the list of accounts', () => {
  it('starts empty, and says so without throwing', async () => {
    await expect(loadLocalAccounts()).resolves.toEqual([]);
    await expect(loadCurrentAccount()).resolves.toBeUndefined();
  });

  it('keeps one entry per custody address, updating rather than duplicating', async () => {
    await saveLocalAccount(account({ id: '0xaaa', custodyAddress: '0xaaa' }), {
      select: false,
    });
    await saveLocalAccount(
      account({
        id: '0xaaa',
        custodyAddress: '0xaaa',
        fid: 4242,
        username: 'fiddy',
      }),
      { select: false },
    );

    const accounts = await loadLocalAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.fid).toBe(4242);
    expect(accounts[0]?.username).toBe('fiddy');
  });

  it('puts the account that was just made in front: it is selected', async () => {
    await saveLocalAccount(account({ id: '0xaaa', custodyAddress: '0xaaa' }));
    await saveLocalAccount(account({ id: '0xbbb', custodyAddress: '0xbbb' }));

    expect(await loadCurrentAccountId()).toBe('0xbbb');
    expect((await loadCurrentAccount())?.id).toBe('0xbbb');
  });

  it('switches the selection without touching the list', async () => {
    await saveLocalAccount(account({ id: '0xaaa', custodyAddress: '0xaaa' }));
    await saveLocalAccount(account({ id: '0xbbb', custodyAddress: '0xbbb' }));

    await selectLocalAccount('0xaaa');

    expect(await loadCurrentAccountId()).toBe('0xaaa');
    expect(await loadLocalAccounts()).toHaveLength(2);
  });

  it('leaves the device on a real account when the selected one is removed', async () => {
    await saveLocalAccount(account({ id: '0xaaa', custodyAddress: '0xaaa' }));
    await saveLocalAccount(account({ id: '0xbbb', custodyAddress: '0xbbb' }));

    await removeLocalAccount('0xbbb');

    const remaining = await loadLocalAccounts();

    expect(remaining.map((entry) => entry.id)).toEqual(['0xaaa']);
    expect(await loadCurrentAccountId()).toBe('0xaaa');
  });

  it('ends with no selection at all when the last account goes', async () => {
    await saveLocalAccount(account({ id: '0xaaa', custodyAddress: '0xaaa' }));

    await removeLocalAccount('0xaaa');

    expect(await loadLocalAccounts()).toEqual([]);
    expect(await loadCurrentAccountId()).toBeUndefined();
  });

  it('can be cleared outright', async () => {
    await saveLocalAccount(account({ id: '0xaaa', custodyAddress: '0xaaa' }));
    await clearLocalAccounts();

    expect(await loadLocalAccounts()).toEqual([]);
    expect(await loadCurrentAccountId()).toBeUndefined();
  });

  it('takes the posting key off the device when an account is forgotten', async () => {
    await saveLocalAccount(
      account({ id: '0xaaa', custodyAddress: '0xaaa', fid: 4242 }),
    );
    store.set('snapchain_app_key_4242', '0xdead');
    store.set('snapchain_app_nonce_4242', 8);

    await removeLocalAccount('0xaaa');

    // Nothing this browser could sign for that account with is left behind.
    expect(store.has('snapchain_app_key_4242')).toBe(false);
    expect(store.has('snapchain_app_nonce_4242')).toBe(false);
  });

  it('leaves the key alone while another entry still holds that FID', async () => {
    await saveLocalAccount(
      account({ id: '0xaaa', custodyAddress: '0xaaa', fid: 4242 }),
      { select: false },
    );
    await saveLocalAccount(
      account({ id: '0xbbb', custodyAddress: '0xbbb', fid: 4242 }),
    );
    store.set('snapchain_app_key_4242', '0xdead');

    await removeLocalAccount('0xbbb');

    expect(store.get('snapchain_app_key_4242')).toBe('0xdead');
  });

  it('leaves keys alone for an account it never had a number for', async () => {
    await saveLocalAccount(account({ id: '0xaaa', custodyAddress: '0xaaa' }));
    store.set('snapchain_app_key_4242', '0xdead');

    await removeLocalAccount('0xaaa');

    expect(store.get('snapchain_app_key_4242')).toBe('0xdead');
  });

  it('ignores junk that is not an account', async () => {
    store.set('fiddy:accounts', [{ nope: true }, account({ id: '0xaaa' })]);

    const accounts = await loadLocalAccounts();

    expect(accounts.map((entry) => entry.id)).toEqual(['0xaaa']);
  });
});

describe('naming an account on screen', () => {
  it('uses the handle when there is one, the number next, then the address', () => {
    expect(describeLocalAccount(account({ username: 'fiddy' }))).toBe('@fiddy');
    expect(describeLocalAccount(account({ fid: 4242 }))).toBe('account 4242');
    expect(
      describeLocalAccount(
        account({
          custodyAddress: '0x1234567890abcdef1234567890abcdef12345678',
        }),
      ),
    ).toBe('0x1234…5678');
  });

  it('says which account is signing in, and nothing when there is none', () => {
    expect(signedInAsLabel(account({ username: 'fiddy' }))).toBe(
      'signing in as @fiddy',
    );
    expect(signedInAsLabel(undefined)).toBeUndefined();
  });

  it('treats one address as one account, whatever case it was written in', () => {
    expect(accountIdFor('  0xAbC  ')).toBe('0xabc');
  });
});

describe('the session an account signs in with', () => {
  it("is built from the account's own number and handle", () => {
    const session = buildLocalSessionForAccount(
      account({ fid: 4242, username: 'fiddy', displayName: 'Fiddy' }),
    );

    expect(session.authToken.secret.startsWith('siwf-local:4242:')).toBe(true);
    expect(session.onboardingState.result.state.user?.fid).toBe(4242);
    expect(session.onboardingState.result.state.user?.username).toBe('fiddy');
    expect(session.onboardingState.result.state.hasCompletedRegistration).toBe(
      true,
    );
  });

  it('refuses to sign in as an account with no number yet', () => {
    expect(() => buildLocalSessionForAccount(account())).toThrow(
      /has no number yet/,
    );
  });
});
