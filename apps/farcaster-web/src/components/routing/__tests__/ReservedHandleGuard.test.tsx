// @vitest-environment jsdom

/**
 * The regression this file pins down.
 *
 * On fiddy.fun, signed out, `/feed` and `/explore` matched the handle-addressed
 * vanity route and rendered the profile of whichever Farcaster user was called
 * @feed / @explore — so a visitor typing a plausible URL met a stranger's
 * months-stale profile.
 *
 * The harness runs the *real* guard over the *real* paths from the route table
 * and the *real* `/u` namespace, and stubs only the page markup: if the guard
 * ever stops dropping reserved names, these tests render the profile again.
 */

import { render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { ReservedHandleGuard } from '~/components/routing/ReservedHandleGuard';
import { reservedHandleRoutes } from '~/constants/reservedHandleRoutes';
import { routes } from '~/constants/routes';

const FRONT_DOOR = 'the front door';
const PROFILE = 'profile of a handle';
const PROFILE_TAB = 'a profile tab of a handle';
const CAST = 'a cast';
const NAMESPACED = 'the namespaced address of an account';
const APP_PATH = 'the app page that owns this path';

const Harness: React.FC<{ ownsFeedPath?: boolean }> = ({ ownsFeedPath }) => (
  <Routes>
    <Route path="/" element={<div>{FRONT_DOOR}</div>} />
    {/* The browse surface this card's sibling builds at `/feed`: a static
        segment wins the match over `/:username`, so the guard never sees it. */}
    {ownsFeedPath && <Route path="/feed" element={<div>{APP_PATH}</div>} />}
    {/* The `/u/<handle>` namespace, exactly as the router registers it. */}
    {reservedHandleRoutes.map((route) => (
      <Route
        key={route.path}
        path={route.path}
        element={<div>{NAMESPACED}</div>}
      />
    ))}
    <Route element={<ReservedHandleGuard />}>
      <Route
        path={routes.profileCastsWithUsername.path}
        element={<div>{PROFILE}</div>}
      />
      <Route
        path={routes.profileCastsAndRepliesWithUsername.path}
        element={<div>{PROFILE_TAB}</div>}
      />
      <Route
        path={routes.conversationWithUsername.path}
        element={<div>{CAST}</div>}
      />
    </Route>
  </Routes>
);

const renderAt = (path: string, ownsFeedPath = false) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Harness ownsFeedPath={ownsFeedPath} />
    </MemoryRouter>,
  );

/** Everything the router rendered, as one string: what the visitor sees. */
const rendered = (container: HTMLElement) => container.textContent ?? '';

describe('a reserved name is never read as a handle', () => {
  it.each(['/feed', '/explore', '/notifications', '/settings', '/search'])(
    'does not render a profile at %s',
    (path) => {
      const { container } = renderAt(path);

      expect(rendered(container)).not.toContain(PROFILE);
      expect(rendered(container)).toContain(FRONT_DOOR);
    },
  );

  it('reads case and percent-encoding variants of a reserved name the same way', () => {
    for (const path of ['/Feed', '/FEED', '/fee%64']) {
      const { container, unmount } = renderAt(path);

      expect(rendered(container)).not.toContain(PROFILE);
      expect(rendered(container)).toContain(FRONT_DOOR);

      unmount();
    }
  });

  it('still renders the profile for a handle that is not a reserved name', () => {
    const { container } = renderAt('/alice');

    expect(rendered(container)).toContain(PROFILE);
    expect(rendered(container)).not.toContain(FRONT_DOOR);
  });

  it('serves a reserved account, its tabs and its casts under /u', () => {
    const tab = renderAt('/feed/likes');

    expect(rendered(tab.container)).toContain(NAMESPACED);
    expect(rendered(tab.container)).not.toContain(PROFILE_TAB);

    const cast = renderAt('/feed/0xdeadbeef');

    expect(rendered(cast.container)).toContain(NAMESPACED);
    expect(rendered(cast.container)).not.toContain(CAST);
  });

  it('lets the app own a reserved path once it has a route for it', () => {
    const { container } = renderAt('/feed', true);

    expect(rendered(container)).toContain(APP_PATH);
    expect(rendered(container)).not.toContain(PROFILE);
  });
});
