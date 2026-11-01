// @vitest-environment jsdom

/**
 * The backup reminder as a person meets it.
 *
 * Three claims are pinned here rather than left to the browser probe alone: the
 * words are unreadable until asked for, the confirm step is the person's and
 * ends the asking, and a notice never prints words this device does not hold —
 * a Google or X account gets its provider's own window, not an address dressed
 * up as a backup.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
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

import { SeedBackupNotice } from '~/components/fiddy/seedBackup/SeedBackupNotice';
import { DEFER_MS, seedBackupKeyFor } from '~/lib/seedBackup';
import type { LocalAccount } from '~/snapchain/accounts/localAccounts';

const PHRASE =
  'apple banana cherry damson elderberry fig guava hazelnut ivy juniper kiwi lemon';

const heldAccount: LocalAccount = {
  id: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
  custodyAddress: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
  createdAt: 1_700_000_000_000,
  walletCustody: 'privy',
  provider: 'google',
  email: 'you@gmail.com',
};

const deviceAccount: LocalAccount = {
  id: '0xaaa',
  custodyAddress: '0xaaa',
  phrase: PHRASE,
  fid: 4242,
  createdAt: 1_700_000_000_000,
};

beforeEach(() => {
  store.clear();
});

describe('an account whose words are held for it', () => {
  it('says so, and offers to write its own copy down', async () => {
    render(
      <SeedBackupNotice
        account={heldAccount}
        heldWordsSlot={
          <button type="button">Open the secure backup window</button>
        }
      />,
    );

    expect(await screen.findByText('Back up your account')).toBeTruthy();
    expect(
      screen.getByText(
        /You signed up with Google, so the words behind this account/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Nobody can give them to you again/)).toBeTruthy();
  });

  it('hides what it shows until asked, and prints no words it does not hold', async () => {
    render(<SeedBackupNotice account={heldAccount} />);

    fireEvent.click(await screen.findByText('Show me my backup words'));

    const panel = document.querySelector('[data-fiddy="seed-backup-words"]')!;

    expect(panel.getAttribute('data-hidden')).toBe('true');
    expect((panel as HTMLElement).style.filter).toContain('blur');
    // No word list at all: this device is not holding one.
    expect(panel.querySelectorAll('li').length).toBe(0);
    expect(panel.textContent).toContain(heldAccount.custodyAddress);

    fireEvent.click(screen.getByText('Tap to show the words'));

    await waitFor(() => {
      expect(
        document
          .querySelector('[data-fiddy="seed-backup-words"]')!
          .getAttribute('data-hidden'),
      ).toBe('false');
    });
  });
});

describe('an account whose words live on this device', () => {
  it('shows them blurred, then readable, then asks the person to confirm', async () => {
    render(<SeedBackupNotice account={deviceAccount} />);

    fireEvent.click(await screen.findByText('Show me my backup words'));

    const panel = () =>
      document.querySelector('[data-fiddy="seed-backup-words"]')!;

    expect(panel().getAttribute('data-hidden')).toBe('true');
    expect(panel().querySelectorAll('li').length).toBe(12);
    expect(panel().textContent).toContain('apple');

    fireEvent.click(screen.getByText('Tap to show the words'));

    await waitFor(() =>
      expect(panel().getAttribute('data-hidden')).toBe('false'),
    );

    fireEvent.click(screen.getByText('I have written them down'));

    expect(
      await screen.findByText(/Saved\. Your account is written down/),
    ).toBeTruthy();

    const stored = store.get(seedBackupKeyFor(deviceAccount.id)) as {
      status: string;
      savedAt?: number;
    };

    expect(stored.status).toBe('saved');
    expect(typeof stored.savedAt).toBe('number');
  });
});

describe('the asking can be put off', () => {
  it('buys days, and says nothing about being saved', async () => {
    render(<SeedBackupNotice account={heldAccount} />);

    fireEvent.click(await screen.findByText('Not now'));

    await waitFor(() => {
      const stored = store.get(seedBackupKeyFor(heldAccount.id)) as {
        status: string;
        remindAfter: number;
        lastShownAt: number;
      };

      expect(stored.status).toBe('deferred');
      expect(stored.remindAfter - stored.lastShownAt).toBe(DEFER_MS);
    });

    expect(screen.queryByText(/Saved\./)).toBeNull();
    expect(document.querySelector('[data-fiddy="seed-backup"]')).toBeNull();
  });

  it('does not come back on the next visit, because it was already asked', async () => {
    render(<SeedBackupNotice account={heldAccount} />);

    // Opens, records the ask, and is closed without any answer given.
    fireEvent.click(await screen.findByText('Show me my backup words'));
    expect(document.querySelector('[data-fiddy="seed-backup"]')).not.toBeNull();

    const asked = store.get(seedBackupKeyFor(heldAccount.id)) as {
      status: string;
      lastShownAt?: number;
    };

    expect(asked.status).toBe('unseen');
    expect(typeof asked.lastShownAt).toBe('number');
  });
});

/**
 * A screen that is created more than once inside one page load.
 *
 * MEASURED 2026-10-22 in a real Chrome: the account screen is built again ~40 to
 * 160ms after it first paints — Privy's provider arrives late and replaces its
 * subtree — and before this was pinned, the second creation read back the
 * "asked just now" record the first one had written and hid the notice. 5 of 8
 * runs at 390px and 1440px, and with StrictMode patched out of the served module
 * as well, so it is not a development-mode artefact. These two tests are the
 * pair that says what the notice promises: a remount is not an answer, and a
 * reload is not a fresh ask.
 */
describe('a screen that is built again inside one page load', () => {
  /**
   * An account of its own for each test here: the in-page record is keyed by
   * account id and lives for the life of this module, so a shared account would
   * let one test's unanswered ask answer for the next one.
   */
  const remountAccount: LocalAccount = {
    ...heldAccount,
    id: '0x9a1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c',
    custodyAddress: '0x9a1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c',
  };
  const reloadAccount: LocalAccount = {
    ...heldAccount,
    id: '0x9b2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d',
    custodyAddress: '0x9b2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d',
  };

  it('keeps the ask on screen, and does not re-record it', async () => {
    const first = render(<SeedBackupNotice account={remountAccount} />);

    expect(await screen.findByText('Back up your account')).toBeTruthy();

    const key = seedBackupKeyFor(remountAccount.id);
    const recorded = (store.get(key) as { lastShownAt: number }).lastShownAt;

    expect(typeof recorded).toBe('number');

    // The same page load, a second instance: what the app does when the
    // provider arrives and its subtree is replaced.
    first.unmount();
    render(<SeedBackupNotice account={remountAccount} />);

    expect(await screen.findByText('Back up your account')).toBeTruthy();
    // And the gap still measures from the first ask, not from this one.
    expect((store.get(key) as { lastShownAt: number }).lastShownAt).toBe(
      recorded,
    );
  });

  it('comes back when its own moment passes, even if the screen is built again', async () => {
    const cameBackAccount: LocalAccount = {
      ...heldAccount,
      id: '0x9d4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f',
      custodyAddress: '0x9d4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f',
    };
    const key = seedBackupKeyFor(cameBackAccount.id);

    // The person put it off days ago and that moment has since passed, so the ask
    // that is due now is a fresh one. The record it writes *as it asks* must not
    // be mistaken for an answer when the screen is created again — MEASURED
    // 2026-10-22 in a real Chrome at 390px, where it was: the notice recorded the
    // ask, the second creation read that record back as "asked just now", and the
    // reminder that should have come back did not.
    store.set(key, {
      status: 'deferred',
      reminders: 1,
      lastShownAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
      remindAfter: Date.now() - 1_000,
    });

    const first = render(<SeedBackupNotice account={cameBackAccount} />);

    expect(await screen.findByText('Back up your account')).toBeTruthy();

    const recorded = (store.get(key) as { lastShownAt: number }).lastShownAt;

    expect(recorded).toBeGreaterThan(Date.now() - 60_000);

    first.unmount();
    render(<SeedBackupNotice account={cameBackAccount} />);

    expect(await screen.findByText('Back up your account')).toBeTruthy();
    // And the gap still measures from the first ask of this page load.
    expect((store.get(key) as { lastShownAt: number }).lastShownAt).toBe(
      recorded,
    );
  });

  it("honours the person's own answer, whichever instance is on screen", async () => {
    const first = render(<SeedBackupNotice account={deviceAccount} />);

    fireEvent.click(await screen.findByText('Show me my backup words'));
    fireEvent.click(screen.getByText('I have written them down'));

    expect(
      await screen.findByText(/Saved\. Your account is written down/),
    ).toBeTruthy();

    first.unmount();
    render(<SeedBackupNotice account={deviceAccount} />);

    await waitFor(() => {
      expect(document.querySelector('[data-fiddy="seed-backup"]')).toBeNull();
    });
  });

  it('stays away when the person put it off, even if the screen is built again', async () => {
    const deferAccount: LocalAccount = {
      ...heldAccount,
      id: '0x9c3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3',
      custodyAddress: '0x9c3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3',
    };
    const key = seedBackupKeyFor(deferAccount.id);
    const first = render(<SeedBackupNotice account={deferAccount} />);

    fireEvent.click(await screen.findByText('Not now'));

    await waitFor(() =>
      expect(store.get(key)).toMatchObject({ status: 'deferred' }),
    );

    first.unmount();
    render(<SeedBackupNotice account={deferAccount} />);

    await waitFor(() => {
      expect(document.querySelector('[data-fiddy="seed-backup"]')).toBeNull();
    });
  });

  it('does not ask again on a new page load, because the ask is recorded', async () => {
    const first = render(<SeedBackupNotice account={reloadAccount} />);

    expect(await screen.findByText('Back up your account')).toBeTruthy();
    expect(
      typeof (
        store.get(seedBackupKeyFor(reloadAccount.id)) as {
          lastShownAt?: number;
        }
      ).lastShownAt,
    ).toBe('number');
    first.unmount();

    // A new page load, as a test can model one: the module registry is emptied,
    // so the in-page record of the ask is gone and only the device's own storage
    // is left to decide. (This is the half of the promise that must not change:
    // a reload is not a fresh ask.)
    vi.resetModules();

    const reloaded =
      await import('~/components/fiddy/seedBackup/SeedBackupNotice');

    render(
      React.createElement(reloaded.SeedBackupNotice, {
        account: reloadAccount,
      }),
    );

    // The notice's decision is an async read of the device's own storage; the
    // effect is flushed here, inside act, so the absence below is the app's
    // decision rather than the test racing it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(document.querySelector('[data-fiddy="seed-backup"]')).toBeNull();
  });
});

describe('something that is already saved', () => {
  it('is not asked about again, however the notice is mounted', async () => {
    store.set(seedBackupKeyFor(deviceAccount.id), {
      status: 'saved',
      reminders: 2,
      savedAt: Date.now(),
    });

    render(<SeedBackupNotice account={deviceAccount} />);

    await waitFor(() => {
      expect(document.querySelector('[data-fiddy="seed-backup"]')).toBeNull();
    });
  });
});
