/**
 * The host's own mini app wire, pinned to the one frame it serves.
 *
 * `@farcaster/miniapp-host` opens this wire with
 * `Comlink.expose(sdk, endpoint, [miniAppOrigin])`, and the listener behind it
 * lives on *this* window: `Comlink.windowEndpoint(iframe.contentWindow)` binds
 * `addEventListener` to the host's own global, so every frame in this page can
 * post at it. Comlink's own check reads the sender's origin and nothing else —
 * measured on 0.3.0, `dist/comlink/comlink.js` reads `ev.origin` and `ev.data`
 * and never `ev.source` — so with this client's `miniAppOrigin: '*'` any window
 * that can post into the host (a sibling frame, an iframe inside the app, a
 * popup that kept a handle) could invoke the spec members. It could not read
 * the replies, which are posted to the mini app's own window, but it could make
 * this shell open a composer, a wallet sheet or a sign-in prompt.
 *
 * The two facts the browser hands us and comlink cannot see for itself are the
 * frame's own window object and the origin the window was launched with, so
 * both are required here. The origin half is not a new constraint on the wire:
 * `createIframeEndpoint`'s `emit` already addresses this app by exactly this
 * origin, so a frame at another origin is a frame this host is not talking to
 * anyway. (See `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §5.2 and §7 row 5, the
 * finding this closes; the app's ask channel is pinned the same way.)
 *
 * Fail-closed, everywhere: a frame window that cannot be resolved, an origin
 * that is absent, opaque (`'null'`) or wildcarded (`'*'`), and a launched URL
 * with no usable origin all refuse. A gate that opened when its pin was blank
 * would be the same hole with more code.
 */

/** What a listener sees on the host window, as much of it as this gate reads. */
export type WireMessageEvent = {
  source?: unknown;
  origin?: unknown;
  data?: unknown;
};

type WireListener = EventListenerOrEventListenerObject;

type WireEndpointLike = {
  addEventListener(type: string, listener: WireListener, options?: {}): void;
  removeEventListener(type: string, listener: WireListener, options?: {}): void;
};

/**
 * An origin is usable as a pin only when it is a real, absolute, non-opaque
 * one. `''`, `'null'` (a document with an opaque origin) and `'*'` (any origin
 * — the value this card removes) are refused rather than read as "any", which
 * is the whole difference between a pin and a comment.
 */
export function isPinnedOrigin(origin: unknown): origin is string {
  return (
    typeof origin === 'string' &&
    origin !== '' &&
    origin !== '*' &&
    origin !== 'null'
  );
}

/**
 * The origin a launched URL pins to, or `undefined` when there is nothing
 * pinnable to use: no URL, or a URL whose origin is opaque.
 */
export function pinnedMiniAppOrigin(
  url: string | undefined,
): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const { origin } = new URL(url);
    return isPinnedOrigin(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this message came from the mini app frame we are serving.
 *
 * Both halves are required and neither has a permissive blank: an unresolvable
 * frame window (`undefined`, or `null` for a browsing context that is gone)
 * never compares equal to a message's own absent `source`, which is the way a
 * naive `event.source === frameWindow` check lets a window nobody can name
 * through.
 */
export function isFromMiniAppFrame(
  event: WireMessageEvent | null | undefined,
  frameWindow: unknown,
  launchedOrigin: string | undefined,
): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }
  if (!isPinnedOrigin(launchedOrigin)) {
    return false;
  }
  if (!frameWindow || event.source !== frameWindow) {
    return false;
  }
  return event.origin === launchedOrigin;
}

/**
 * The same endpoint, with its `message` registrations gated on
 * `isFromMiniAppFrame`. Everything else — `postMessage`, `emit`,
 * `emitEthProvider` and their own `targetOrigin` — is passed through untouched:
 * this pins what the frame may say to the host, not how the host answers it.
 *
 * The frame's window is read through `getFrameWindow` on every message rather
 * than captured here, because the element a reload hands back is not the one
 * this gate was built with.
 */
export function gateMiniAppWire<T extends WireEndpointLike>(
  endpoint: T,
  getFrameWindow: () => unknown,
  launchedOrigin: string | undefined,
): T {
  // `Comlink.expose` unregisters the listener it registered, so the wrapper has
  // to be one function identity per listener: adding and removing both go
  // through this map.
  const gatedListeners = new WeakMap<WireListener, WireListener>();

  const gatedListener = (listener: WireListener): WireListener => {
    const alreadyGated = gatedListeners.get(listener);
    if (alreadyGated) {
      return alreadyGated;
    }
    const handleEvent = (event: Event) => {
      if (
        !isFromMiniAppFrame(
          event as WireMessageEvent,
          getFrameWindow(),
          launchedOrigin,
        )
      ) {
        return;
      }
      if (typeof listener === 'function') {
        listener(event);
        return;
      }
      listener.handleEvent(event);
    };
    gatedListeners.set(listener, handleEvent);
    return handleEvent;
  };

  return {
    ...endpoint,
    addEventListener: (type, listener, options) =>
      endpoint.addEventListener(
        type,
        type === 'message' ? gatedListener(listener) : listener,
        options,
      ),
    removeEventListener: (type, listener, options) =>
      endpoint.removeEventListener(
        type,
        type === 'message' ? gatedListener(listener) : listener,
        options,
      ),
  };
}
