// @vitest-environment jsdom
/**
 * The in-app card for a look someone handed over: the three things a person can
 * do with it, and the one thing that has to happen when they take it back.
 *
 * Written because of a MEASURED failure (2026-10-23, card t_d85d8520, live
 * fiddy.fun): the link's own page, wearing the look for the first time, then
 * Undo — the palette stayed on and `fiddy-look` still held it. Undo was handing
 * `putOnLook` the EMPTY look ("put back what was there", and nothing was), which
 * that hook refuses by design, so the press did nothing at all. Nothing worn
 * before means TAKE IT OFF.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedLookCard } from '~/components/looks/SharedLookCard';
import { LOOK_LIBRARY_KEY, LOOK_STORAGE_KEY } from '~/utils/lookTheme';

const SHARED = {
  name: 'Probe',
  bg: '#f4f3ec',
  card: '#ffffff',
  ink: '#1b1c17',
  muted: '#66685d',
  line: '#e0ded2',
  soft: '#eceae0',
  accent: '#3f6cff',
  onAccent: '#ffffff',
  like: '#d6295c',
  recast: '#1a8f6a',
  border: '#e0ded2',
  base: 'light',
  round: 12,
  font: 'inter',
};

/** The look someone was ALREADY wearing, for the "put mine back" case. */
const MINE = { name: 'Mine', bg: '#101418', accent: '#b8ff3f', base: 'dark' };

const sharedState: { state: string; look?: unknown; error?: string } = {
  state: 'ready',
  look: SHARED,
};

vi.mock('~/hooks/looks/useSharedLook', () => ({
  useSharedLook: () => sharedState,
}));

vi.mock('~/components/forms/buttons/DefaultButton', () => ({
  DefaultButton: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('~/components/looks/LookPreview', () => ({
  LookPreview: () => <div data-testid="look-preview" />,
  LookSwatches: () => <div data-testid="look-swatches" />,
}));

const worn = () => window.localStorage.getItem(LOOK_STORAGE_KEY);
const library = () => window.localStorage.getItem(LOOK_LIBRARY_KEY) ?? '';

describe('a look someone shared, in the card', () => {
  beforeEach(() => {
    window.localStorage.clear();
    sharedState.state = 'ready';
    sharedState.look = SHARED;
  });

  it('wears the look on one press, says so, and keeps a copy', () => {
    render(<SharedLookCard id="91fd1eb7f0" />);
    fireEvent.click(screen.getByText('Put this look on'));

    expect(worn()).toContain(SHARED.accent);
    expect(library()).toContain(SHARED.accent);
    expect(screen.getByText('Saved — you can undo this')).toBeTruthy();
  });

  it('takes the look off again when nothing was worn before (the regression)', () => {
    render(<SharedLookCard id="91fd1eb7f0" />);
    fireEvent.click(screen.getByText('Put this look on'));
    fireEvent.click(screen.getByText('Undo'));

    // Nothing was there to put back, so undo must remove the look rather than
    // leave it on: an undo that does nothing is worse than no undo at all.
    expect(worn()).toBeNull();
    expect(screen.getByText('Put this look on')).toBeTruthy();
    expect(screen.queryByText('Saved — you can undo this')).toBeNull();
  });

  it('puts the look that WAS worn back on, not nothing', () => {
    window.localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify(MINE));

    render(<SharedLookCard id="91fd1eb7f0" />);
    fireEvent.click(screen.getByText('Put this look on'));
    expect(worn()).toContain(SHARED.accent);

    fireEvent.click(screen.getByText('Undo'));
    expect(worn()).toContain(MINE.accent);
    expect(worn()).not.toContain(SHARED.accent);
  });

  it('keeps a shared look that is already worn as worn, with no second press', () => {
    window.localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify(SHARED));

    render(<SharedLookCard id="91fd1eb7f0" />);
    expect(screen.getByText('Saved — you can undo this')).toBeTruthy();
    expect(screen.queryByText('Put this look on')).toBeNull();
  });

  it('names the maker when the cast carries a handle, and never invents one', () => {
    const { unmount } = render(
      <SharedLookCard id="91fd1eb7f0" by="terricola" />,
    );
    expect(screen.getByText('@terricola made this look')).toBeTruthy();
    unmount();

    render(<SharedLookCard id="91fd1eb7f0" />);
    expect(screen.getByText('A look someone shared')).toBeTruthy();
  });

  it('says the one sentence for a link whose look is gone, never a blank card', () => {
    sharedState.state = 'missing';
    sharedState.error = "That look link doesn't work any more.";

    render(<SharedLookCard id="0000000000" />);
    expect(
      screen.getByText("That look link doesn't work any more."),
    ).toBeTruthy();
    expect(screen.queryByText('Put this look on')).toBeNull();
  });
});
