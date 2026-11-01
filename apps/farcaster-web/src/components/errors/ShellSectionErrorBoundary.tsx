/**
 * A region of the shell that is allowed to fail without taking the client down.
 *
 * WHY THIS EXISTS
 * The authed shell is assembled out of surfaces that all fetch from
 * farcaster.xyz. Most have a branch for "the request failed"; a few do not, and
 * one of those used to unmount *everything* — the chrome, the nav, the user's
 * own avatar — because the nearest boundary above them was the app's
 * full-screen one. Measured: `ChannelNavLinksContent` threw `UnhandledFetchError`
 * from a suspense query and the whole client was replaced by the generic
 * "Could not reach Farcaster. Check your connection." page, with no identity on
 * screen at all.
 *
 * So each region gets its own boundary, and the fallback says which region
 * cannot load and why, in place, with the frame still standing around it. It is
 * used for the sidebar's channel list and for the page column
 * (`~/layouts/MainContent`), and it is what any future fetched region should
 * use instead of the full-screen boundary.
 *
 * The boundary deliberately does not touch the query cache on reset: the
 * shell's identity lives in that cache, and a retry must never cost the user
 * their account.
 */

import { useQueryClient } from '@tanstack/react-query';
import { LogOut, RotateCcw } from 'lucide-react';
import React, { FC, memo, ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { useDeviceOnlySession } from '~/components/session/useDeviceOnlySession';
import { NodeCannotAnswerPanel } from '~/components/snapchain/NodeCannotAnswerPanel';
import { useAuth } from '~/contexts/AuthProvider';
import { nodeCannotAnswer } from '~/snapchain/nodeApi/nodeCannotAnswer';
import { getErrorDescription } from '~/utils/errorUtils';

type ShellSectionErrorBoundaryProps = {
  /** The region's name in the user's words ("Channels", "Trending"). */
  label: string;
  children: ReactNode;
};

type ShellSectionFallbackProps = {
  label: string;
  error: Error;
  resetErrorBoundary: () => void;
};

const ShellSectionFallback: FC<ShellSectionFallbackProps> = memo(
  ({ label, error, resetErrorBoundary }) => {
    const session = useDeviceOnlySession();
    const { signOut } = useAuth();

    // The node adapter said, in its own words, that your node cannot answer
    // this read. MEASURED (search, /~/channels, /~/apps/trending against a live
    // node): that sentence used to be thrown away and the region said "Error
    // retrieving data. Please try again." — a retry for a read no retry can
    // fix, with the reason the adapter wrote nowhere on screen. The sentence is
    // the honest answer, so it is what the region shows.
    const refusal = nodeCannotAnswer(error);
    if (refusal) {
      return (
        <NodeCannotAnswerPanel
          label={label}
          reason={refusal.message}
          {...(refusal.retryable ? { onRetry: resetErrorBoundary } : {})}
        />
      );
    }

    // A device-only session reaches nothing over the network, so a retry would
    // be a lie. Say what is actually missing and offer the one action that can
    // change it.
    if (session.isDeviceOnly) {
      return (
        <div className="fiddy-degrade" data-fiddy="shell-section-degraded">
          <p className="fiddy-degrade-title">{label} needs a server session</p>
          <p className="fiddy-degrade-body">
            Farcaster serves this part, and the sign-in on this device
            doesn&rsquo;t reach it yet. Everything below is still yours — only
            the online half is missing.
          </p>
          <div className="fiddy-degrade-actions">
            <button
              type="button"
              className="fiddy-quiet-btn fiddy-quiet-btn-outline fiddy-degrade-btn"
              onClick={() => {
                void signOut();
              }}
            >
              <LogOut size={14} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="fiddy-degrade" data-fiddy="shell-section-degraded">
        <p className="fiddy-degrade-title">{label} couldn&rsquo;t load</p>
        <p className="fiddy-degrade-body">{getErrorDescription(error)}</p>
        <div className="fiddy-degrade-actions">
          <button
            type="button"
            className="fiddy-quiet-btn fiddy-quiet-btn-outline fiddy-degrade-btn"
            onClick={() => {
              resetErrorBoundary();
            }}
          >
            <RotateCcw size={14} aria-hidden="true" />
            Try again
          </button>
        </div>
      </div>
    );
  },
);

ShellSectionFallback.displayName = 'ShellSectionFallback';

const ShellSectionErrorBoundary: FC<ShellSectionErrorBoundaryProps> = memo(
  ({ label, children }) => {
    const queryClient = useQueryClient();

    return (
      <ErrorBoundary
        fallbackRender={({ error, resetErrorBoundary }) => (
          <ShellSectionFallback
            label={label}
            error={error}
            resetErrorBoundary={resetErrorBoundary}
          />
        )}
        onReset={() => {
          // Refetch what this region was waiting for. `invalidateQueries`
          // (rather than the full-screen boundary's `clear`) keeps the cached
          // onboarding state — and with it the user's identity — in place.
          void queryClient.invalidateQueries();
        }}
      >
        {children}
      </ErrorBoundary>
    );
  },
);

ShellSectionErrorBoundary.displayName = 'ShellSectionErrorBoundary';

export { ShellSectionErrorBoundary };
