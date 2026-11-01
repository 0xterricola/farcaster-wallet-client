// @vitest-environment jsdom
/**
 * The number in the chrome.
 *
 * Two claims, and they are the two that matter for a money number sitting in
 * somebody's top bar: it appears only when there is a real balance behind it
 * (never a placeholder, never a $0.00 for "this browser has no balance here"),
 * and it goes to the surface that explains it.
 */

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { FiddyBalanceChip } from '~/components/fiddy/FiddyFunding';

const renderChip = (usdc: string | null, compact = false) =>
  render(
    <MemoryRouter>
      <FiddyBalanceChip usdc={usdc} compact={compact} />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
});

describe('the balance chip', () => {
  it('renders nothing at all when there is no balance to show', () => {
    const { container } = renderChip(null);
    expect(container.textContent).toBe('');
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('shows the balance as a dollar amount, and where it goes', () => {
    renderChip('3.50');
    const chip = screen
      .getByText('$3.50')
      .closest('[data-fiddy="balance-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('data-fiddy-balance')).toBe('3.50');
    // The chip is a link to the surface that explains the number.
    expect(chip?.closest('a')?.getAttribute('href')).toBe('/~/wallet');
  });

  it('keeps the number and drops the word on a phone', () => {
    const { container } = renderChip('3.50', true);
    expect(container.textContent).toBe('$3.50');
    expect(container.querySelector('.fiddy-chip-compact')).toBeTruthy();
  });
});
