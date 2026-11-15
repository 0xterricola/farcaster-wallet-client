// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://fiddy.fun/~/feed"}

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  IMAGE_LINK_CARD_LABEL,
  ImageLinkCard,
} from '~/components/attachments/ImageLinkCard';

afterEach(cleanup);

describe('ImageLinkCard', () => {
  it('links out to the failed image with its host and file name', () => {
    render(
      <ImageLinkCard url="https://media.example/photos/pic-of-a-cat.jpg" />,
    );

    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(
      'https://media.example/photos/pic-of-a-cat.jpg',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(link.textContent).toContain('media.example');
    expect(link.textContent).toContain('pic-of-a-cat.jpg');
  });

  it('strips www. from the hostname', () => {
    render(<ImageLinkCard url="https://www.example.com/a.png" />);

    expect(screen.getByRole('link').textContent).toContain('example.com');
    expect(screen.getByRole('link').textContent).not.toContain('www.');
  });

  it('never links out over non-https or malformed URLs', () => {
    const { rerender } = render(
      <ImageLinkCard url="http://media.example/a.png" />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(
      screen.getByText(IMAGE_LINK_CARD_LABEL, { exact: false }),
    ).toBeTruthy();

    rerender(<ImageLinkCard url="not a url" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(
      screen.getByText(IMAGE_LINK_CARD_LABEL, { exact: false }),
    ).toBeTruthy();
  });
});
