/**
 * Mounting Privy's browser half — when configured, and never in the way when not.
 *
 * THREE THINGS THIS HAS TO GET RIGHT.
 *
 * 1. NO APP ID MEANS NO FEATURE, NOT A BROKEN ONE. With `VITE_PRIVY_APP_ID`
 *    unset — every build today — this renders its children and nothing else: no
 *    SDK is fetched, no iframe, no network. That is what makes the social door a
 *    switch rather than a risk.
 *
 * 2. THE APP'S FIRST PAINT DOES NOT WAIT FOR THE SDK. The provider is imported
 *    in its own chunk and mounted only once that chunk has arrived, so the shell
 *    paints as it always did and a slow (or blocked) third-party script cannot
 *    hold the front door shut. The subtree remounts once, when the provider
 *    appears — which is why `ready` is published through a context rather than
 *    left implicit: a component that needs Privy hooks can ask whether the
 *    provider is here yet instead of assuming, and a click that arrives too early
 *    is a disabled button rather than a crash.
 *
 * 3. A PROVIDER THAT REFUSES DOES NOT TAKE THE CLIENT WITH IT. MEASURED
 *    (2026-10-22): with an app id configured that the dashboard does not know,
 *    the real SDK throws during render, the nearest boundary was the app's
 *    full-screen one, and the whole client became "We encountered an unexpected
 *    error. Try again" — no doors, and no Farcaster sign-in either. So the
 *    provider gets its own boundary: when it refuses, the children are rendered
 *    WITHOUT it, `ready` stays false, `data-fiddy-privy` says `failed`, and the
 *    doors say what happened in a sentence instead of the app disappearing. A
 *    third party may not be able to break the way in.
 *
 * WHY NOT AT THE VERY TOP OF THE TREE. The provider is mounted inside
 * `~/components/App` rather than around it, so the routes, the shell and the
 * error boundaries that already exist keep working exactly as measured, whether
 * or not Privy is in the picture.
 */

import type { PrivyProviderProps } from '@privy-io/react-auth';
import React, {
  createContext,
  FC,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import {
  areSocialSignUpsAvailable,
  privyAppId,
  privyBrowserConfig,
} from '~/lib/socialSignUp';

/** What the client knows about Privy right now, in one word. */
export type PrivyRootState = 'absent' | 'loading' | 'ready' | 'failed';

type PrivyRootValue = {
  /** True once the SDK is loaded and the provider is mounted above this point. */
  ready: boolean;
  /** True when this build has the feature at all. */
  configured: boolean;
  /** True when the provider was mounted and refused. Asking is over; say why. */
  failed: boolean;
  /** The same facts as one word, published on the document element. */
  state: PrivyRootState;
};

const PrivyRootContext = createContext<PrivyRootValue>({
  ready: false,
  configured: false,
  failed: false,
  state: 'absent',
});

/** Ask whether Privy's provider is up. Safe to call with no provider at all. */
export const usePrivyRoot = (): PrivyRootValue => useContext(PrivyRootContext);

const PrivyRoot: FC<{ children: ReactNode }> = ({ children }) => {
  const appId = privyAppId();
  const configured = areSocialSignUpsAvailable();

  const [Provider, setProvider] = useState<
    React.ComponentType<PrivyProviderProps> | undefined
  >();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!configured) {
      return;
    }

    let live = true;

    void import('@privy-io/react-auth').then(
      (module) => {
        if (live) {
          setProvider(() => module.PrivyProvider);
        }
      },
      () => {
        // The chunk itself did not arrive. That is a refusal like any other, and
        // it must not be a spinner that spins forever.
        if (live) {
          setFailed(true);
        }
      },
    );

    return () => {
      live = false;
    };
  }, [configured]);

  const ready = configured && !failed && Provider !== undefined;

  const state: PrivyRootState = !configured
    ? 'absent'
    : failed
      ? 'failed'
      : ready
        ? 'ready'
        : 'loading';

  /**
   * Published where a probe (and a person debugging) can read it.
   *
   * MEASURED (2026-10-22): the doors appear in the modal before the SDK has
   * arrived — drawn disabled, saying "one moment" — and when it does arrive the
   * subtree remounts, which closes a modal that was opened while the chunk was
   * still loading. A probe that presses a door the moment it appears is
   * therefore measuring the wrong moment, and this component is the only thing
   * that knows the right one: `absent` without an app id, `loading` while the
   * chunk is on its way, `ready` once signing up can actually be attempted, and
   * `failed` when the provider refused.
   */
  useEffect(() => {
    const root = document.documentElement;

    root.setAttribute('data-fiddy-privy', state);

    return () => {
      root.removeAttribute('data-fiddy-privy');
    };
  }, [state]);

  const onProviderError = useCallback(() => {
    setFailed(true);
  }, []);

  if (!configured || failed || !Provider || !appId) {
    return (
      <PrivyRootContext.Provider
        value={{ ready: false, configured, failed, state }}
      >
        {children}
      </PrivyRootContext.Provider>
    );
  }

  return (
    <PrivyRootContext.Provider value={{ ready, configured, failed, state }}>
      {/* `fallbackRender` is null on purpose: the fallback is momentary — the
          error sets `failed`, and the next render is the branch above, which
          renders the children without the provider. */}
      <ErrorBoundary onError={onProviderError} fallbackRender={() => null}>
        <Provider appId={appId} config={privyBrowserConfig()}>
          {children}
        </Provider>
      </ErrorBoundary>
    </PrivyRootContext.Provider>
  );
};

export { PrivyRoot, PrivyRootContext };
export type { PrivyRootValue };
