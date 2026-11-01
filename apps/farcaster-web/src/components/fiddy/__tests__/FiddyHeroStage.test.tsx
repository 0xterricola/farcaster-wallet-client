// @vitest-environment jsdom
/**
 * The hero's promises, held to account in a browser-less test: the still paints
 * first, reduced motion never fetches anything, a model that cannot mount leaves
 * the still in place, the front door's stage is a real button that greets Fiddy
 * while the small one beside a form is decoration, and the surface it draws into
 * is disposed rather than leaked.
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scene = vi.hoisted(() => ({
  mount: vi.fn(),
}));

vi.mock('~/components/fiddy/fiddyModelScene', () => ({
  mountFiddyModel: scene.mount,
}));

import {
  FIDDY_HERO_CLIP,
  FIDDY_HERO_HEAD,
  FIDDY_HERO_LOOK,
  FIDDY_HERO_MODEL,
  FIDDY_HERO_PADDING,
  FIDDY_HERO_POSTER,
  FIDDY_HERO_REST_AFTER_MS,
  FIDDY_HERO_VIEW,
  heroMotionAllowed,
} from '~/components/fiddy/fiddyHero';
import { FiddyHeroStage } from '~/components/fiddy/FiddyHeroStage';

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

const stage = () => document.querySelector('[data-fiddy-hero]');
const still = () => document.querySelector('.fiddy-hero-stage-still');
const dispose = vi.fn();
const react = vi.fn();

beforeEach(() => {
  scene.mount.mockReset();
  dispose.mockReset();
  react.mockReset();
  scene.mount.mockResolvedValue({ dispose, react });
  setReducedMotion(false);
});

afterEach(cleanup);

describe('heroMotionAllowed', () => {
  it('is the same one rule the chrome mark obeys', () => {
    expect(heroMotionAllowed(true)).toBe(false);
    expect(heroMotionAllowed(false)).toBe(true);
    expect(heroMotionAllowed(null)).toBe(true);
  });
});

describe('FiddyHeroStage', () => {
  it('paints the still before anything is fetched', () => {
    render(<FiddyHeroStage />);
    const image = still() as HTMLImageElement;
    expect(image).toBeTruthy();
    expect(image.getAttribute('src')).toBe(FIDDY_HERO_POSTER);
    expect(stage()?.getAttribute('data-fiddy-hero')).toBe('still');
  });

  it('never asks for the model under reduced motion, and still shows Fiddy', async () => {
    setReducedMotion(true);
    render(<FiddyHeroStage />);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(scene.mount).not.toHaveBeenCalled();
    expect(still()).toBeTruthy();
    expect(stage()?.getAttribute('data-fiddy-hero')).toBe('still');

    // Stillness removes the hop, not the reply. A tap gets a motion-free hello.
    fireEvent.click(stage() as HTMLButtonElement);
    expect(react).not.toHaveBeenCalled();
    expect(
      stage()?.querySelector('[data-fiddy="hero-reaction"]')?.textContent,
    ).toBe('Hiya, you!');
  });

  it('mounts the baby, with the clip, the head and the rest the hero needs', async () => {
    render(<FiddyHeroStage variant="hero" />);
    await waitFor(() => expect(scene.mount).toHaveBeenCalled());
    expect(scene.mount.mock.calls[0][2]).toMatchObject({
      model: FIDDY_HERO_MODEL,
      clip: FIDDY_HERO_CLIP,
      look: { node: FIDDY_HERO_HEAD, ...FIDDY_HERO_LOOK },
      restAfterMs: FIDDY_HERO_REST_AFTER_MS,
      view: FIDDY_HERO_VIEW,
      padding: FIDDY_HERO_PADDING,
    });
  });

  it('is a button on the front door, so a press greets Fiddy from a keyboard too', async () => {
    render(<FiddyHeroStage variant="hero" />);
    await waitFor(() =>
      expect(stage()?.getAttribute('data-fiddy-hero')).toBe('moving'),
    );
    const button = stage() as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    // A button carries no text, so it has to be named.
    expect(button.getAttribute('aria-label')).toBe('Play with Fiddy');

    // Enter and Space are the platform's own doing for a <button>; what this
    // asserts is that the press reaches the scene at all.
    fireEvent.click(button);
    expect(react).toHaveBeenCalledTimes(1);
    expect(
      button.querySelector('[data-fiddy="hero-reaction"]')?.textContent,
    ).toBe('Hiya, you!');

    fireEvent.click(button);
    expect(react).toHaveBeenCalledTimes(2);
    expect(
      button.querySelector('[data-fiddy="hero-reaction"]')?.textContent,
    ).toBe('Boop received.');
  });

  it('is decoration beside the name field: no button, no name, no pointer', async () => {
    render(<FiddyHeroStage variant="form" />);
    await waitFor(() => expect(scene.mount).toHaveBeenCalled());
    const box = stage() as HTMLElement;
    expect(box.tagName).toBe('SPAN');
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.querySelector('button')).toBeNull();
  });

  it('stays on the still when the model cannot mount, and says nothing', async () => {
    scene.mount.mockRejectedValue(new Error('no WebGL'));
    render(<FiddyHeroStage />);
    await waitFor(() => expect(scene.mount).toHaveBeenCalled());
    await waitFor(() =>
      expect(stage()?.getAttribute('data-fiddy-hero')).toBe('still'),
    );
    expect(still()).toBeTruthy();
  });

  it('reports the model on screen once it is up, and disposes it on unmount', async () => {
    const view = render(<FiddyHeroStage />);
    await waitFor(() =>
      expect(stage()?.getAttribute('data-fiddy-hero')).toBe('moving'),
    );
    view.unmount();
    expect(dispose).toHaveBeenCalled();
  });
});
