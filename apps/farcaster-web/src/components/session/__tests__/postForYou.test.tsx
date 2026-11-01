// @vitest-environment jsdom

/**
 * The one-time "let Fiddy post as you" offer, pinned where it can be pinned:
 * the decision (every reason it is not offered), the setup (a real KEY_ADD, a
 * real custody signature, a fake node), and what the reader actually sees —
 * including that "Set it up" now raises the phone approval asking by itself,
 * with nothing to type, while the test-account warning still stands between the
 * card's collapsed developer disclosure and the recovery-phrase setup.
 *
 * Why here and not only in the browser probe: the offer's whole value is that
 * it appears in exactly the one situation it is for. An offer that shows up for
 * someone whose session a server can serve, or for an account that already has
 * a pass, is worse than no offer at all — so the negative cases are the ones
 * worth pinning. And the phrase prompt is the thing a normal reader must not be
 * able to reach by accident, which is a claim about a *screen*, not a function.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  appKeyFromPrivateKeyHex,
  bytesToHex,
  decodeMessageBytes,
  type NodeSigner,
  type SnapchainNodeClient,
} from 'farcaster-node-client';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecidePostForYouInput } from '~/components/session/postForYouOffer';

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

/**
 * The approval service, mocked: "Set it up" is a screen, and what is asserted
 * here is the screen. Approving for real happens in a person's own Farcaster
 * app, and the probe's stub is the browser's version of this mock.
 */
const connectStatus = vi.fn();
const startConnect = vi.fn();
const stopConnect = vi.fn();
const rememberConnectStatus = vi.fn();

// jsdom has no canvas, and the QR is drawn on one: the code itself is a
// library's business (it is the same component the sign-in modal already uses).
vi.mock('react-qrcode-logo', () => ({
  QRCode: () => <div data-testid="qr" />,
}));

vi.mock('~/snapchain/accounts/managedConnect', () => ({
  connectStatus: (...args: unknown[]) => connectStatus(...args),
  startConnect: (...args: unknown[]) => startConnect(...args),
  stopConnect: (...args: unknown[]) => stopConnect(...args),
  rememberConnectStatus: (...args: unknown[]) => rememberConnectStatus(...args),
}));

const state = vi.hoisted(() => ({
  authToken: undefined as { secret: string; expiresAt: number } | undefined,
  localApiEnabled: false,
  nodeBackedClient: true,
  nodeConfigured: true,
  user: undefined as { fid?: number; username?: string } | undefined,
}));

vi.mock('~/contexts/AuthProvider', () => ({
  useAuth: () => ({ authToken: state.authToken }),
}));

vi.mock('farcaster-client-hooks', () => ({
  useCachedOnboardingState: () => ({ result: { state: { user: state.user } } }),
}));

vi.mock('~/constants/api', () => ({
  get localApiEnabled() {
    return state.localApiEnabled;
  },
}));

vi.mock('~/snapchain/nodeApi/nodeBackedClientFlag', () => ({
  isNodeBackedClientEnabled: () => state.nodeBackedClient,
}));

vi.mock('~/snapchain/nodeChoice', () => ({
  isNodeConfigured: () => state.nodeConfigured,
}));

// The card only offers when there is a server to set the pass up against; the
// client itself is replaced per-test by the fake node below.
const fakeNodeRef = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('~/snapchain/useNodeClient', () => ({
  useNodeClient: () => fakeNodeRef.current,
}));

const { LOCAL_SESSION_SECRET_PREFIX } = await import('~/lib/siwfSession');
const { loadAppKey, loadAppNonce } = await import('~/snapchain/appKeyStorage');
const { decidePostForYou, describeSetupFailure, setUpPostingForYou } =
  await import('~/components/session/postForYouOffer');
const { PostForYouStep } = await import('~/components/session/PostForYouStep');

const localToken = {
  secret: `${LOCAL_SESSION_SECRET_PREFIX}4242:abc`,
  expiresAt: 0,
};
const serverToken = { secret: 'a-real-token', expiresAt: 0 };
const TEST_ACCOUNT_WORDS =
  'test test test test test test test test test test test junk';

const APPROVAL = 'https://warcast.example/~/add-signer?request=abc';

const NOTHING = {
  state: 'none' as const,
  approvalUrl: null,
  fid: null,
  username: null,
};

const WAITING = {
  status: {
    state: 'waiting' as const,
    approvalUrl: APPROVAL,
    fid: null,
    username: null,
  },
  reused: false,
};

const CONNECTED = {
  state: 'connected' as const,
  approvalUrl: null,
  fid: 4242,
  username: 'fiddy',
  // On fiddy.fun the posting key stays in the control plane and never reaches a
  // browser: nothing is written to this device's key store.
  postingKey: null,
};

/** A node that reads a nonce, accepts one KEY_ADD, and then reports the signer. */
const createFakeNode = (options: { nonce?: number } = {}) => {
  const submitted: Uint8Array[] = [];
  const signers = new Map<string, NodeSigner>();
  const reads: string[] = [];

  const node = {
    submitted,
    reads,
    async signersByFid() {
      reads.push('signersByFid');
      return {
        signers: [...signers.values()],
        gaslessSignerCount: signers.size,
        gaslessSignerLimit: 1000,
        currentUserNonce: options.nonce ?? 7,
      };
    },
    async submitMessage(bytes: Uint8Array) {
      submitted.push(bytes);
      const message = decodeMessageBytes(bytes);
      const body = message.data?.keyAddBody as { key?: Uint8Array } | undefined;
      const key = body?.key;
      if (key) {
        const keyHex = bytesToHex(key);
        signers.set(keyHex.toLowerCase(), {
          key: keyHex,
          keyType: 1,
          source: 'SIGNER_SOURCE_OFFCHAIN',
          fid: 4242,
        } as NodeSigner);
      }
      return { hash: '0xsubmitted', fid: 4242 } as never;
    },
  };

  return node as unknown as SnapchainNodeClient & {
    submitted: Uint8Array[];
    reads: string[];
  };
};

const offerAppears = async () => screen.findByText('Let Fiddy post as you?');

/**
 * "Not there" has to mean "not there", not "not yet": the pass and answer reads
 * are promises, so the queue is drained before the card is looked for.
 */
const offerIsAbsent = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.queryByText('Let Fiddy post as you?')).toBeNull();
};

const advancedDisclosure = () =>
  document.querySelector(
    '[data-fiddy="post-for-you-advanced"]',
  ) as HTMLDetailsElement;

const confirmButton = () =>
  screen.getByText('I understand, use a TEST account') as HTMLButtonElement;

beforeEach(() => {
  store.clear();
  state.authToken = localToken;
  state.localApiEnabled = false;
  state.nodeBackedClient = true;
  state.nodeConfigured = true;
  state.user = { fid: 4242, username: 'fiddy' };
  fakeNodeRef.current = createFakeNode();
  connectStatus.mockReset();
  startConnect.mockReset();
  stopConnect.mockReset();
  connectStatus.mockResolvedValue(NOTHING);
  startConnect.mockResolvedValue(WAITING);
});

describe('decidePostForYou', () => {
  const base: DecidePostForYouInput = {
    isLocalDeviceSession: true,
    adapterEnabled: true,
    nodeConfigured: true,
    fid: 4242,
    passState: 'absent',
    offerAnswer: 'unanswered',
  };

  it('offers once a signed-in device session has a server and no pass yet', () => {
    expect(decidePostForYou(base)).toEqual({ kind: 'offered', fid: 4242 });
  });

  it('stays quiet for every situation it is not for', () => {
    const cases: Array<[string, Partial<DecidePostForYouInput>]> = [
      ['a session a server can serve', { isLocalDeviceSession: false }],
      ['the adapter is off', { adapterEnabled: false }],
      ['no server is named', { nodeConfigured: false }],
      ['no account is known yet', { fid: undefined }],
      ['this device already has a pass', { passState: 'present' }],
      ['the reader already said not now', { offerAnswer: 'not-now' }],
      ['the offer was already approved', { offerAnswer: 'approved' }],
    ];

    for (const [why, patch] of cases) {
      const decision = decidePostForYou({ ...base, ...patch });
      expect(decision.kind, why).toBe('not-offered');
    }

    expect(
      decidePostForYou({ ...base, passState: 'unknown' }).kind,
      'the pass read has not answered yet',
    ).toBe('not-offered');
    expect(
      decidePostForYou({ ...base, offerAnswer: undefined }).kind,
      'the answer read has not answered yet',
    ).toBe('not-offered');
  });
});

describe('describeSetupFailure', () => {
  it('says a full account is full, in the reader words, not the node words', () => {
    const said = describeSetupFailure(
      'This FID already has 1000/1000 gasless keys — revoke one first',
    );
    expect(said).toMatch(/as many of these passes as it can/);
    expect(said).toMatch(/Advanced/);
    expect(said).not.toMatch(/gasless|FID|revoke/);
  });

  it('leaves a reason it does not know as the reason, prefixed', () => {
    expect(describeSetupFailure('the node said no')).toBe(
      'It did not go through: the node said no',
    );
  });
});

describe('setUpPostingForYou', () => {
  it('issues one pass, signs it with the account, and stores only the pass', async () => {
    const node = createFakeNode();

    const result = await setUpPostingForYou({
      node,
      fid: 4242,
      mnemonic: TEST_ACCOUNT_WORDS,
      confirmAttempts: 2,
      confirmIntervalMs: 0,
      sleep: async () => undefined,
    });

    // The node was read for the account's state, then handed exactly one
    // message — the custody-signed authorization.
    expect(node.reads.length).toBeGreaterThan(0);
    expect(node.submitted.length).toBe(1);

    // What is kept on this device is the pass, and it is the pass that was
    // built: the KEY_ADD in the submitted bytes carries this key's public half.
    const storedKey = await loadAppKey(4242);
    expect(storedKey).toMatch(/^0x[0-9a-f]+$/);
    const built = decodeMessageBytes(node.submitted[0]);
    const body = built.data?.keyAddBody as { key?: Uint8Array } | undefined;
    const derived = await appKeyFromPrivateKeyHex(storedKey as string);
    expect(derived.publicKeyHex.toLowerCase()).toBe(
      bytesToHex(body?.key as Uint8Array).toLowerCase(),
    );

    // The account's next nonce is recorded for the follow-up writes.
    expect(await loadAppNonce(4242)).toBe(9);
    expect(result.signer.fid).toBe(4242);

    // No other account's storage was touched, and no phrase was written down.
    expect(await loadAppKey(9999)).toBeNull();
    expect(
      [...store.keys()].some((key) => /mnemonic|seed|phrase/i.test(key)),
    ).toBe(false);
  });
});

describe('PostForYouStep', () => {
  it('offers the step, right where the reader is, once sign-in is done', async () => {
    render(<PostForYouStep />);

    await offerAppears();
    expect(screen.getByText('Set it up')).toBeTruthy();
    expect(screen.getByText('Not now')).toBeTruthy();
    // What approving costs, and the honest limit, on the card itself.
    expect(screen.getByText(/one tap in your own Farcaster app/)).toBeTruthy();
    expect(screen.getByText(/stay where they are/)).toBeTruthy();
    // Plain words only: none of the protocol's vocabulary reaches the reader.
    expect(
      screen.queryByText(/gasless|signer|scope|app key|KEY_ADD/i),
    ).toBeNull();
    // Nothing on this card asks for a phrase: no input, no warning screen.
    expect(document.querySelector('#mnemonic')).toBeNull();
    expect(screen.queryByText(/Security warning/)).toBeNull();
  });

  it('offers nothing when a server can serve this session', async () => {
    state.authToken = serverToken;
    render(<PostForYouStep />);
    await offerIsAbsent();
  });

  it('offers nothing when no server is named', async () => {
    state.nodeConfigured = false;
    render(<PostForYouStep />);
    await offerIsAbsent();
  });

  it('offers nothing to an account this device already posts for', async () => {
    store.set('snapchain_app_key_4242', '0xalready');
    render(<PostForYouStep />);
    await offerIsAbsent();
  });

  it('remembers "not now" on the device, so the offer is made once', async () => {
    const { getByText } = render(<PostForYouStep />);
    await offerAppears();

    getByText('Not now').click();

    await waitFor(() =>
      expect(screen.queryByText('Let Fiddy post as you?')).toBeNull(),
    );
    expect(store.get('fiddy_post_for_you_4242_answer')).toBe('not-now');
  });

  it('raises the phone approval from "Set it up", asking by itself', async () => {
    render(<PostForYouStep />);
    await offerAppears();

    fireEvent.click(screen.getByText('Set it up'));

    await screen.findByText('One tap in Farcaster to finish');
    // Asking, not connecting: one request, made without a second press.
    expect(startConnect).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-fiddy="post-for-you-approval"]'),
    ).not.toBeNull();
    const link = document.querySelector(
      '[data-fiddy="connect-approval-link"]',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(APPROVAL);
    expect(document.querySelector('[data-fiddy="connect-qr"]')).not.toBeNull();

    // No phrase field, and no warning screen, anywhere on the way here.
    expect(document.querySelector('#mnemonic')).toBeNull();
    expect(screen.queryByText(/Security warning/)).toBeNull();
    // The card's own buttons are out of the way while the approval is asking.
    expect(screen.queryByText('Set it up')).toBeNull();
  });

  it('leaves the offer standing when the approval is closed without approving', async () => {
    render(<PostForYouStep />);
    await offerAppears();

    fireEvent.click(screen.getByText('Set it up'));
    await screen.findByText('One tap in Farcaster to finish');

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    await offerAppears();
    // Closing the sheet is not an answer: the offer is still offered, and the
    // reader may still say not now properly — or approve.
    expect(store.get('fiddy_post_for_you_4242_answer')).toBeUndefined();
    expect(
      document.querySelector('[data-fiddy="post-for-you-approval"]'),
    ).toBeNull();
  });

  it('ends the offer, and remembers it, the moment the approval arrives', async () => {
    connectStatus.mockResolvedValue(CONNECTED);
    render(<PostForYouStep />);
    await offerAppears();

    fireEvent.click(screen.getByText('Set it up'));

    // The service's own answer ends it — no second press, no sign-in screen.
    await screen.findByText(/Fiddy can post for you now/);
    expect(
      document.querySelector('[data-fiddy="post-for-you-approval"]'),
    ).toBeNull();
    expect(store.get('fiddy_post_for_you_4242_answer')).toBe('approved');
    // Nothing was typed and no pass was made on this device: Fiddy holds it.
    expect(await loadAppKey(4242)).toBeNull();

    // The done line goes away by itself, and the offer does not come back.
    await waitFor(
      () =>
        expect(
          document.querySelector('[data-fiddy="post-for-you-done"]'),
        ).toBeNull(),
      { timeout: 6000 },
    );
    expect(screen.queryByText('Let Fiddy post as you?')).toBeNull();
  }, 10_000);

  it('keeps the phrase step collapsed, and still blocking, behind the developer disclosure', async () => {
    render(<PostForYouStep />);
    await offerAppears();

    // A normal reader never meets it: it is closed, and it says who it is for.
    const details = advancedDisclosure();
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(
      screen.getByText(
        'Advanced: test account recovery phrase (developers only)',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Security warning/)).toBeNull();

    // Opening it is the reader's own act, and the door says what it is.
    fireEvent.click(details.querySelector('summary') as HTMLElement);
    if (!details.open) {
      // jsdom does not implement <summary>'s activation behaviour everywhere:
      // set what a browser would set and let the card read it back.
      details.open = true;
      fireEvent(details, new Event('toggle'));
    }
    expect(details.open).toBe(true);

    fireEvent.click(screen.getByText(/Use a test account.s recovery phrase/));

    // Advanced's own screen, verbatim, and it blocks: acknowledged by checkbox,
    // not dismissible by accident.
    await screen.findByText(/Security warning/);
    expect(screen.getByText(/Use a TEST account/)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);

    fireEvent.change(document.querySelector('#mnemonic') as HTMLElement, {
      target: { value: TEST_ACCOUNT_WORDS },
    });
    expect(confirmButton().disabled).toBe(true);

    fireEvent.click(
      document.querySelector('input[type=checkbox]') as HTMLElement,
    );
    expect(confirmButton().disabled).toBe(false);

    // A pass this device already stores is never re-issued by the offer.
    expect(await loadAppKey(4242)).toBeNull();
  });
});
