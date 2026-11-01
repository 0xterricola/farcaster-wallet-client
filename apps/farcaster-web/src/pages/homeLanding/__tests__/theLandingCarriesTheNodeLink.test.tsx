// @vitest-environment jsdom

/**
 * The landing carries the way out of the hosted client: 'run your own node →',
 * pointing at fiddy.fun's own microsite.
 *
 * Why this is a test and not just a line in a page: the link was added, built,
 * released and served — and still could not be seen, because the route that
 * renders the landing died before painting it. The route is fixed in
 * `signedOutSeesTheLanding.test.tsx` (it pins the order); this file pins the
 * thing a visitor is supposed to be able to click, on the real component, with
 * the real ExternalLink rendering the real anchor.
 */

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';

vi.mock('~/components/page/Page', () => ({
  Page: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

// The typed route link needs a router; the footer's destinations are not what
// this file measures.
vi.mock('~/components/links/Link', () => ({
  Link: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('a', null, children),
}));

const { HomeLandingPage } = await import('~/pages/homeLanding/HomeLandingPage');

describe('the landing', () => {
  it('renders the node link a signed-out visitor can actually click', () => {
    installFakeStorage();

    render(React.createElement(HomeLandingPage));

    const link = screen.getByText('run your own node →').closest('a');

    expect(link?.getAttribute('href')).toBe('https://fiddy.fun/client/');
    expect(link?.getAttribute('title')).toBe('Run your own Farcaster node');
  });

  it('keeps the link out of the way of the sign-up buttons', () => {
    installFakeStorage();

    render(React.createElement(HomeLandingPage));

    // The link is the quiet line under the login buttons by design, so it is
    // NOT the loudest thing on the page: the loud sign-up control is a
    // container, and the link is an anchor inside the same column.
    const nodeLink = screen.getByText('run your own node →').closest('a');
    const signUp = screen.getByText('Sign up').closest('a');

    expect(nodeLink).toBeTruthy();
    expect(signUp).toBeTruthy();
    expect(nodeLink).not.toBe(signUp);
  });
});
