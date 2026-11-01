// @vitest-environment jsdom
/**
 * The card that is now the primary way to let Fiddy post for you.
 *
 * The screen it replaced is the point: this card's one button used to be "Issue
 * app key", which opened a blocking recovery-phrase prompt
 * (`SeedPhraseWarningModal`). Now the phone approval is the flow a reader meets
 * here — the same sheet `/connect-farcaster` shows — and the phrase prompt lives
 * behind a collapsed disclosure on the page (`SettingsNodePage`).
 *
 * The service is mocked; what is asserted is what the card says and does with
 * its answers, including the ones it does not recognise.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectStatus = vi.fn();
const rememberConnectStatus = vi.fn();
const stopConnect = vi.fn();

/**
 * Who this browser is signed in as. The sheet asks (a connection may only be
 * adopted for the account a person is signed in as, or by the tab that started
 * it), and a unit test of another surface has no session — so no account.
 */
vi.mock('farcaster-client-hooks', () => ({
  useCachedOnboardingState: () => ({ result: { state: { user: undefined } } }),
}));

vi.mock('react-qrcode-logo', () => ({
  QRCode: () => <div data-testid="qr" />,
}));

vi.mock('~/snapchain/accounts/managedConnect', () => ({
  connectStatus: (...args: unknown[]) => connectStatus(...args),
  rememberConnectStatus: (...args: unknown[]) => rememberConnectStatus(...args),
  stopConnect: (...args: unknown[]) => stopConnect(...args),
  // This card's own cases are a service that answered; the self-hosted case is
  // asserted in the browser probe (`scripts/verify-first-cast-path.mjs`).
  isServiceUnreachable: () => false,
}));

import { PostingKeyCard } from './PostingKeyCard';

const NONE = {
  state: 'none' as const,
  approvalUrl: null,
  fid: null,
  username: null,
};

beforeEach(() => {
  connectStatus.mockReset();
  stopConnect.mockReset();
  connectStatus.mockResolvedValue(NONE);
});

afterEach(() => {
  cleanup();
});

describe('the posting key card', () => {
  it('offers the phone approval, and says what it costs (nothing)', async () => {
    render(<PostingKeyCard fid={3} />);

    expect(await screen.findByText(/no fee, no passphrase/i)).toBeTruthy();
    const approve = await screen.findByRole('button', {
      name: 'Approve on my phone',
    });
    // Nothing on this card asks for a phrase: no field to type one into, and no
    // blocking warning in front of it. (The card *says* the phrase stays where
    // it is — that is the promise, not a prompt.)
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/Security warning/i)).toBeNull();
    expect(approve).toBeTruthy();
  });

  it('opens the approval sheet, asking, when the person presses the button', async () => {
    render(<PostingKeyCard fid={3} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve on my phone' }),
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-fiddy="posting-key-sheet"]'),
      ).not.toBeNull(),
    );
  });

  it('names the app key this device can make when no service answers here', async () => {
    // The self-hosted case (`fiddy client up`): the phone approval needs a
    // service that is not at this address, and the app key below is the one
    // thing that can post. The card must say so and open that control, not
    // leave the reader with "post in your Farcaster app instead".
    connectStatus.mockRejectedValue(new Error('no service at this address'));
    const onUseOwnAppKey = vi.fn();
    const onServiceUnreachable = vi.fn();
    render(
      <PostingKeyCard
        fid={3}
        onUseOwnAppKey={onUseOwnAppKey}
        onServiceUnreachable={onServiceUnreachable}
      />,
    );

    const offer = await screen.findByRole('button', {
      name: 'Show the app key setup',
    });
    expect(screen.getByText(/device’s own app key/i)).toBeTruthy();
    expect(onServiceUnreachable).toHaveBeenCalled();

    fireEvent.click(offer);
    expect(onUseOwnAppKey).toHaveBeenCalledTimes(1);
  });

  it('says what is true when an account is connected, and can turn it off', async () => {
    connectStatus.mockResolvedValue({
      state: 'connected',
      approvalUrl: null,
      fid: 3,
      username: 'dwr',
    });
    stopConnect.mockResolvedValue({
      state: 'revoked',
      approvalUrl: null,
      fid: 3,
      username: 'dwr',
    });
    render(<PostingKeyCard fid={3} />);

    expect(await screen.findByText(/connected as @dwr/i)).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Turn it off' }));

    await waitFor(() => expect(stopConnect).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Fiddy’s access is off/i)).toBeTruthy();
  });

  it('says so in one sentence when the service cannot be reached', async () => {
    connectStatus.mockRejectedValue(new Error('nothing was connected.'));
    render(<PostingKeyCard fid={3} />);

    const state = await screen.findByText(/nothing was connected/i);
    expect(state.getAttribute('data-fiddy')).toBe('posting-key-state');
    expect(
      screen.getByText(/post in your Farcaster app as usual/i),
    ).toBeTruthy();
  });

  it('asks the reader to sign in rather than offering a button that cannot work', async () => {
    render(<PostingKeyCard />);
    const button = await screen.findByRole('button', { name: 'Sign in first' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
