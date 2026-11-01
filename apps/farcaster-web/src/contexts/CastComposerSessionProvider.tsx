import { ComposeCast } from '@farcaster/miniapp-core';
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai';
import React, { ReactNode, Suspense, useCallback, useMemo } from 'react';

import { ComposeCastModal } from '~/lazy/components';
import { CastComposerIntent } from '~/types';

type OpenComposerOptions = {
  intent?: CastComposerIntent;
  isIntentFromSearchParams?: boolean;
  onClose?: (cast: ComposeCast.Result<false>['cast'] | undefined) => void;
};

type ComposerSession = OpenComposerOptions & {
  backgrounded: boolean;
};

const castComposerSessionAtom = atom<ComposerSession | null>(null);
const hasBackgroundedCastComposerSessionAtom = atom((get) =>
  Boolean(get(castComposerSessionAtom)?.backgrounded),
);
const isCastComposerSessionOpenAtom = atom((get) => {
  const session = get(castComposerSessionAtom);
  return Boolean(session && !session.backgrounded);
});

function CastComposerSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useAtom(castComposerSessionAtom);

  const closeComposer = useCallback(
    (cast: ComposeCast.Result<false>['cast'] | undefined) => {
      let onClose: OpenComposerOptions['onClose'] | undefined;
      setSession((current) => {
        onClose = current?.onClose;
        return null;
      });
      onClose?.(cast);
    },
    [setSession],
  );

  return (
    <>
      {children}
      {session ? (
        /* The composer's own chunk arrives here (see `~/lazy/components`): until
           it does, the modal is simply not there — the reader asked for a
           composer and gets one a moment later, not a shell skeleton over the
           whole app. */
        <Suspense fallback={null}>
          <ComposeCastModal
            onClose={closeComposer}
            intent={session.intent}
            isIntentFromSearchParams={session.isIntentFromSearchParams}
            backgrounded={session.backgrounded}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function useCastComposerSession() {
  const hasBackgroundedSession = useAtomValue(
    hasBackgroundedCastComposerSessionAtom,
  );
  const isComposerOpen = useAtomValue(isCastComposerSessionOpenAtom);
  const setSession = useSetAtom(castComposerSessionAtom);

  const openComposer = useCallback(
    (options: OpenComposerOptions = {}) => {
      setSession({
        ...options,
        backgrounded: false,
      });
    },
    [setSession],
  );

  const resumeComposer = useCallback(() => {
    setSession((current) =>
      current ? { ...current, backgrounded: false } : current,
    );
  }, [setSession]);

  const backgroundComposer = useCallback(() => {
    setSession((current) =>
      current ? { ...current, backgrounded: true } : current,
    );
  }, [setSession]);

  const closeComposer = useCallback(
    (cast: ComposeCast.Result<false>['cast'] | undefined) => {
      let onClose: OpenComposerOptions['onClose'] | undefined;
      setSession((current) => {
        onClose = current?.onClose;
        return null;
      });
      onClose?.(cast);
    },
    [setSession],
  );

  return useMemo(
    () => ({
      hasBackgroundedSession,
      isComposerOpen,
      openComposer,
      resumeComposer,
      backgroundComposer,
      closeComposer,
    }),
    [
      backgroundComposer,
      closeComposer,
      hasBackgroundedSession,
      isComposerOpen,
      openComposer,
      resumeComposer,
    ],
  );
}

export { CastComposerSessionProvider, useCastComposerSession };
