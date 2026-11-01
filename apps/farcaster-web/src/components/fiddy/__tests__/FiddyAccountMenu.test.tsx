// @vitest-environment jsdom

/**
 * The card is "sign out is unfindable", so what this file pins is the reach,
 * not the styling: the account menu carries a plain "Sign out" item, and that
 * item is what opens the confirmation — and the confirmation is the only thing
 * that calls `signOut()`. A menu that renders the words and wires them to
 * nothing would pass a screenshot and fail the person who asked for this.
 *
 * The three surfaces that open this panel (the desktop top bar, the phone's
 * header, the phone's "You" tab) are measured in the browser by
 * `scripts/verify-sign-out.mjs`, at 390 and 1440, on every surface of the
 * signed-in shell. This file keeps the wiring honest without needing a browser.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  signOut: vi.fn(async () => undefined),
  user: {
    username: 'dwr',
    displayName: 'dwr',
    pfp: undefined,
  } as {
    username?: string;
    displayName?: string;
    pfp?: { url?: string };
  },
}));

vi.mock('~/contexts/AuthProvider', () => ({
  useAuth: () => ({ signOut: state.signOut }),
}));

vi.mock('~/contexts/WalletLockedProvider', () => ({
  useWalletLocked: () => ({ lockWallet: vi.fn() }),
}));

vi.mock('~/contexts/GlobalKeyPressProvider', () => ({
  useGlobalKeyPress: () => ({ addKeyPressListener: () => () => undefined }),
}));

// The modal boundary portals into `#modal-root`, which jsdom does not have.
vi.mock('~/components/modals/Modal', async () => {
  const React = await import('react');

  return {
    Modal: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock('~/hooks/data/useCurrentUser', () => ({
  useCurrentUser: () => state.user,
}));

const { FiddyAccountMenu } =
  await import('~/components/fiddy/FiddyAccountMenu');

/** The chrome's own shape: it owns `isOpen`, the menu asks it to close. */
const MenuHarness = ({ onClose }: { onClose: () => void }) => {
  const [isOpen, setIsOpen] = React.useState(true);

  return (
    <FiddyAccountMenu
      isOpen={isOpen}
      onClose={() => {
        onClose();
        setIsOpen(false);
      }}
    />
  );
};

const renderMenu = (onClose: () => void = () => undefined) =>
  render(
    <MemoryRouter>
      <MenuHarness onClose={onClose} />
    </MemoryRouter>,
  );

const clickOn = (selector: string) => {
  const element = document.querySelector(selector);

  if (element === null) {
    throw new Error(`${selector} is not on screen`);
  }

  fireEvent.click(element);
};

describe('the account menu', () => {
  beforeEach(() => {
    state.signOut.mockClear();
  });

  it('says "Sign out" in plain words, beside Profile and Settings', () => {
    renderMenu();

    expect(screen.getByText('Sign out')).toBeTruthy();
    expect(screen.getByText('Profile')).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
    // Whose account this is, which is the other half of "sign out of WHAT".
    expect(screen.getByText('@dwr')).toBeTruthy();

    expect(
      document.querySelector('[data-fiddy="account-menu"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-fiddy="account-menu-sign-out"]'),
    ).not.toBeNull();
  });

  it('confirms before it signs anybody out, and the confirm is what signs out', async () => {
    const onClose = vi.fn();

    renderMenu(onClose);

    clickOn('[data-fiddy="account-menu-sign-out"]');

    await waitFor(() => {
      expect(
        document.querySelector('[data-fiddy="sign-out-modal"]'),
      ).not.toBeNull();
    });

    // The panel gets out of the confirmation's way — its backdrop would
    // otherwise sit over the dialog and eat the taps meant for it.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-fiddy="account-menu"]')).toBeNull();

    // Still nobody signed out — the confirm is a confirm.
    expect(state.signOut).not.toHaveBeenCalled();
    expect(screen.getByText('Sign out?')).toBeTruthy();

    clickOn('[data-fiddy="sign-out-confirm"]');

    await waitFor(() => {
      expect(state.signOut).toHaveBeenCalledTimes(1);
    });
  });

  it('leaves the account alone when the confirm is cancelled', async () => {
    renderMenu();

    clickOn('[data-fiddy="account-menu-sign-out"]');

    await waitFor(() => {
      expect(
        document.querySelector('[data-fiddy="sign-out-cancel"]'),
      ).not.toBeNull();
    });

    clickOn('[data-fiddy="sign-out-cancel"]');

    await waitFor(() => {
      expect(
        document.querySelector('[data-fiddy="sign-out-modal"]'),
      ).toBeNull();
    });

    expect(state.signOut).not.toHaveBeenCalled();
  });
});
