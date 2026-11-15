// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://fiddy.fun/~/feed"}

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageAttachmentGroup } from '~/components/attachments/ImageAttachmentGroup';

// `farcaster-client-hooks` has no node-resolvable entry point under vitest,
// so mock the whole module surface the group uses. The mocked
// `processMediasForRendering` keeps `medias` order and reports the raw
// `staticRaster` as both thumbnail and original, which is exactly the
// contract the failure mapping relies on.
vi.mock('farcaster-client-hooks', () => ({
  CastClickType: { Image: 'image' },
  useTrackCastClick: () => vi.fn(),
  processMediasForRendering: ({ medias }: { medias: unknown[] }) =>
    medias.map((media) => {
      const { height, mimeType, staticRaster, width } = media as {
        height: number;
        mimeType?: string;
        staticRaster: string;
        width: number;
      };
      return {
        width,
        thumbnail: staticRaster,
        original: staticRaster,
        aspectRatio: width / height,
        mimeType,
      };
    }),
}));

vi.mock('~/hooks/casts/useCastBody', () => ({
  useFullScreenImages: () => ({ open: vi.fn() }),
}));

const media = (url: string) => ({
  version: '2' as const,
  staticRaster: url,
  width: 1200,
  height: 900,
});

afterEach(cleanup);

describe('ImageAttachmentGroup failed pictures', () => {
  it('drops a picture that fails to load and links to it instead', () => {
    render(
      <ImageAttachmentGroup
        medias={[
          media('https://dead.example/gone/missing-image.png'),
          media('https://alive.example/fine/photo.jpg'),
        ]}
        ignoreAspectRatio={false}
      />,
    );

    // Both pictures render before anything fails.
    expect(screen.getAllByRole('img')).toHaveLength(2);

    // The first picture's host 404s.
    fireEvent.error(screen.getAllByRole('img')[0]);

    // The broken frame is gone; only the healthy picture remains.
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img').getAttribute('src')).toContain(
      'alive.example',
    );

    // Its slot is replaced by a link card carrying the host and the path.
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(
      'https://dead.example/gone/missing-image.png',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(link.textContent).toContain('dead.example');
    expect(link.textContent).toContain('missing-image.png');
  });

  it('renders every link card when a whole cast of pictures dies', () => {
    render(
      <ImageAttachmentGroup
        medias={[
          media('https://dead.example/a/one.png'),
          media('https://dead.example/b/two.png'),
        ]}
        ignoreAspectRatio={false}
      />,
    );

    // Fire on the still-mounted image each time: the first failure removes
    // its <img> from the DOM, so a pre-captured element list would dispatch
    // on a detached node React never sees.
    fireEvent.error(screen.getAllByRole('img')[0]);
    fireEvent.error(screen.getAllByRole('img')[0]);

    expect(screen.queryByRole('img')).toBeNull();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe(
      'https://dead.example/a/one.png',
    );
    expect(links[1].getAttribute('href')).toBe(
      'https://dead.example/b/two.png',
    );
  });

  it('keeps the strip untouched while everything loads', () => {
    render(
      <ImageAttachmentGroup
        medias={[media('https://alive.example/fine/photo.jpg')]}
        ignoreAspectRatio={false}
      />,
    );

    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
