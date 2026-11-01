/**
 * The shell, drawn by the app.
 *
 * The document ships this same shell as static HTML inside `#root` (see
 * `index.html`, searched for by `shell-skeleton:start`), so a signed-in reader
 * arriving on a cold load sees the top bar, the rail and the page column from
 * the first paint — before the bundle, and long before the feed has any data.
 *
 * This component exists for the other half: once the app is running, anything
 * that suspends *above* the shell would otherwise paint nothing at all. The
 * app's root boundary and the one around the shell's own providers fall back to
 * this, so the worst case while the app is alive is the same shell with the
 * page column still loading — never a blank page, not even for a frame.
 *
 * It carries no facts, on purpose: no avatar, no node pill, no cast, no name.
 * Only the brand and shapes, so it cannot be read as a claim about who is
 * signed in or which server answered. The one sentence in it is for a screen
 * reader.
 *
 * The class names and the shape live in `index.html`'s own stylesheet (a
 * document's skeleton has to paint before any stylesheet the bundle carries);
 * `__tests__/ShellSkeleton.test.tsx` reads both files and fails if this markup
 * and that one drift apart.
 */

import React, { FC, memo } from 'react';

import { FIDDY_MARK_POSTER } from '~/components/fiddy/fiddyMark';

/** How many placeholders of each shape the shell draws. */
const NAV_ROWS = 8;
const CAST_PLACEHOLDERS = 3;
const RAIL_PLACEHOLDERS = 2;
const TAB_PLACEHOLDERS = 5;

const rows = (count: number, className: string) =>
  Array.from({ length: count }, (_, index) => (
    <div key={index} className={className} />
  ));

const ShellSkeleton: FC = memo(() => (
  <div className="fiddy-skeleton" data-fiddy="shell-skeleton">
    <span className="fiddy-skeleton-status" role="status">
      Loading Fiddy&hellip;
    </span>
    <div aria-hidden="true">
      <header className="fiddy-skeleton-topbar">
        <span className="fiddy-skeleton-brand">
          <img
            className="fiddy-skeleton-mark"
            src={FIDDY_MARK_POSTER}
            alt=""
            width={36}
            height={36}
          />
          fiddy
        </span>
      </header>
      <div className="fiddy-skeleton-body">
        <nav className="fiddy-skeleton-nav">
          <img
            className="fiddy-skeleton-nav-mark"
            src={FIDDY_MARK_POSTER}
            alt=""
            width={24}
            height={24}
          />
          {rows(NAV_ROWS, 'fiddy-skeleton-block fiddy-skeleton-row')}
        </nav>
        <div className="fiddy-skeleton-col">
          <div className="fiddy-skeleton-mobilebar" />
          <div className="fiddy-skeleton-block fiddy-skeleton-block-composer" />
          {rows(
            CAST_PLACEHOLDERS,
            'fiddy-skeleton-block fiddy-skeleton-block-cast',
          )}
        </div>
        <aside className="fiddy-skeleton-rail">
          {rows(
            RAIL_PLACEHOLDERS,
            'fiddy-skeleton-block fiddy-skeleton-block-rail',
          )}
        </aside>
      </div>
      <div className="fiddy-skeleton-tabs">
        {rows(TAB_PLACEHOLDERS, 'fiddy-skeleton-block fiddy-skeleton-tab')}
      </div>
    </div>
  </div>
));

ShellSkeleton.displayName = 'ShellSkeleton';

export { ShellSkeleton };
