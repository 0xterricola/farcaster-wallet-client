// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppsSheet, CHANNEL_ROWS } from '~/components/fiddy/AppsSheet';
import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { loadFiddySetup, resetFiddySetup } from '~/lib/fiddySetup';

beforeEach(() => {
  // Fresh storage per test: a saved permission must not leak between them.
  installFakeStorage();
});

afterEach(() => {
  cleanup();
  resetFiddySetup();
});

const switches = () => screen.getAllByRole('switch');

describe('AppsSheet', () => {
  it('lists every channel Fiddy talks about, one row each', () => {
    render(<AppsSheet />);
    for (const row of CHANNEL_ROWS) {
      expect(screen.getByText(row.name)).toBeTruthy();
    }
    expect(switches()).toHaveLength(CHANNEL_ROWS.length);
  });

  it('gives every row the approval promise, not the capability', () => {
    render(<AppsSheet />);
    for (const row of CHANNEL_ROWS) {
      expect(screen.getAllByText(row.permission).length).toBeGreaterThan(0);
      // Same promise on every row, in whatever words suit the app: it asks,
      // or it does not send without you.
      const line = row.permission.toLowerCase();
      expect(
        line.includes('asks you first') || line.includes('without you'),
      ).toBe(true);
    }
  });

  it('turns Farcaster on by default and lets it be turned off', () => {
    render(<AppsSheet />);
    const farcaster = switches()[0];
    expect(farcaster.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(farcaster);
    expect(loadFiddySetup().channels.farcaster).toBe(false);
    expect(switches()[0].getAttribute('aria-checked')).toBe('false');
  });

  it('cannot switch on a channel that is not wired, and says so', () => {
    render(<AppsSheet />);
    const soonRows = CHANNEL_ROWS.filter((row) => !row.wired);
    expect(soonRows.length).toBeGreaterThan(0);

    for (const row of soonRows) {
      const rowNode = document.querySelector(`[data-fiddy-row="${row.id}"]`);
      expect(rowNode?.getAttribute('data-on')).toBe('false');
      expect(rowNode?.textContent?.toLowerCase()).toContain('soon');
    }

    const whatsapp = document.querySelector(
      '[data-fiddy-row="whatsapp"] [role="switch"]',
    ) as HTMLButtonElement;
    expect(whatsapp.disabled).toBe(true);
    fireEvent.click(whatsapp);
    expect(loadFiddySetup().channels.whatsapp).toBe(false);
  });

  it('uses no infrastructure words anywhere on the sheet', () => {
    render(<AppsSheet />);
    const text = (document.body.textContent ?? '').toLowerCase();
    for (const jargon of [
      'node',
      'snapchain',
      'scope',
      'ttl',
      'signer',
      'gasless',
      'api key',
      'mcp',
      'protocol',
    ]) {
      expect(text).not.toContain(jargon);
    }
  });
});
