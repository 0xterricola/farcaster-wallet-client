/**
 * The APP side of `scripts/probe-miniapp-wire.html`: the real client SDK
 * (`@farcaster/miniapp-sdk`), in a frame that may or may not be the frame the
 * host pinned.
 *
 * Nothing here is a stub of the wire. `miniAppHost` is comlink's `wrap` over
 * `window.parent`, so a call made here travels the same way a real Mini App's
 * call travels — posted to the host window, answered (or not) by whatever the
 * host has exposed to *this* window.
 *
 * What the page is for: being called from *two* frames at once, only one of
 * which the host opened. `__appCall` is driven by
 * `scripts/verify-miniapp-wire.mjs`, and the state it records is the evidence —
 * `answered` means a reply came back to *this* window, `pending` means nothing
 * came back at all (which is what a refusal looks like from inside a frame: not
 * an error, not a no, just nothing).
 *
 * Served by the dev server (vite transforms it on request) — it is not part of
 * the app's build and nothing imports it.
 */
import { sdk } from '@farcaster/miniapp-sdk';

const log: string[] = [];
const state: Record<string, string> = {};

const record = (line: string) => {
  log.push(line);
  const node = document.getElementById('log');
  if (node) {
    node.textContent = log.join('\n');
  }
};

const setStatus = (text: string) => {
  const node = document.getElementById('status');
  if (node) {
    node.textContent = text;
  }
};

const call = async (name: string) => {
  state[name] = 'pending';
  try {
    if (name === 'context') {
      const context = await sdk.context;
      state[name] = 'answered';
      const detail = `fid=${context?.user?.fid} user=${context?.user?.username}`;
      record(`context ${detail}`);
      setStatus(`context answered: ${detail}`);
      return { ok: true, detail };
    }

    if (name === 'ready') {
      await sdk.actions.ready();
      state[name] = 'answered';
      record('ready');
      setStatus('ready() answered');
      return { ok: true, detail: '' };
    }

    if (name === 'composeCast') {
      const result = await sdk.actions.composeCast({
        text: 'from the frame',
      });
      state[name] = 'answered';
      const detail = JSON.stringify(result);
      record(`composeCast ${detail}`);
      setStatus(`composeCast answered: ${detail}`);
      return { ok: true, detail };
    }

    state[name] = 'unknown';
    return { ok: false, detail: `unknown call ${name}` };
  } catch (error) {
    state[name] = 'threw';
    const detail = String(error);
    record(`${name} threw ${detail}`);
    setStatus(`${name} threw: ${detail}`);
    return { ok: false, detail };
  }
};

/** Every call the host can make this frame, so the runner can fire them. */
Object.assign(window as unknown as Record<string, unknown>, {
  __appCall: call,
  __appLog: () => [...log],
  __appState: () => ({ ...state }),
});

setStatus('app side up, comlink over window.parent');
