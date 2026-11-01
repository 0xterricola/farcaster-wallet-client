// @vitest-environment jsdom
/**
 * The connect sheet as a person meets it: one button, one approval, one honest
 * sentence per outcome.
 *
 * The service is mocked, so what is asserted here is the *screen*: that the
 * approval link is handed over, that the screen notices the approval by itself,
 * that a failure replaces the button with words rather than leaving it dead —
 * and that none of these screens use a word this product bans from its own copy.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectStatus = vi.fn();
const startConnect = vi.fn();
const stopConnect = vi.fn();
const rememberConnectStatus = vi.fn();
const isServiceUnreachable = vi.fn();

// jsdom has no canvas, and the QR is drawn on one: the code itself is a
// library's business (it is the same component the sign-in modal already uses),
// what these tests are about is the screen around it.
vi.mock('react-qrcode-logo', () => ({
  QRCode: () => <div data-testid="qr" />,
}));

vi.mock('~/snapchain/accounts/managedConnect', () => ({
  connectStatus: (...args: unknown[]) => connectStatus(...args),
  startConnect: (...args: unknown[]) => startConnect(...args),
  stopConnect: (...args: unknown[]) => stopConnect(...args),
  rememberConnectStatus: (...args: unknown[]) => rememberConnectStatus(...args),
  forgetConnectAttempt: vi.fn(),
  // Whether the failure was "nothing answered here" or "the service said no".
  // A knob here, because the two cases are different screens.
  isServiceUnreachable: (...args: unknown[]) => isServiceUnreachable(...args),
}));

/**
 * Who this browser is signed in as. Mutable, because the sheet's whole identity
 * behaviour depends on it: the same service answer means different things to a
 * device signed in as somebody and a device signed in as nobody.
 */
const state: { user?: { fid: number; username?: string } } = {};

vi.mock('farcaster-client-hooks', () => ({
  useCachedOnboardingState: () => ({
    result: { state: { user: state.user } },
  }),
}));

import { ConnectSheet } from '~/components/fiddy/accounts/ConnectSheet';

const APPROVAL = 'https://warcast.example/~/add-signer?request=abc';

beforeEach(() => {
  state.user = undefined;
  connectStatus.mockReset();
  startConnect.mockReset();
  stopConnect.mockReset();
  isServiceUnreachable.mockReset();
  // Every other case here is a service that answered; the case that is not says
  // so itself.
  isServiceUnreachable.mockReturnValue(false);
  connectStatus.mockResolvedValue({
    state: 'none',
    approvalUrl: null,
    fid: null,
    username: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ConnectSheet', () => {
  it('opens on one sentence and one button, and says what it is asking for', async () => {
    render(<ConnectSheet />);
    await screen.findByText('Connect your Farcaster account');
    expect(
      screen.getByText(/without a fee and without a passphrase/i),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    // The honest limit is on the first screen, not buried behind Advanced.
    expect(screen.getByText(/stay where they are/i)).toBeTruthy();
  });

  it('hands over the approval link when the person presses Connect', async () => {
    startConnect.mockResolvedValue({
      status: {
        state: 'waiting',
        approvalUrl: APPROVAL,
        fid: null,
        username: null,
      },
      reused: false,
    });
    render(<ConnectSheet />);
    await screen.findByRole('button', { name: 'Connect' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await screen.findByText('One tap in Farcaster to finish');
    const link = document.querySelector(
      '[data-fiddy="connect-approval-link"]',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(APPROVAL);
    expect(document.querySelector('[data-fiddy="connect-qr"]')).toBeTruthy();
  });

  it('notices the approval by itself, and says what is now true', async () => {
    startConnect.mockResolvedValue({
      status: {
        state: 'waiting',
        approvalUrl: APPROVAL,
        fid: null,
        username: null,
      },
      reused: false,
    });
    connectStatus
      .mockResolvedValueOnce({
        state: 'none',
        approvalUrl: null,
        fid: null,
        username: null,
      })
      .mockResolvedValue({
        state: 'connected',
        approvalUrl: null,
        fid: 4242,
        username: 'someone',
        startedHere: true,
      });

    render(<ConnectSheet />);
    await screen.findByRole('button', { name: 'Connect' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText('One tap in Farcaster to finish');

    // No second press: the waiting screen asks on its own.
    await screen.findByText('Connected as @someone', undefined, {
      timeout: 6000,
    });
    expect(
      screen.getByText(/Fiddy can post for you — turn it off anytime/i),
    ).toBeTruthy();
  }, 10_000);

  it('never leaves a dead button: a refusal becomes a sentence and a way forward', async () => {
    startConnect.mockRejectedValue(
      Object.assign(
        new Error('connecting an account is not switched on here yet.'),
        { code: 'CONNECT_NOT_SET_UP' },
      ),
    );
    render(<ConnectSheet />);
    await screen.findByRole('button', { name: 'Connect' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await screen.findByText('That did not go through');
    expect(
      screen.getByText('connecting an account is not switched on here yet.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByText(/Nothing changed in your account/i)).toBeTruthy();
  });

  it('carries the slow path when nothing answers at this address', async () => {
    // The self-hosted case: `fiddy client up` serves the client from the
    // reader's own machine, so Fiddy's service is not at that address at all.
    // "Try again" alone there is a press loop; the screen has to name the one
    // path that works on that box (the reader's own setup) and reach it.
    startConnect.mockRejectedValue(new Error('no service at this address'));
    isServiceUnreachable.mockReturnValue(true);

    render(<ConnectSheet />);
    await screen.findByRole('button', { name: 'Connect' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await screen.findByText('That did not go through');
    expect(
      screen.getByRole('button', { name: 'Open your own setup' }),
    ).toBeTruthy();
    expect(
      screen.getByText(/does not have that at this address/i),
    ).toBeTruthy();
  });

  it('shows the way back when the person turns the key off, and calls the service', async () => {
    connectStatus.mockResolvedValue({
      state: 'connected',
      approvalUrl: null,
      fid: 4242,
      username: 'someone',
      startedHere: true,
    });
    stopConnect.mockResolvedValue({
      state: 'revoked',
      approvalUrl: null,
      fid: null,
      username: null,
    });

    render(<ConnectSheet />);
    await screen.findByText('Connected as @someone');
    fireEvent.click(screen.getByRole('button', { name: 'Turn it off' }));

    await screen.findByText("Fiddy's access is off");
    expect(stopConnect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeTruthy();
  });

  it('keeps the banned words out of every screen it shows', async () => {
    // The product's jargon ban, as a test: these words belong in the design
    // notes and the code, never on a screen.
    const banned = [
      /signer/i,
      /\bscope/i,
      /\bTTL\b/,
      /gasless/i,
      /\bAPI key\b/i,
      /\bnonce\b/i,
      /\bnode\b/i,
    ];

    startConnect.mockResolvedValue({
      status: {
        state: 'waiting',
        approvalUrl: APPROVAL,
        fid: null,
        username: null,
      },
      reused: false,
    });
    const { container } = render(<ConnectSheet />);
    await screen.findByRole('button', { name: 'Connect' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText('One tap in Farcaster to finish');

    const copy = container.textContent ?? '';
    for (const word of banned) {
      expect(copy).not.toMatch(word);
    }
  });

  it('asks by itself when something is waiting on it, and names what that is', async () => {
    // The inline case: the person pressed the heart, the write is held, and
    // this sheet is the thing they are being asked for. There is no first
    // screen to press — and the sentence says what the approval will finish.
    startConnect.mockResolvedValue({
      status: {
        state: 'waiting',
        approvalUrl: APPROVAL,
        fid: null,
        username: null,
      },
      reused: false,
    });

    const { container } = render(
      <ConnectSheet
        autoStart
        completing="Your like goes out by itself — there is nothing to press when you come back."
      />,
    );

    await screen.findByText('One tap in Farcaster to finish');
    expect(startConnect).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(/Your like goes out by itself/);
    // Asking, not connecting: the connect door's own first screen never shows.
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('hands the approval to its caller instead of signing anybody in', async () => {
    startConnect.mockResolvedValue({
      status: {
        state: 'waiting',
        approvalUrl: APPROVAL,
        fid: null,
        username: null,
      },
      reused: false,
    });
    const onApproved = vi.fn();

    render(<ConnectSheet autoStart onApproved={onApproved} />);
    await screen.findByText('One tap in Farcaster to finish');

    connectStatus.mockResolvedValue({
      state: 'connected',
      approvalUrl: null,
      fid: 3,
      username: 'dwr',
      startedHere: true,
    });
    await screen.findByText('One tap in Farcaster to finish');
    // The sheet polls every 2.5 s, so this waits for a poll that has not
    // happened yet rather than for a state the render just set.
    await vi.waitFor(() => expect(onApproved).toHaveBeenCalledWith(3, 'dwr'), {
      timeout: 8000,
    });
    // The sheet's own Connected screen — which offers to sign in — is not shown.
    expect(screen.queryByText('Connected as @dwr')).toBeNull();
  });

  it('never becomes the account Fiddy’s own approval landed on, and says nothing about it', async () => {
    // The worst bug this flow can have: a person's session bound to the
    // project's own Farcaster account. The service refuses that approval and
    // tells the browser nothing — no number, no handle — so there is nothing
    // here to adopt, and the screen says what happened.
    state.user = undefined;
    connectStatus.mockResolvedValue({
      state: 'wrong_account',
      approvalUrl: null,
      fid: null,
      username: null,
      forFid: 191554,
      refused: 'app_account',
      startedHere: true,
    });

    const { container } = render(<ConnectSheet />);
    await screen.findByText('That approval was not for your account');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    // The project's own account, by number or by name, is nowhere on the page.
    expect(container.textContent).not.toContain('3356372');
    expect(container.textContent).not.toContain('fiddy-one');
  });

  it('never switches a signed-in session to a different account', async () => {
    // Signed in as 191554, and the device's connection belongs to 4242: the
    // sheet reports it and offers to connect THIS person's account. It does not
    // offer to become the other one.
    state.user = { fid: 191554, username: 'ivc' };
    connectStatus.mockResolvedValue({
      state: 'connected',
      approvalUrl: null,
      fid: 4242,
      username: 'someone',
      forFid: 4242,
      refused: null,
      startedHere: true,
    });

    render(<ConnectSheet />);
    await screen.findByText('That connection is for a different account');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Connect my account' }),
    ).toBeTruthy();
    expect(screen.queryByText('Connected as @someone')).toBeNull();
  });

  it('does not adopt a connection this device never asked for', async () => {
    // Nobody signed in, and the cookie holds an approved connection from an
    // earlier visit: it is named and confirmed, never entered in one tap.
    state.user = undefined;
    connectStatus.mockResolvedValue({
      state: 'connected',
      approvalUrl: null,
      fid: 4242,
      username: 'someone',
      forFid: null,
      refused: null,
      startedHere: false,
    });

    render(<ConnectSheet />);
    await screen.findByText('Connected as @someone on this device');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getByRole('button', { name: /That's me/ })).toBeTruthy();
  });

  it('signs this person in as their own account after their own approval', async () => {
    // The door the flow is for: nobody signed in, this tab started the request,
    // the person approved it in their own Farcaster app — so this tab becomes
    // that account, and only that one.
    state.user = undefined;
    connectStatus.mockResolvedValue({
      state: 'connected',
      approvalUrl: null,
      fid: 191554,
      username: 'ivc',
      forFid: 191554,
      refused: null,
      startedHere: true,
    });

    render(<ConnectSheet />);
    await screen.findByText('Connected as @ivc');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });
});
