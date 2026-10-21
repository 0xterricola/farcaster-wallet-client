// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAIN_CARDS, BrainSheet } from '~/components/fiddy/BrainSheet';
import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { loadFiddySetup, resetFiddySetup } from '~/lib/fiddySetup';

// The sheet's only network path is pairing with a service you run. Mocked at
// the module edge so this test is about the words and the choices, not HTTP.
vi.mock('~/hooks/agent/useAgentSession', () => ({
  useAgentSession: () => ({
    status: 'unpaired',
    session: null,
    pair: vi.fn(),
    forget: vi.fn(),
  }),
}));

vi.mock('~/lib/agentService', () => ({
  AgentServiceError: class AgentServiceError extends Error {
    code = 'X';
    status = 500;
  },
  isValidServiceToken: (raw: string) => raw.trim().length >= 8,
  listAgents: vi.fn(async () => []),
  normaliseServiceUrl: (raw: string) =>
    raw.startsWith('https://') && !raw.includes('/', 8) ? raw : null,
}));

beforeEach(() => {
  installFakeStorage();
});

afterEach(() => {
  cleanup();
  resetFiddySetup();
});

describe('BrainSheet', () => {
  it('offers every brain, one card each', () => {
    render(<BrainSheet />);
    for (const card of BRAIN_CARDS) {
      expect(screen.getByText(card.title)).toBeTruthy();
    }
    expect(document.querySelectorAll('[data-fiddy-brain]')).toHaveLength(
      BRAIN_CARDS.length,
    );
  });

  it('tags Claude and Gemini honestly and does not imply they work today', () => {
    render(<BrainSheet />);
    const claude = document.querySelector(
      '[data-fiddy-brain="claude"]',
    ) as HTMLElement;
    expect(claude.textContent?.toLowerCase()).toContain('soon');
    const gemini = document.querySelector(
      '[data-fiddy-brain="gemini"]',
    ) as HTMLElement;
    expect(gemini.textContent?.toLowerCase()).toContain('soon');
  });

  it('selecting a brain stores it', () => {
    render(<BrainSheet />);
    fireEvent.click(
      document.querySelector('[data-fiddy-brain="gemini"]') as HTMLElement,
    );
    expect(loadFiddySetup().brain).toBe('gemini');
  });

  it('shows the one-address-one-key form only for a service you bring', () => {
    render(<BrainSheet />);
    expect(document.querySelector('[data-fiddy="brain-connect"]')).toBeNull();

    fireEvent.click(
      document.querySelector('[data-fiddy-brain="other"]') as HTMLElement,
    );
    expect(document.querySelector('[data-fiddy="brain-connect"]')).toBeTruthy();
    expect(
      screen.getByPlaceholderText('https://agents.example.com'),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText('the key it gave you')).toBeTruthy();
  });

  it('keeps the builders row closed until it is asked for', () => {
    render(<BrainSheet />);
    expect(document.querySelector('[data-fiddy="brain-advanced"]')).toBeNull();

    fireEvent.click(screen.getByText(/Advanced — for builders/i));
    const advanced = document.querySelector('[data-fiddy="brain-advanced"]');
    expect(advanced).toBeTruthy();
    expect(advanced?.textContent?.toLowerCase()).toContain('not wired yet');
  });

  it('offers Surp as pay-as-you-go, and opens its panel when it is chosen', async () => {
    // The panel reads surp.ivc.lol directly; a browser that cannot (which is
    // every browser today — see lib/surp/transport.ts) gets a refusal here,
    // exactly as the real one does. Stubbed so the test never leaves the process.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    render(<BrainSheet />);
    const surp = document.querySelector(
      '[data-fiddy-brain="surp"]',
    ) as HTMLElement;
    expect(surp.textContent?.toLowerCase()).toContain('pay as you go');

    fireEvent.click(surp);
    expect(loadFiddySetup().brain).toBe('surp');
    const panel = document.querySelector('[data-fiddy="surp"]');
    expect(panel).toBeTruthy();
    // It says why it cannot show a price, and never invents one.
    expect(
      await screen.findByText(/blocked this page from reading Surp directly/i),
    ).toBeTruthy();
    expect(document.querySelector('[data-fiddy-surp="savings"]')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('uses no infrastructure words anywhere on the sheet', () => {
    render(<BrainSheet />);
    fireEvent.click(
      document.querySelector('[data-fiddy-brain="other"]') as HTMLElement,
    );
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
