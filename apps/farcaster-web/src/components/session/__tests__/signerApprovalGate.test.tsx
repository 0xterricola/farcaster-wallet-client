// @vitest-environment jsdom
/**
 * The approval that goes up where the person is, as a screen.
 *
 * The store's own contract is pinned in
 * `~/snapchain/accounts/__tests__/postingKeyApproval.test.ts`; this file is the
 * visible half: pressing the heart with no posting key yet raises the approval
 * sheet *in place*, the sheet is the same one `/connect-farcaster` shows, the
 * sentence names what was pressed (never a protocol word), approving turns the
 * screen into one honest line while the write goes out, and saying not now
 * leaves nothing behind.
 *
 * The service is mocked — approving for real happens in a person's own Farcaster
 * app — so what is asserted is the sequence of screens and the store's decisions
 * around them.
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
const startConnect = vi.fn();
const stopConnect = vi.fn();
const rememberConnectStatus = vi.fn();

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
  startConnect: (...args: unknown[]) => startConnect(...args),
  stopConnect: (...args: unknown[]) => stopConnect(...args),
  rememberConnectStatus: (...args: unknown[]) => rememberConnectStatus(...args),
  isServiceUnreachable: () => false,
}));

import { SignerApprovalGate } from '~/components/session/SignerApprovalGate';
import { postingKeyApproval } from '~/snapchain/accounts/postingKeyApproval';
import type { WriteApprovalRequest } from '~/snapchain/nodeApi/nodeWrites';

const APPROVAL = 'https://client.farcaster.xyz/deeplinks/signed-key-request';

const WAITING = {
  status: {
    state: 'waiting' as const,
    approvalUrl: APPROVAL,
    fid: null,
    username: null,
  },
  reused: false,
};

const NONE = {
  state: 'none' as const,
  approvalUrl: null,
  fid: null,
  username: null,
};

const CONNECTED = {
  state: 'connected' as const,
  approvalUrl: null,
  fid: 3,
  username: 'dwr',
  // This gate starts the request itself (autoStart), so the answer is its own
  // tab's — which is what lets the person's own account be adopted here.
  startedHere: true,
};

/** A write waiting on the approval, with a carry the test controls. */
const waitingWrite = (): {
  request: WriteApprovalRequest;
  answered: Promise<Response | null>;
  finish: (response: Response) => void;
  carried: number;
} => {
  let finish: (response: Response) => void = () => undefined;
  const carry = () =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    });
  const request: WriteApprovalRequest = { fid: 3, label: 'like', carry };
  return {
    request,
    answered: postingKeyApproval.ask(request),
    finish: (response) => finish(response),
    carried: 0,
  };
};

beforeEach(() => {
  connectStatus.mockReset();
  startConnect.mockReset();
  stopConnect.mockReset();
  connectStatus.mockResolvedValue(NONE);
  startConnect.mockResolvedValue(WAITING);
});

afterEach(() => {
  cleanup();
  // Whatever the test did, the store must not leak into the next one.
  postingKeyApproval.declined();
});

describe('the inline approval gate', () => {
  it('renders nothing at all when no write is waiting', () => {
    render(<SignerApprovalGate />);
    expect(
      document.querySelector('[data-fiddy="signer-approval-gate"]'),
    ).toBeNull();
  });

  it('raises the approval sheet in place, naming what was pressed', async () => {
    const write = waitingWrite();
    render(<SignerApprovalGate />);

    await waitFor(() =>
      expect(
        document.querySelector('[data-fiddy="signer-approval-gate"]'),
      ).not.toBeNull(),
    );

    // It asked by itself: no second press, and the request is the service's own.
    await waitFor(() => expect(startConnect).toHaveBeenCalled());

    // The sentence says what happens to the thing they pressed, in their words.
    expect(
      await screen.findByText(/your like goes out by itself/i),
    ).toBeTruthy();
    expect(document.querySelector('[data-fiddy="connect-qr"]')).not.toBeNull();

    // No protocol word reaches this screen.
    const text = (document.body.innerText ?? '').toLowerCase();
    for (const banned of ['signer', 'scope', 'ttl', 'gasless']) {
      expect(text).not.toContain(banned);
    }

    postingKeyApproval.declined();
    await write.answered;
  });

  it('says one line while the approved write goes out, then gets out of the way', async () => {
    connectStatus.mockResolvedValue(CONNECTED);
    const write = waitingWrite();
    render(<SignerApprovalGate />);

    // The service's own answer reaches the store: no second press, no sign-in.
    await waitFor(() => expect(connectStatus).toHaveBeenCalled());

    const done = await screen.findByText(/approved — your like is going out/i);
    expect(done.getAttribute('data-fiddy')).toBe('signer-approval-done');
    // The asking screen is gone; this is the carrying one.
    expect(
      document.querySelector('[data-fiddy="signer-approval-gate"]'),
    ).toBeNull();

    write.finish(new Response('{}', { status: 200 }));
    expect((await write.answered)?.status).toBe(200);

    await waitFor(() =>
      expect(
        document.querySelector('[data-fiddy="signer-approval-done"]'),
      ).toBeNull(),
    );
  });

  it('leaves nothing behind when the person says not now', async () => {
    const write = waitingWrite();
    render(<SignerApprovalGate />);

    const notNow = await screen.findByRole('button', { name: 'Not now' });
    fireEvent.click(notNow);

    expect(await write.answered).toBeNull();
    await waitFor(() =>
      expect(
        document.querySelector('[data-fiddy="signer-approval-gate"]'),
      ).toBeNull(),
    );
  });
});
