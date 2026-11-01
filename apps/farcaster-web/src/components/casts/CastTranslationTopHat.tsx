import { Languages } from 'lucide-react';
import { FC, memo, MouseEvent } from 'react';

import { FeedItemTopHatContainer } from '~/components/casts/FeedItemTopHat';

type CastTranslationTopHatProps = {
  isPending?: boolean;
  sourceLanguageName: string;
  showOriginal: boolean;
  toggleLabel: string;
  onToggle: () => void;
  /**
   * No translation exists yet and one can be made: the bar offers it instead of
   * reporting it. Only ever true when the origin answered `GET /api/translate`
   * with `{on:true}` — a host that cannot translate draws nothing at all.
   */
  isOffered?: boolean;
  /** The ask is in flight: the button says so and cannot be pressed twice. */
  isAsking?: boolean;
  /** The service's own refusal, in the app's voice, in place of the row's sentence. */
  notice?: string;
  onOffer?: () => void;
};

const CastTranslationTopHat: FC<CastTranslationTopHatProps> = memo((props) => {
  const onToggleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (props.isPending) {
    return (
      <FeedItemTopHatContainer icon={<Languages size={12} />}>
        translation pending...
      </FeedItemTopHatContainer>
    );
  }

  const {
    sourceLanguageName,
    showOriginal,
    toggleLabel,
    onToggle,
    isOffered,
    isAsking,
    notice,
    onOffer,
  } = props;

  if (isOffered) {
    return (
      <FeedItemTopHatContainer
        icon={<Languages size={12} />}
        trailing={
          <button
            type="button"
            className="shrink-0 font-medium text-link hover:underline disabled:no-underline disabled:opacity-60"
            aria-label={`Translate from ${sourceLanguageName}`}
            disabled={isAsking}
            onClick={(event) => {
              onToggleClick(event);
              onOffer?.();
            }}
          >
            {isAsking
              ? 'Translating...'
              : notice
                ? 'Try again'
                : `Translate from ${sourceLanguageName}`}
          </button>
        }
      >
        {notice ?? `Written in ${sourceLanguageName}`}
      </FeedItemTopHatContainer>
    );
  }

  return (
    <FeedItemTopHatContainer
      icon={<Languages size={12} />}
      trailing={
        <button
          type="button"
          className="shrink-0 font-medium text-link hover:underline"
          aria-pressed={showOriginal}
          aria-label={
            showOriginal ? 'Show translated text' : 'Show original text'
          }
          onClick={(event) => {
            onToggleClick(event);
            onToggle();
          }}
        >
          {toggleLabel}
        </button>
      }
    >
      translated from {sourceLanguageName}
    </FeedItemTopHatContainer>
  );
});

CastTranslationTopHat.displayName = 'CastTranslationTopHat';

export { CastTranslationTopHat };
