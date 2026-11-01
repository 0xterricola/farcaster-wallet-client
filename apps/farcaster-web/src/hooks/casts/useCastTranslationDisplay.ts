import { ApiCast } from 'farcaster-client-data';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { castTranslationSourceLanguage } from '~/utils/castLanguage';
import {
  askForCastTranslation,
  castTranslationServiceAvailable,
  readCastTranslation,
  requestCastTranslations,
  subscribeToCastTranslations,
} from '~/utils/castTranslationService';
import {
  castHasPendingTranslation,
  castHasTranslation,
  getCastDisplayText,
  getCastTranslationSourceLanguageName,
  getLanguageDisplayName,
} from '~/utils/castTranslationUtils';

/**
 * What a cast's translation state is, from either source.
 *
 * Two sources, one shape, because the affordance is already shipped and must
 * not care where the words came from:
 *
 *   * `cast.translation` — the HOSTED API's own field, when a build reads
 *     through a provider that carries translations (nothing does today);
 *   * our own service — the detector (`~/utils/castLanguage`) names the cast's
 *     language, `~/utils/castTranslationService` asks our origin, and this
 *     browser keeps the answer. This is the half that works on a node-backed
 *     build, which is what fiddy.fun ships.
 *
 * A cast in the reader's own language, or one the detector cannot place, gets
 * nothing at all — no bar, no button — which is the honest answer rather than a
 * control that would translate a language it guessed at.
 */
const useCastTranslationDisplay = (cast: ApiCast) => {
  const [showOriginal, setShowOriginal] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [serviceAnswers, setServiceAnswers] = useState(false);

  const hasHostedTranslation = castHasTranslation(cast);
  const isTranslationPending = castHasPendingTranslation(cast);

  const ownTranslation = useSyncExternalStore(
    subscribeToCastTranslations,
    () => readCastTranslation(cast.hash),
    () => null,
  );

  // Only asked when nobody has a translation already: a cast that is already
  // translated (or pending) needs no detection.
  const sourceLanguage = useMemo(
    () =>
      hasHostedTranslation || ownTranslation
        ? null
        : castTranslationSourceLanguage(cast.text ?? ''),
    [cast.text, hasHostedTranslation, ownTranslation],
  );

  useEffect(() => {
    if (!sourceLanguage) {
      return undefined;
    }
    let live = true;
    // Whether this host can translate at all, then whatever is already kept for
    // the casts on screen — one round trip for the whole feed, after a moment.
    castTranslationServiceAvailable().then((available) => {
      if (live) {
        setServiceAnswers(available);
      }
    });
    requestCastTranslations([cast.hash]).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [cast.hash, sourceLanguage]);

  const hasTranslation = hasHostedTranslation || Boolean(ownTranslation);

  const displayText = useMemo(() => {
    if (hasHostedTranslation) {
      return getCastDisplayText({ cast, showOriginal });
    }
    if (ownTranslation) {
      return showOriginal ? cast.text : ownTranslation.text;
    }
    return cast.text;
  }, [cast, hasHostedTranslation, ownTranslation, showOriginal]);

  const sourceLanguageName = useMemo(() => {
    if (hasHostedTranslation) {
      return getCastTranslationSourceLanguageName(cast);
    }
    const code = ownTranslation?.from ?? sourceLanguage ?? undefined;
    // A model that could not name the language is 'und' on the wire: the name
    // of the language we OFFERED is the honest thing to show then.
    return (
      getLanguageDisplayName(
        code === 'und' ? (sourceLanguage ?? undefined) : code,
      ) ?? 'another language'
    );
  }, [cast, hasHostedTranslation, ownTranslation, sourceLanguage]);

  const toggleTranslation = useCallback(() => {
    setShowOriginal((current) => !current);
  }, []);

  /** The reader pressed Translate: ask our own origin for this one cast. */
  const offerTranslation = useCallback(async () => {
    setIsAsking(true);
    setNotice(undefined);
    try {
      await askForCastTranslation({
        hash: cast.hash,
        fid: cast.author?.fid,
      });
      setShowOriginal(false);
    } catch (error) {
      // The service's own sentence, in the app's voice: "the free translator is
      // busy", "that cast has no words to translate", or a plain failure.
      setNotice(
        error instanceof Error
          ? error.message
          : "Couldn't translate that right now.",
      );
    } finally {
      setIsAsking(false);
    }
  }, [cast.author?.fid, cast.hash]);

  /**
   * Offered only when there is something to offer: a cast in another language, a
   * service that answers, and no translation yet.
   */
  const isTranslationOffered =
    Boolean(sourceLanguage) && serviceAnswers && !hasTranslation;

  return {
    displayText,
    hasTranslation,
    isTranslationPending,
    isTranslationOffered,
    isAsking,
    notice,
    offerTranslation,
    showOriginal,
    sourceLanguageName,
    toggleLabel: showOriginal ? 'Show translation' : 'Show original',
    toggleTranslation,
  };
};

export { useCastTranslationDisplay };
