// @vitest-environment jsdom

/**
 * The pictures a direct message carried, drawn in the message bubble.
 *
 * This is the rendered-DOM half of the change: a message that carried a link to
 * a picture on ANOTHER host (no file extension, the classifier asked and
 * answered) plus one on Fiddy's own media host paints an `<img>` for each, in
 * the order the message wrote them. And when a picture will not load, the frame
 * is replaced by the plain link and a sentence — never left broken.
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DirectCastMessageImages } from '~/components/directCasts/embeds/DirectCastMessageImages';
import { createEmbedKindResolver } from '~/snapchain/nodeApi/embedKinds';
import { splitDirectCastMessageImageTokens } from '~/utils/directCastImageTokens';

/** Fiddy's own media host. */
const FIDDY_PHOTO =
  'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/a62d038c-974d-4c48-a658-c764f4205c00/original';

/** Anywhere else, with no file extension to read a type off. */
const EXTERNAL_PHOTO = 'https://photo-host.test/gallery/kitten/1';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pictureSources = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('img')).map(
    (image) => image.getAttribute('src') ?? '',
  );

/** The message as a reader wrote it, put through the real pipeline. */
const renderMessage = async (message: string) => {
  const resolver = createEmbedKindResolver({
    fetchImpl: (async () =>
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })) as unknown as typeof fetch,
    storage: null,
    imageProbe: async () => undefined,
  });

  await resolver.classify([EXTERNAL_PHOTO]);

  const parts = splitDirectCastMessageImageTokens({
    message,
    kindOf: (url) => resolver.kindOf(url),
  });

  const rendered = render(
    <DirectCastMessageImages imageUrls={parts.imageUrls} />,
  );

  return { ...rendered, parts };
};

describe('a message that carried picture links', () => {
  it('paints an image for each of them, in the order it wrote them', async () => {
    const { container, parts } = await renderMessage(
      `look at this ${EXTERNAL_PHOTO} and this ${FIDDY_PHOTO} — nice`,
    );

    expect(parts.imageUrls).toEqual([EXTERNAL_PHOTO, FIDDY_PHOTO]);
    expect(parts.text).toBe('look at this and this — nice');
    expect(pictureSources(container)).toEqual([EXTERNAL_PHOTO, FIDDY_PHOTO]);
  });

  it('says so plainly when a picture will not load, instead of a broken frame', async () => {
    const { container } = await renderMessage(
      `look at this ${EXTERNAL_PHOTO} and this ${FIDDY_PHOTO}`,
    );

    const [first] = container.querySelectorAll('img');

    fireEvent.error(first as HTMLImageElement);

    // The picture that failed is gone, replaced by the link it was.
    expect(pictureSources(container)).toEqual([FIDDY_PHOTO]);
    expect(container.textContent).toContain('This picture could not be shown');

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe(EXTERNAL_PHOTO);
    expect(link?.textContent).toBe(EXTERNAL_PHOTO);
  });

  it('draws nothing at all when the message carried no pictures', () => {
    const { container } = render(<DirectCastMessageImages imageUrls={[]} />);

    expect(pictureSources(container)).toEqual([]);
    expect(container.textContent).toBe('');
  });
});
