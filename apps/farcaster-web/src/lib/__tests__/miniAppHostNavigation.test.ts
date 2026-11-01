// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { openExternalUrl } from '~/lib/miniAppHostOpen';
import { isInsideMiniAppHost } from '~/lib/miniAppSession';

const host = ({
  inHost = true,
  back,
  openUrl,
}: {
  inHost?: boolean;
  back?: () => Promise<void>;
  openUrl?: () => Promise<void>;
} = {}) => ({
  context: Promise.resolve({
    client: { clientFid: 9152, added: false },
    user: { fid: 1 },
  }),
  isInMiniApp: vi.fn(async () => inHost),
  back: { enableWebNavigation: vi.fn(back ?? (async () => undefined)) },
  actions: {
    ready: vi.fn(async () => undefined),
    signIn: vi.fn(),
    openUrl: vi.fn(openUrl ?? (async () => undefined)),
  },
});

describe('the host back button', () => {
  it('walks our web history after the host proves it is there', async () => {
    const sdk = host();
    await expect(isInsideMiniAppHost({ sdk })).resolves.toBe(true);
    expect(sdk.back.enableWebNavigation).toHaveBeenCalledTimes(1);
  });

  it('does not break the client when the host refuses web navigation', async () => {
    const sdk = host({
      back: async () => {
        throw new Error('unsupported');
      },
    });
    await expect(isInsideMiniAppHost({ sdk })).resolves.toBe(true);
    expect(sdk.back.enableWebNavigation).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside a host', async () => {
    const sdk = host({ inHost: false });
    await expect(isInsideMiniAppHost({ sdk })).resolves.toBe(false);
    expect(sdk.back.enableWebNavigation).not.toHaveBeenCalled();
  });
});

describe('opening a link through the host', () => {
  it('uses the host for an allowed link', async () => {
    const sdk = host();
    const openInBrowser = vi.fn();
    await openExternalUrl({
      to: 'https://example.com/story',
      openInNewTab: true,
      loadSdk: async () => sdk,
      openInBrowser,
    });
    expect(sdk.actions.openUrl).toHaveBeenCalledWith(
      'https://example.com/story',
    );
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('keeps the ordinary browser path outside a host', async () => {
    const sdk = host({ inHost: false });
    const openInBrowser = vi.fn();
    await openExternalUrl({
      to: 'https://example.com/story',
      openInNewTab: false,
      loadSdk: async () => sdk,
      openInBrowser,
    });
    expect(sdk.actions.openUrl).not.toHaveBeenCalled();
    expect(openInBrowser).toHaveBeenCalledWith(
      'https://example.com/story',
      false,
    );
  });

  it('refuses a disallowed protocol before loading the SDK', async () => {
    const loadSdk = vi.fn();
    const openInBrowser = vi.fn();
    await openExternalUrl({
      to: 'javascript:alert(1)',
      openInNewTab: true,
      loadSdk,
      openInBrowser,
    });
    expect(loadSdk).not.toHaveBeenCalled();
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('falls back to the browser when the host cannot open the link', async () => {
    const sdk = host({
      openUrl: async () => {
        throw new Error('unsupported');
      },
    });
    const openInBrowser = vi.fn();
    await openExternalUrl({
      to: 'https://example.com/story',
      openInNewTab: true,
      loadSdk: async () => sdk,
      openInBrowser,
    });
    expect(openInBrowser).toHaveBeenCalledWith(
      'https://example.com/story',
      true,
    );
  });
});
