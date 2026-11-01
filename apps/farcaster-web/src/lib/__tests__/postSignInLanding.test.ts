/**
 * Where a completed sign-in puts the browser — the half of the post-sign-in
 * fix that is a decision rather than a render, so it is pinned here.
 *
 * The bug it guards: the reload that follows a successful sign-in used to run
 * in place, and the setup flow's last screen is where "Go social" lives, so the
 * person who had just signed in was shown "Fiddy is ready." again — before and
 * after a reload, never the client.
 */

import { describe, expect, it } from 'vitest';

import { defaultRoute, routes } from '~/constants/routes';
import { postSignInLocation } from '~/lib/postSignInLanding';

const setupRoutes = [
  routes.fiddyWelcome,
  routes.fiddyWelcomeName,
  routes.fiddyWelcomeBrain,
  routes.fiddyWelcomeApps,
  routes.fiddyWelcomeReady,
];

describe('postSignInLocation', () => {
  it('sends a sign-in started from any setup screen to the client', () => {
    for (const route of setupRoutes) {
      expect(
        postSignInLocation({
          pathname: route.path,
          href: `https://localhost:5173${route.path}`,
        }),
      ).toBe(defaultRoute.path);
    }
  });

  it('leaves every other place alone, deep links included', () => {
    for (const [pathname] of [
      ['/'],
      ['/~/channel/fiddy'],
      ['/~/conversation/0x1'],
    ]) {
      const href = `https://localhost:5173${pathname}`;
      expect(postSignInLocation({ pathname, href })).toBe(href);
    }
  });
});
