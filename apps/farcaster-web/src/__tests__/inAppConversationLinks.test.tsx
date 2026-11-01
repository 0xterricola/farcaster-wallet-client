// @vitest-environment jsdom

/**
 * The links inside the app to a cast's own pages.
 *
 * The cast permalink used to be the pretty `/<handle>/<0x prefix>` route, and
 * the recasts/quotes/likes tabs of a focused cast used to be
 * `/<handle>/<0x prefix>/{recasts,…}` — all of which the node-backed client
 * answers with "This page isn't on your node": those routes resolve through
 * `/v2/user-thread-casts` and `/v2/user-cast`, and a Snapchain node shards by
 * FID, so no node can answer a hash prefix at all (measured live 2026-10-22,
 * cards t_5068bb26 + t_fb198c05).
 *
 * These tests hold the shape that replaced them: the full hash, on routes a
 * node can address — the same pages `getFiddyCastUrl` copies when somebody
 * shares, so the link inside the app and the link somebody else opens are one
 * family of URLs.
 *
 * One embed is deliberately NOT one of this app's pages: a quote the client
 * only knows as a `warpcast.com/<handle>/<prefix>` LINK (FauxQuoteCast) has
 * nothing but a prefix, so its card opens the URL it came from rather than an
 * in-app route no node can read.
 */

import { cleanup, render } from '@testing-library/react';
import {
  ApiCast,
  ApiOpenGraphMetadata,
  getCastHashPrefix,
} from 'farcaster-client-data';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { FauxQuoteCast } from '~/components/attachments/FauxQuoteCast';
import { LinkToConversation } from '~/components/links/LinkToConversation';
import { LinkToConversationQuotes } from '~/components/links/LinkToConversationQuotes';
import { LinkToConversationReactions } from '~/components/links/LinkToConversationReactions';
import { LinkToConversationRecasts } from '~/components/links/LinkToConversationRecasts';

const HASH = `0x${'a'.repeat(40)}`;

const cast = {
  hash: HASH,
  author: { fid: 3, username: 'dwr' },
} as unknown as ApiCast;

const hrefOf = (element: ApiCast) => {
  const { container } = render(
    <MemoryRouter>
      <LinkToConversation cast={element} title="" />
    </MemoryRouter>,
  );
  const href = container.querySelector('a[href]')?.getAttribute('href') ?? null;
  cleanup();
  return href;
};

/** The anchor a tab-link component paints, inside a router. */
const tabHrefOf = (element: React.ReactElement): string | null => {
  const { container } = render(<MemoryRouter>{element}</MemoryRouter>);
  const href = container.querySelector('a[href]')?.getAttribute('href') ?? null;
  cleanup();
  return href;
};

describe('the link to a cast inside this client', () => {
  it('is the full-hash route, never the prefix route', () => {
    const href = hrefOf(cast);

    expect(href).toBe(`/~/conversations/${HASH}`);
    // The prefix the fork used to paint — and the route a node cannot read.
    expect(href).not.toBe(`/dwr/${getCastHashPrefix({ castHash: HASH })}`);
    expect(href).not.toMatch(/^\/[^/]+\/0x/);
    // The whole hash is in the URL: this is what makes a cold open answerable
    // without an indexer (the reader resolves the author from the hash).
    expect(href).toContain(HASH);
  });

  it('is the same route when the author has no handle at all', () => {
    const anonymous = {
      hash: HASH,
      author: { fid: 3, username: undefined },
    } as unknown as ApiCast;

    expect(hrefOf(anonymous)).toBe(`/~/conversations/${HASH}`);
  });
});

describe('the tabs a focused cast paints', () => {
  it('are the full-hash routes, whatever the author holds', () => {
    expect(tabHrefOf(<LinkToConversationRecasts cast={cast} title="" />)).toBe(
      `/~/conversations/${HASH}/recasts`,
    );
    expect(
      tabHrefOf(<LinkToConversationReactions cast={cast} title="" />),
    ).toBe(`/~/conversations/${HASH}/reactions`);
    expect(tabHrefOf(<LinkToConversationQuotes cast={cast} title="" />)).toBe(
      `/~/conversations/${HASH}/quotes`,
    );
  });

  it('never paint the prefix family a node cannot answer', () => {
    for (const href of [
      tabHrefOf(<LinkToConversationRecasts cast={cast} title="" />),
      tabHrefOf(<LinkToConversationReactions cast={cast} title="" />),
      tabHrefOf(<LinkToConversationQuotes cast={cast} title="" />),
    ]) {
      expect(href).not.toMatch(/^\/[^/]+\/0x/);
      expect(href).toContain(HASH);
    }
  });
});

describe('a quote this client only knows as a link', () => {
  it('opens the URL it came from, not an in-app prefix route', () => {
    const og = {
      url: 'https://warpcast.com/dwr/0xec0c8a22',
      title: 'a cast on Warpcast',
      description: 'the quoted cast, as the embed saw it',
    } as ApiOpenGraphMetadata;

    const { container } = render(<FauxQuoteCast og={og} />);
    const anchor = container.querySelector('a[href]');

    expect(anchor?.getAttribute('href')).toBe(og.url);
    // In a new tab, and never this app's own prefix route.
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(container.innerHTML).not.toMatch(/href="\/dwr\/0x[0-9a-f]+"/);
    cleanup();
  });
});
