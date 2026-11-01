/**
 * The cast-translation probe's page: the SHIPPED pair, in a real browser.
 *
 * What is on this page is exactly what the two render sites draw —
 * `useCastTranslationDisplay(cast)` and `CastTranslationTopHat`, with the same
 * conditional (`hasTranslation || isTranslationPending || isTranslationOffered`)
 * that `FocusedCast` and `UnfocusedCast` use. Nothing here re-implements the
 * behaviour being measured: the hook, the component and the service client
 * (`~/utils/castTranslationService`) are the app's own, and the requests go to
 * the app's OWN origin through the dev server's proxy, which is production's
 * shape.
 *
 * Null for the two render sites? `UnfocusedCast` needs the whole authed shell
 * (route family, eventing, the reactions stack, prefetching) and cannot be
 * mounted outside it, so the probe drives the pair they both draw. That limit is
 * stated in the probe's own output and in the card's handoff.
 *
 * The runner drives this through `window.__translationProbe` — not part of the
 * app's build, nothing imports it.
 */
import type { ApiCast } from 'farcaster-client-data';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { CastTranslationTopHat } from '~/components/casts/CastTranslationTopHat';
import { useCastTranslationDisplay } from '~/hooks/casts/useCastTranslationDisplay';

const params = new URLSearchParams(window.location.search);
/** The fixture cast the stub node holds, and the stub model translates. */
const HASH = params.get('hash') ?? '0x1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5';
/**
 * The English fixture is a DIFFERENT cast, because it has to be: translations
 * are kept per cast, so switching the words of one cast to English would still
 * find the Spanish cast's answer in the cache — and the thing being measured is
 * that an English cast is not offered anything at all.
 */
const ENGLISH_HASH =
  params.get('englishHash') ?? '0x5f60718293a4b5c6d7e8f901a2b3c4d500112233';
const AUTHOR_FID = Number(params.get('fid') ?? 3);

const SPANISH =
  'Hoy es un gran día para construir en Farcaster, ¿qué están haciendo ustedes?';
const ENGLISH =
  'Today is a great day to build on Farcaster, what are you doing?';

const castOf = (text: string, hash = HASH): ApiCast =>
  ({ hash, text, author: { fid: AUTHOR_FID } }) as unknown as ApiCast;

type Probe = {
  show: (which: 'spanish' | 'english') => void;
  state: () => {
    /** The row above the cast, or null when there is no bar at all. */
    bar: string | null;
    /** The bar's trailing button, or null. */
    button: string | null;
    /** The words on screen: the cast body as the reader sees it. */
    body: string | null;
  };
  press: () => void;
  hide: () => void;
};

const Harness = ({ cast }: { cast: ApiCast }) => {
  const {
    displayText,
    hasTranslation,
    isTranslationPending,
    isTranslationOffered,
    isAsking,
    notice,
    offerTranslation,
    showOriginal,
    sourceLanguageName,
    toggleLabel,
    toggleTranslation,
  } = useCastTranslationDisplay(cast);

  return (
    <div className="cast">
      {(hasTranslation || isTranslationPending || isTranslationOffered) && (
        <CastTranslationTopHat
          isPending={isTranslationPending}
          isOffered={isTranslationOffered}
          isAsking={isAsking}
          notice={notice}
          onOffer={offerTranslation}
          sourceLanguageName={sourceLanguageName}
          showOriginal={showOriginal}
          toggleLabel={toggleLabel}
          onToggle={toggleTranslation}
        />
      )}
      <p>{displayText}</p>
    </div>
  );
};

const mount = document.getElementById('fixture-cast') as HTMLElement;
let root: Root | undefined;
const flat = (value: string | null | undefined) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const probe: Probe = {
  show(which) {
    root?.unmount();
    root = createRoot(mount);
    root.render(
      <Harness
        cast={
          which === 'spanish' ? castOf(SPANISH) : castOf(ENGLISH, ENGLISH_HASH)
        }
      />,
    );
  },
  /** What is on screen, read as a reader sees it: text, never a marker. */
  state() {
    const barRow = mount.querySelector('.cast > div');
    const button = barRow?.querySelector('button');
    return {
      bar: barRow ? flat(barRow.textContent) : null,
      button: button ? flat(button.textContent) : null,
      body: flat(mount.querySelector('p')?.textContent),
    };
  },
  press() {
    const button = mount.querySelector('.cast > div button');
    if (!button) {
      throw new Error('there is no button on screen to press');
    }
    (button as HTMLButtonElement).click();
  },
  hide() {
    root?.unmount();
    root = undefined;
  },
};

declare global {
  interface Window {
    __translationProbe?: Probe;
  }
}

window.__translationProbe = probe;
