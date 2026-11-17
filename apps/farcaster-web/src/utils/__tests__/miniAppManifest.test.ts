/**
 * The browser's half of the manifest proxy: `fetchMiniAppManifest`.
 *
 * The contract worth holding: the request goes to OUR origin with a
 * VERSIONED path (`/api/manifest?v=1&origin=…`), so it never leaves first
 * party and a server-side purge is never the only way to reach a browser
 * that stored an answer (the one-hour rule, card t_f50c14a1); a host that
 * does not answer, or answers something that is not a manifest, is `null`
 * — never a thrown error, because this is a fallback under a launch that
 * already has everything it needs to open the app.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchMiniAppManifest,
  type MiniAppManifest,
} from '~/utils/miniAppManifest';

type FetchCall = { url: string; init?: RequestInit };

describe('fetchMiniAppManifest', () => {
  const calls: FetchCall[] = [];
  const respond = (status: number, body?: unknown) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    });

  afterEach(() => {
    calls.length = 0;
    vi.restoreAllMocks();
  });

  it('asks our own host, with a versioned key and no credentials', async () => {
    const fetchImpl = respond(200, { name: 'Example' });
    const manifest = await fetchMiniAppManifest('https://example.com', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(manifest).toEqual({ name: 'Example' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      '/api/manifest?v=1&origin=' + encodeURIComponent('https://example.com'),
    );
    expect(calls[0].init).toEqual({ credentials: 'omit' });
  });

  it('caches in memory: one ask per origin while the window holds', async () => {
    const fetchImpl = respond(200, { name: 'Example' });
    let clock = 0;
    const options = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    };
    await fetchMiniAppManifest('https://cached.example.com', options);
    await fetchMiniAppManifest('https://cached.example.com', options);
    expect(calls).toHaveLength(1);
    clock = 10 * 60 * 1000 + 1;
    await fetchMiniAppManifest('https://cached.example.com', options);
    expect(calls).toHaveLength(2);
  });

  it('shares one in-flight ask between concurrent callers', async () => {
    const fetchImpl = respond(200, { name: 'Example' });
    await Promise.all([
      fetchMiniAppManifest('https://racing.example.com', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      fetchMiniAppManifest('https://racing.example.com', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('is null when the host says no, says nothing, or says nonsense', async () => {
    const miss = await fetchMiniAppManifest('https://miss.example.com', {
      fetchImpl: respond(404) as unknown as typeof fetch,
    });
    expect(miss).toBeNull();
    const nonsense = await fetchMiniAppManifest(
      'https://nonsense.example.com',
      {
        fetchImpl: respond(200, {
          launchUrl: 'https://nope',
        }) as unknown as typeof fetch,
      },
    );
    expect(nonsense).toBeNull();
    const thrown = vi.fn(async () => {
      throw new Error('offline');
    });
    const silent = await fetchMiniAppManifest('https://silent.example.com', {
      fetchImpl: thrown as unknown as typeof fetch,
    });
    expect(silent).toBeNull();
  });

  it('refuses an origin that is not https before asking anyone', async () => {
    const fetchImpl = respond(200, { name: 'Example' });
    expect(
      await fetchMiniAppManifest('http://example.com', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('the type the launch surface consumes', () => {
  it('is the launch half only — no webhook, no account association', () => {
    const manifest: MiniAppManifest = {
      name: 'Example',
      iconUrl: 'https://example.com/icon.png',
      homeUrl: 'https://example.com',
      splashImageUrl: 'https://example.com/splash.png',
      splashBackgroundColor: '#fff',
    };
    expect(Object.keys(manifest)).toHaveLength(5);
    expect((manifest as Record<string, unknown>).webhookUrl).toBeUndefined();
  });
});
