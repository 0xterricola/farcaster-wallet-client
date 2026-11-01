/**
 * Where a device-only session lands.
 *
 * WHY THIS IS A LANDING AND NOT THE CLIENT
 * A completed SIWF handshake gives this client something genuinely real and
 * genuinely partial: proof of who signed in (FID, handle, avatar) and no
 * farcaster.xyz API token, because minting one is a server-side exchange this
 * build has no backend for (see ~/lib/siwfSession). The authed client is built
 * entirely out of farcaster.xyz reads and writes, so with that session it
 * cannot render itself: measured on a real-API reload, `user-preferences`,
 * `user-app-context`, `unseen`, `frame-blocklist`, `snap/blocklist` and
 * `feed-items` all fail at the edge (401 with no `Access-Control-Allow-Origin`,
 * which the browser reports as a network failure), two of them escaping React
 * entirely as uncaught rejections, and the client ends up as the bare
 * "Could not reach Farcaster" page with the user's own identity nowhere on
 * screen.
 *
 * Containing each of those failures individually would mean every API-backed
 * surface in the fork growing an error branch — the wrong shape for the
 * problem, because with a device-only session *all* of them fail, always. So
 * the honest thing is not a broken client with error states in it. It is a
 * screen that says what happened, who is signed in, what still works, and how
 * to get the online half.
 *
 * DESIGN CONSTRAINTS THIS RESPECTS
 *  - It names the account the way the sign-in screen named it, from cached
 *    state only (no fetch, so it cannot fail or suspend).
 *  - It is not the welcome page and it does not eject anyone there. Signing out
 *    is an explicit choice, offered once, in plain words.
 *  - It points at the two surfaces that need no account at all (`/agent/brains`
 *    and `/agent/apps`), rather than inventing a new front door of its own.
 *  - It says nothing it cannot support: no "try again" that cannot succeed, no
 *    claim that the account is broken when it is not.
 */

import { LogOut } from 'lucide-react';
import React, { FC, memo } from 'react';

import { Link } from '~/components/links/Link';
import {
  describeDeviceOnlyAccount,
  useDeviceOnlySession,
} from '~/components/session/useDeviceOnlySession';
import { useAuth } from '~/contexts/AuthProvider';

const DeviceOnlySessionPage: FC = memo(() => {
  const session = useDeviceOnlySession();
  const { signOut } = useAuth();

  const account = describeDeviceOnlyAccount(session);
  const who = account !== '' ? account : 'your account';

  return (
    <div className="fiddy-sheet" data-fiddy="device-only-session">
      <div className="fiddy-sheet-top">
        <span className="fiddy-brand">
          <span className="fiddy-dot" aria-hidden="true">
            ●
          </span>
          fiddy
        </span>
        <span className="fiddy-step-count">signed in on this device</span>
      </div>

      <div className="fiddy-sheet-body">
        <h1 className="fiddy-sheet-title" data-fiddy="device-only-account">
          {who}
        </h1>
        <p className="fiddy-sheet-sub">
          Farcaster signed this device in, and that sign-in is real &mdash; it
          is your account. What it does not have is the server-side session the
          online client needs to read and write, so the feed, channels, messages
          and notifications cannot load here yet.
        </p>

        <ul className="fiddy-summary">
          <li>
            <span>
              <b>Yours, and still here</b>
              <small>
                Your FID, handle and profile came straight from the signed
                handshake. Nothing was thrown away or half-created.
              </small>
            </span>
          </li>
          <li>
            <span>
              <b>Not reachable from this device yet</b>
              <small>
                Feeds, channels, messages and notifications are served by
                Farcaster, and this sign-in has no key to them. That is a
                missing exchange, not a broken account.
              </small>
            </span>
          </li>
          <li>
            <span>
              <b>What does work without an account</b>
              <small>
                Your brains and the apps you connect are set up on this device
                and need no sign-in at all.
              </small>
            </span>
          </li>
        </ul>

        <div className="fiddy-sheet-actions">
          <Link
            to="fiddyBrains"
            params={{}}
            searchParams={{}}
            title="Add a brain"
            className="fiddy-primary-btn"
          >
            Add a brain
          </Link>
          <Link
            to="fiddyApps"
            params={{}}
            searchParams={{}}
            title="Connect apps"
            className="fiddy-secondary-btn"
          >
            Connect apps
          </Link>
          <button
            type="button"
            className="fiddy-quiet-btn"
            onClick={() => {
              void signOut();
            }}
          >
            <LogOut size={14} aria-hidden="true" /> Sign out
          </button>
        </div>

        <p className="fiddy-sheet-note">
          Signing out leaves your setup on this device and returns you to the
          front door, where you can sign in on the web when an online session is
          available.
        </p>
      </div>
    </div>
  );
});

DeviceOnlySessionPage.displayName = 'DeviceOnlySessionPage';

export { DeviceOnlySessionPage };
