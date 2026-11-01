// @vitest-environment jsdom
/**
 * The mark's promises, held to account in a browser-less test: the still paints
 * first, reduced motion never fetches anything, a model that cannot mount
 * leaves the still in place, and the surface it draws into is disposed rather
 * than leaked.
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scene = vi.hoisted(() => ({
  mount: vi.fn(),
}));

vi.mock('~/components/fiddy/fiddyModelScene', () => ({
  mountFiddyMark: scene.mount,
}));

import {
  FIDDY_MARK_POSTER,
  markMotionAllowed,
} from '~/components/fiddy/fiddyMark';
import { FiddyMark3D } from '~/components/fiddy/FiddyMark3D';

const setReducedMotion = (matches: boolean) => {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion') ? matches : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
};

const mark = () => document.querySelector('[data-fiddy-mark]');
const still = () => document.querySelector('.fiddy-brand-mark3d-still');

beforeEach(() => {
  scene.mount.mockReset();
  setReducedMotion(false);
});

afterEach(cleanup);

describe('markMotionAllowed', () => {
  it('is the one rule: asked for stillness, never animate', () => {
    expect(markMotionAllowed(true)).toBe(false);
    expect(markMotionAllowed(false)).toBe(true);
    // A browser that cannot answer is not a browser that asked for stillness.
    expect(markMotionAllowed(null)).toBe(true);
  });
});

describe('FiddyMark3D', () => {
  it('paints the mark as a still first, decorative and never empty', () => {
    scene.mount.mockResolvedValue(undefined);
    render(<FiddyMark3D />);

    expect(mark()?.getAttribute('data-fiddy-mark')).toBe('still');
    const image = still() as HTMLImageElement | null;
    expect(image?.getAttribute('src')).toBe(FIDDY_MARK_POSTER);
    // The wordmark beside it already names the brand: the mark is decoration.
    expect(image?.getAttribute('alt')).toBe('');
    expect(mark()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('hands the slot to the model once it is drawn, and disposes on unmount', async () => {
    const dispose = vi.fn();
    scene.mount.mockResolvedValue({ dispose });

    const { unmount } = render(<FiddyMark3D />);

    await waitFor(() =>
      expect(mark()?.getAttribute('data-fiddy-mark')).toBe('moving'),
    );
    expect(scene.mount).toHaveBeenCalledTimes(1);
    // It is handed the slot element and a signal that can stop the fetch.
    const [host, signal] = scene.mount.mock.calls[0];
    expect(host).toBeInstanceOf(Element);
    expect(signal).toBeInstanceOf(AbortSignal);

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('never fetches the model under prefers-reduced-motion', async () => {
    setReducedMotion(true);
    render(<FiddyMark3D />);

    // Longer than the after-first-paint delay plus a frame: if the component
    // were going to ask for the model, it would have by now.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(scene.mount).not.toHaveBeenCalled();
    expect(mark()?.getAttribute('data-fiddy-mark')).toBe('still');
    expect(still()).toBeTruthy();
  });

  it('leaves the still in place when the model cannot be drawn', async () => {
    scene.mount.mockRejectedValue(new Error('no webgl'));

    render(<FiddyMark3D />);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(mark()?.getAttribute('data-fiddy-mark')).toBe('still');
    expect(still()).toBeTruthy();
  });
});
