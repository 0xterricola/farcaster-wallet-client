/**
 * The host's own mini app wire, pinned to the frame it serves.
 *
 * `@farcaster/miniapp-host` exposes the SDK with
 * `Comlink.expose(sdk, endpoint, [miniAppOrigin])`, and the listener behind it
 * is bound to *this* window — the host's own global — while comlink checks only
 * the sender's origin and never `event.source`. With this client's
 * `miniAppOrigin: '*'` any window that can post into the host could therefore
 * invoke the spec members (see `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §5.2, §7
 * row 5).
 *
 * These tests hold both halves of the fix: a message from a window that is not
 * the mini app frame, or from another origin, reaches nothing; and a real mini
 * app's own calls — `context`, `composeCast`, `signIn`, the EIP-6963 announce
 * and both wallet channels — still reach the host, driven through the package's
 * own `exposeToEndpoint` so the assertion is about the wire and not a copy of
 * it.
 */

import { exposeToEndpoint } from '@farcaster/miniapp-host';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  gateMiniAppWire,
  isFromMiniAppFrame,
  isPinnedOrigin,
  pinnedMiniAppOrigin,
  WireMessageEvent,
} from '~/components/miniApp/miniAppWireGate';

const FRAME_ORIGIN = 'https://app.example';
const OTHER_ORIGIN = 'https://not-the-app.example';

/** The frame's own window object, as the host's `iframe.contentWindow` sees it. */
const frameWindow = { name: 'the mini app frame' };
/** Any other window that can post into the host: a sibling frame, an ad iframe. */
const foreignWindow = { name: 'some other window' };

// --- the host's own window, and an endpoint shaped like the package's --------

type DeliveredMessage = { source?: unknown; origin?: string; data?: unknown };

function fakeHostWindow() {
  const listeners = new Set<EventListener>();

  return {
    addEventListener: (type: string, listener: EventListener) => {
      if (type === 'message') {
        listeners.add(listener);
      }
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (type === 'message') {
        listeners.delete(listener);
      }
    },
    deliver: (message: DeliveredMessage) => {
      for (const listener of [...listeners]) {
        listener(message as unknown as Event);
      }
    },
    listenerCount: () => listeners.size,
  };
}

function fakeEndpoint(host: ReturnType<typeof fakeHostWindow>) {
  const posted: unknown[] = [];

  return {
    posted,
    endpoint: {
      postMessage: (message: unknown) => {
        posted.push(message);
      },
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) => host.addEventListener(type, listener as EventListener),
      removeEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) => host.removeEventListener(type, listener as EventListener),
      emit: vi.fn(),
      emitEthProvider: vi.fn(),
    },
  };
}

/**
 * The wire the way `MiniApp.tsx` builds it, driven through the package's own
 * `exposeToEndpoint` — the function `useExposeToEndpoint` calls.
 */
function openTheWire() {
  const host = fakeHostWindow();
  const { endpoint, posted } = fakeEndpoint(host);
  const gated = gateMiniAppWire(
    endpoint,
    () => frameWindow,
    pinnedMiniAppOrigin(FRAME_ORIGIN),
  );

  const sdk = {
    context: {
      user: { fid: 191554, username: 'reader' },
      client: { clientFid: 9152 },
    },
    composeCast: vi.fn().mockResolvedValue({ cast: { hash: '0xcast' } }),
    signIn: vi.fn().mockResolvedValue({ result: { fid: 191554 } }),
    ethProviderRequest: vi.fn().mockResolvedValue(['0xwallet']),
    eip6963RequestProvider: vi.fn(),
    close: vi.fn(),
    ready: vi.fn(),
  };
  const ethProvider = {
    request: vi.fn().mockResolvedValue('0xbalance'),
    on: vi.fn(),
    removeListener: vi.fn(),
  };

  const unexpose = exposeToEndpoint({
    endpoint: gated,
    // The package's member set is wider than this fake host; the wire only ever
    // touches the members below.
    sdk: sdk as never,
    miniAppOrigin: FRAME_ORIGIN,
    ethProvider: ethProvider as never,
  });

  return { host, posted, sdk, ethProvider, unexpose };
}

const GET_CONTEXT = { id: 'get-1', type: 'GET', path: ['context'] };
const APPLY_COMPOSE_CAST = {
  id: 'apply-1',
  type: 'APPLY',
  path: ['composeCast'],
  argumentList: [{ type: 'RAW', value: { text: 'from the app' } }],
};
const APPLY_SIGN_IN = {
  id: 'apply-2',
  type: 'APPLY',
  path: ['signIn'],
  argumentList: [{ type: 'RAW', value: {} }],
};
const APPLY_LEGACY_WALLET = {
  id: 'apply-3',
  type: 'APPLY',
  path: ['ethProviderRequest'],
  argumentList: [{ type: 'RAW', value: { method: 'eth_accounts' } }],
};
const APPLY_WALLET_V2 = {
  id: 'apply-4',
  type: 'APPLY',
  path: ['ethProviderRequestV2'],
  argumentList: [{ type: 'RAW', value: { method: 'eth_accounts' } }],
};
const APPLY_EIP6963 = {
  id: 'apply-5',
  type: 'APPLY',
  path: ['eip6963RequestProvider'],
  argumentList: [],
};

/** Comlink answers a member on a microtask, so a reply is one tick away. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function replyFor(posted: unknown[], id: string) {
  return posted.find((message) => (message as { id?: string }).id === id);
}

// --- the pin itself ----------------------------------------------------------

describe('the origin a window was launched with', () => {
  it('pins the launched URL to its own origin', () => {
    expect(pinnedMiniAppOrigin('https://app.example/frame?x=1')).toBe(
      FRAME_ORIGIN,
    );
  });

  it('refuses a URL with no usable origin to pin to', () => {
    expect(pinnedMiniAppOrigin(undefined)).toBeUndefined();
    expect(pinnedMiniAppOrigin('')).toBeUndefined();
    expect(pinnedMiniAppOrigin('not a url')).toBeUndefined();
    expect(pinnedMiniAppOrigin('data:text/html,hi')).toBeUndefined();
  });

  it('does not read a wildcard or a blank as an origin', () => {
    expect(isPinnedOrigin('*')).toBe(false);
    expect(isPinnedOrigin('')).toBe(false);
    expect(isPinnedOrigin('null')).toBe(false);
    expect(isPinnedOrigin(undefined)).toBe(false);
    expect(isPinnedOrigin(42)).toBe(false);
    expect(isPinnedOrigin(FRAME_ORIGIN)).toBe(true);
  });
});

describe('what counts as the mini app frame', () => {
  it('accepts the frame’s own window at the launched origin', () => {
    expect(
      isFromMiniAppFrame(
        { source: frameWindow, origin: FRAME_ORIGIN },
        frameWindow,
        FRAME_ORIGIN,
      ),
    ).toBe(true);
  });

  it('refuses another window object at the same origin', () => {
    // The finding: comlink checks the origin and nothing else, so this message
    // reached every exposed spec member before this gate.
    expect(
      isFromMiniAppFrame(
        { source: foreignWindow, origin: FRAME_ORIGIN },
        frameWindow,
        FRAME_ORIGIN,
      ),
    ).toBe(false);
  });

  it('refuses the frame at another origin', () => {
    expect(
      isFromMiniAppFrame(
        { source: frameWindow, origin: OTHER_ORIGIN },
        frameWindow,
        FRAME_ORIGIN,
      ),
    ).toBe(false);
  });

  it('refuses an absent or blank origin', () => {
    for (const origin of ['', undefined, null, 'null']) {
      expect(
        isFromMiniAppFrame(
          { source: frameWindow, origin } as WireMessageEvent,
          frameWindow,
          FRAME_ORIGIN,
        ),
      ).toBe(false);
    }
  });

  it('cannot be skipped by pairing a missing frame with a missing source', () => {
    // `event.source === frameWindow` on its own says `null === null` when the
    // frame cannot be resolved, which is the one shape that would open the gate
    // for a window nobody can name.
    expect(
      isFromMiniAppFrame(
        { source: null, origin: FRAME_ORIGIN },
        null,
        FRAME_ORIGIN,
      ),
    ).toBe(false);
    expect(
      isFromMiniAppFrame(
        { source: undefined, origin: FRAME_ORIGIN },
        undefined,
        FRAME_ORIGIN,
      ),
    ).toBe(false);
  });

  it('cannot be skipped by a pin that is a wildcard, blank or opaque', () => {
    for (const pin of ['*', '', undefined, 'null']) {
      expect(
        isFromMiniAppFrame(
          { source: frameWindow, origin: FRAME_ORIGIN },
          frameWindow,
          pin,
        ),
      ).toBe(false);
    }
  });

  it('refuses anything that is not a message event at all', () => {
    expect(isFromMiniAppFrame(undefined, frameWindow, FRAME_ORIGIN)).toBe(
      false,
    );
    expect(isFromMiniAppFrame(null, frameWindow, FRAME_ORIGIN)).toBe(false);
  });
});

// --- the gated endpoint ------------------------------------------------------

describe('the gated endpoint', () => {
  it('lets the frame through and stops every other window', () => {
    const host = fakeHostWindow();
    const { endpoint } = fakeEndpoint(host);
    const gated = gateMiniAppWire(endpoint, () => frameWindow, FRAME_ORIGIN);
    const listener = vi.fn();

    gated.addEventListener('message', listener);
    host.deliver({ source: foreignWindow, origin: FRAME_ORIGIN });
    host.deliver({ source: frameWindow, origin: OTHER_ORIGIN });
    host.deliver({ source: frameWindow, origin: FRAME_ORIGIN });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ source: frameWindow, origin: FRAME_ORIGIN }),
    );
  });

  it('unregisters the very listener it registered, so comlink can release it', () => {
    const host = fakeHostWindow();
    const { endpoint } = fakeEndpoint(host);
    const gated = gateMiniAppWire(endpoint, () => frameWindow, FRAME_ORIGIN);
    const listener = vi.fn();

    gated.addEventListener('message', listener);
    expect(host.listenerCount()).toBe(1);
    gated.removeEventListener('message', listener);
    expect(host.listenerCount()).toBe(0);

    host.deliver({ source: frameWindow, origin: FRAME_ORIGIN });
    expect(listener).not.toHaveBeenCalled();
  });

  it('follows the frame that is on screen, not the one it was built with', () => {
    const host = fakeHostWindow();
    const { endpoint } = fakeEndpoint(host);
    let current = frameWindow;
    const gated = gateMiniAppWire(endpoint, () => current, FRAME_ORIGIN);
    const listener = vi.fn();

    gated.addEventListener('message', listener);
    const reloadedWindow = { name: 'the same frame after a reload' };
    current = reloadedWindow;

    host.deliver({ source: frameWindow, origin: FRAME_ORIGIN });
    host.deliver({ source: reloadedWindow, origin: FRAME_ORIGIN });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves the outbound side exactly as it was', () => {
    // The host answering the app is not this gate's business: `emit` already
    // addresses the frame's own origin, and that is untouched.
    const host = fakeHostWindow();
    const { endpoint } = fakeEndpoint(host);
    const gated = gateMiniAppWire(endpoint, () => frameWindow, FRAME_ORIGIN);

    expect(gated.emit).toBe(endpoint.emit);
    expect(gated.emitEthProvider).toBe(endpoint.emitEthProvider);
    expect(gated.postMessage).toBe(endpoint.postMessage);

    gated.emit({ event: 'miniapp_added' });
    expect(endpoint.emit).toHaveBeenCalledWith({ event: 'miniapp_added' });
  });
});

// --- the wire, through the package's own exposure ---------------------------

describe('the exposed mini app SDK', () => {
  let wired: ReturnType<typeof openTheWire> | undefined;

  afterEach(() => {
    wired?.unexpose();
    wired = undefined;
  });

  it('refuses a foreign window, and answers it nothing at all', async () => {
    wired = openTheWire();

    wired.host.deliver({
      source: foreignWindow,
      origin: FRAME_ORIGIN,
      data: APPLY_COMPOSE_CAST,
    });
    await settle();

    expect(wired.sdk.composeCast).not.toHaveBeenCalled();
    // No refusal either: a reply is itself an oracle.
    expect(wired.posted).toHaveLength(0);
  });

  it('refuses the frame at another origin', async () => {
    wired = openTheWire();

    wired.host.deliver({
      source: frameWindow,
      origin: OTHER_ORIGIN,
      data: APPLY_COMPOSE_CAST,
    });
    await settle();

    expect(wired.sdk.composeCast).not.toHaveBeenCalled();
    expect(wired.posted).toHaveLength(0);
  });

  it('refuses everything when the pin is not a real origin', async () => {
    const host = fakeHostWindow();
    const { endpoint, posted } = fakeEndpoint(host);
    const sdk = { composeCast: vi.fn() };
    const unexpose = exposeToEndpoint({
      endpoint: gateMiniAppWire(endpoint, () => frameWindow, '*'),
      sdk: sdk as never,
      miniAppOrigin: FRAME_ORIGIN,
    });

    host.deliver({
      source: frameWindow,
      origin: FRAME_ORIGIN,
      data: APPLY_COMPOSE_CAST,
    });
    await settle();

    expect(sdk.composeCast).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
    unexpose();
  });

  it('lets the real frame read its context', async () => {
    wired = openTheWire();

    wired.host.deliver({
      source: frameWindow,
      origin: FRAME_ORIGIN,
      data: GET_CONTEXT,
    });
    await settle();

    expect(replyFor(wired.posted, 'get-1')).toMatchObject({
      id: 'get-1',
      type: 'RAW',
      value: { user: { fid: 191554, username: 'reader' } },
    });
  });

  it('lets the real frame open this host’s composer', async () => {
    wired = openTheWire();

    wired.host.deliver({
      source: frameWindow,
      origin: FRAME_ORIGIN,
      data: APPLY_COMPOSE_CAST,
    });
    await settle();

    expect(wired.sdk.composeCast).toHaveBeenCalledWith({
      text: 'from the app',
    });
    expect(replyFor(wired.posted, 'apply-1')).toMatchObject({
      id: 'apply-1',
      type: 'RAW',
      value: { cast: { hash: '0xcast' } },
    });
  });

  it('lets the real frame sign in', async () => {
    wired = openTheWire();

    wired.host.deliver({
      source: frameWindow,
      origin: FRAME_ORIGIN,
      data: APPLY_SIGN_IN,
    });
    await settle();

    expect(wired.sdk.signIn).toHaveBeenCalledTimes(1);
    expect(replyFor(wired.posted, 'apply-2')).toBeDefined();
  });

  it('lets the real frame reach both wallet channels and the announce path', async () => {
    wired = openTheWire();

    wired.host.deliver({
      source: frameWindow,
      origin: FRAME_ORIGIN,
      data: APPLY_LEGACY_WALLET,
    });
    wired.host.deliver({
      source: frameWindow,
      origin: FRAME_ORIGIN,
      data: APPLY_WALLET_V2,
    });
    wired.host.deliver({
      source: frameWindow,
      origin: FRAME_ORIGIN,
      data: APPLY_EIP6963,
    });
    await settle();

    // The wire an older SDK asks through, which this host routes to its own
    // instrumented wallet.
    expect(wired.sdk.ethProviderRequest).toHaveBeenCalledWith({
      method: 'eth_accounts',
    });
    // The wire the package builds out of the provider it is handed.
    expect(wired.ethProvider.request).toHaveBeenCalledWith({
      method: 'eth_accounts',
    });
    expect(wired.sdk.eip6963RequestProvider).toHaveBeenCalledTimes(1);
    expect(replyFor(wired.posted, 'apply-3')).toBeDefined();
    expect(replyFor(wired.posted, 'apply-4')).toBeDefined();
    expect(replyFor(wired.posted, 'apply-5')).toBeDefined();
  });
});
