/**
 * The chosen server, as the client sees it.
 *
 * The claims worth testing here are the honest ones: a choice is stored per
 * FID and survives, an unusable stored value is not trusted, a chosen address
 * beats the build's own configuration, and an address the browser would refuse
 * is refused up front with a reason a first-time owner can act on.
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
  chooseNode,
  getActiveNodeChoice,
  isNodeChosen,
  isNodeConfigured,
  loadActiveNodeChoice,
  nodeAddressProblem,
  type NodeChoice,
  nodeChoiceBaseUrl,
  PUBLIC_READ_NODES,
  resetNodeChoice,
  resolveBaseUrlForChoice,
  resolveEffectiveNodeBaseUrl,
  subscribeToNodeChoice,
} from '~/snapchain/nodeChoice';
import { NODE_PROXY_PATH } from '~/snapchain/nodeEnv';
import { loadNodeChoice, saveNodeChoice } from '~/snapchain/nodePreferences';

const reset = async () => {
  store.clear();
  await resetNodeChoice(1).catch(() => {});
};

beforeEach(async () => {
  await reset();
});

describe('the public list', () => {
  it('is short and every entry is an absolute https address', () => {
    expect(PUBLIC_READ_NODES.length).toBeGreaterThan(0);
    for (const entry of PUBLIC_READ_NODES) {
      expect(entry.url.startsWith('https://')).toBe(true);
      expect(() => new URL(entry.url)).not.toThrow();
      // A listed node is one that was measured answering /v1/info, so the note
      // has to say something about it rather than being a placeholder.
      expect(entry.note.length).toBeGreaterThan(10);
    }
  });
});

describe('stored choice', () => {
  it('round-trips per FID and defaults to nothing chosen', async () => {
    expect(await loadNodeChoice(7)).toBeNull();
    await saveNodeChoice(7, { kind: 'public', url: 'https://a.example' });
    expect(await loadNodeChoice(7)).toEqual({
      kind: 'public',
      url: 'https://a.example',
    });
    // Another FID is another reader: no choice leaks across accounts.
    expect(await loadNodeChoice(8)).toBeNull();
  });

  it('refuses to trust a stored value that is not a usable address', async () => {
    for (const junk of [
      'https://a.example',
      { kind: 'public' },
      { kind: 'public', url: '' },
      { kind: 'somewhere', url: 'https://a.example' },
      { kind: 'own', url: 'not-an-address' },
      { kind: 'own', url: 'javascript:alert(1)' },
      null,
    ]) {
      store.set('snapchain_node_choice_7', junk);
      expect(await loadNodeChoice(7)).toBeNull();
    }
  });
});

describe('the active choice', () => {
  it('is nothing until one is loaded, then notifies once', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeToNodeChoice(() => seen.push('changed'));

    expect(getActiveNodeChoice()).toBeNull();
    expect(isNodeChosen()).toBe(false);

    await chooseNode(3, { kind: 'own', url: 'https://mine.example/' });
    expect(isNodeChosen()).toBe(true);
    // Trailing slashes are noise: the client appends its own paths.
    expect(getActiveNodeChoice()).toEqual({
      kind: 'own',
      url: 'https://mine.example',
    });
    expect(seen.length).toBe(1);

    // The same choice again is not a change: no needless re-render storm.
    await chooseNode(3, { kind: 'own', url: 'https://mine.example' });
    expect(seen.length).toBe(1);

    unsubscribe();
    await resetNodeChoice(3);
    expect(seen.length).toBe(1);
    expect(getActiveNodeChoice()).toBeNull();
  });

  it('is restored from storage for the FID that signed in', async () => {
    await saveNodeChoice(42, {
      kind: 'public',
      url: 'https://haatz.quilibrium.com',
    });
    expect(await loadActiveNodeChoice(42)).toEqual({
      kind: 'public',
      url: 'https://haatz.quilibrium.com',
    });
    expect(getActiveNodeChoice()?.kind).toBe('public');
  });

  it('is what the client reads from, ahead of the build configuration', async () => {
    const env = { VITE_SNAPCHAIN_HTTP_URL: 'http://34.101.47.167:3381' };

    // Nothing chosen: exactly the old behaviour, byte for byte.
    expect(resolveEffectiveNodeBaseUrl(env, 'https://localhost:5173')).toBe(
      NODE_PROXY_PATH,
    );

    await chooseNode(9, {
      kind: 'public',
      url: 'https://haatz.quilibrium.com/',
    });
    expect(resolveEffectiveNodeBaseUrl(env, 'https://localhost:5173')).toBe(
      'https://haatz.quilibrium.com',
    );

    await resetNodeChoice(9);
    expect(resolveEffectiveNodeBaseUrl(env, 'https://localhost:5173')).toBe(
      NODE_PROXY_PATH,
    );
  });

  it('counts as somewhere to read from, even with no build configuration', async () => {
    expect(isNodeConfigured({})).toBe(false);
    await chooseNode(9, {
      kind: 'public',
      url: 'https://haatz.quilibrium.com',
    });
    expect(isNodeConfigured({})).toBe(true);
    expect(resolveEffectiveNodeBaseUrl({}, 'https://localhost:5173')).toBe(
      'https://haatz.quilibrium.com',
    );
    expect(nodeChoiceBaseUrl(null)).toBeNull();
  });

  it('resolves the same address from the choice a memo depends on', async () => {
    const env = { VITE_SNAPCHAIN_HTTP_URL: 'http://34.101.47.167:3381' };

    // Nothing chosen: the address is the build's own configuration, whether it
    // is read out of the store or resolved from a choice of null.
    expect(resolveBaseUrlForChoice(null)).toBe(resolveEffectiveNodeBaseUrl());

    const chosen: NodeChoice = {
      kind: 'public',
      url: 'https://haatz.quilibrium.com/',
    };
    await chooseNode(9, chosen);
    // What a memo resolves from the choice it was handed is what the active
    // choice resolves to — the dependency is the value, not a nudge to re-run.
    expect(resolveBaseUrlForChoice(chosen)).toBe(
      'https://haatz.quilibrium.com',
    );
    expect(resolveBaseUrlForChoice(chosen)).toBe(
      resolveEffectiveNodeBaseUrl(env, 'https://localhost:5173'),
    );
  });
});

describe('is this address usable', () => {
  it('accepts https addresses and http ones when the page is http too', () => {
    expect(
      nodeAddressProblem('https://mine.example:3381', 'https:'),
    ).toBeNull();
    expect(nodeAddressProblem('  http://127.0.0.1:3381 ', 'http:')).toBeNull();
  });

  it('refuses a plain http address from an https page, and says why', () => {
    const problem = nodeAddressProblem('http://127.0.0.1:3381', 'https:');
    expect(problem).toContain('browsers refuse');
    expect(problem).toContain('https');
  });

  it('refuses what is not an address, and asks for one when it is empty', () => {
    expect(nodeAddressProblem('', 'https:')).toContain('Paste the address');
    expect(nodeAddressProblem('hub.example.com', 'https:')).toContain(
      'does not look like an address',
    );
    expect(nodeAddressProblem('ftp://mine.example', 'https:')).toContain(
      'does not look like an address',
    );
  });
});
