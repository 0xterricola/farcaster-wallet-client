// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://fiddy.fun/~/feed"}

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Image } from '~/components/images/Image';

afterEach(cleanup);

describe('external images on Fiddy', () => {
  it('renders the same HTTPS URL the media probe asks for', () => {
    render(
      <Image alt="A shared photo" src="http://media.example/photo/original" />,
    );

    expect(screen.getByRole('img').getAttribute('src')).toBe(
      'https://media.example/photo/original',
    );
  });

  it('keeps the existing fallback when the upgraded image fails', () => {
    render(
      <Image
        alt="A shared photo"
        fallback="https://media.example/photo-fallback.png"
        src="http://media.example/photo.png"
      />,
    );

    fireEvent.error(screen.getByRole('img'));

    expect(screen.getByRole('img').getAttribute('src')).toBe(
      'https://media.example/photo-fallback.png',
    );
  });

  it('reports the failed src when there is no fallback to try', () => {
    const onFail = vi.fn();
    render(
      <Image
        alt="A shared photo"
        src="https://media.example/photo.png"
        onFail={onFail}
      />,
    );

    fireEvent.error(screen.getByRole('img'));

    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith('https://media.example/photo.png');
  });

  it('waits for the fallback to fail too before reporting onFail', () => {
    const onFail = vi.fn();
    render(
      <Image
        alt="A shared photo"
        fallback="https://media.example/photo-fallback.png"
        src="https://media.example/photo.png"
        onFail={onFail}
      />,
    );

    // First failure swaps to the fallback — not terminal yet.
    fireEvent.error(screen.getByRole('img'));
    expect(onFail).not.toHaveBeenCalled();

    // The fallback fails too — now report the original src.
    fireEvent.error(screen.getByRole('img'));
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith('https://media.example/photo.png');
  });
});
