/**
 * Your look: what Fiddy is wearing, what it could wear, and the way in to making
 * one.
 *
 * Settings → Theme has always been a three-way choice (System / Light / Dark).
 * This is the part of the same screen that is about the person: Fiddy's own
 * brand look, the looks this browser has tried, a way to put one on, a way to
 * take it off, and a door to the editor.
 *
 * The copy is the product's voice, which means no jargon: a look is a "look",
 * never a "theme"; nothing here says hex, variable, schema or hash. Taking one
 * off is a sentence, not a warning.
 *
 * The editor is loaded only when someone opens it (`~/lazy/components`): the
 * colour controls and the share call are not part of reading a feed.
 */

import React from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { LookPreview, LookSwatches } from '~/components/looks/LookPreview';
import { useWornLook } from '~/hooks/theme/useWornLook';
import { LookEditorModal } from '~/lazy/components';
import {
  describeLook,
  Look,
  lookLabel,
  sameLook,
  SHIPPED_LOOKS,
} from '~/utils/lookTheme';

type LookRowProps = {
  look: Look;
  worn: boolean;
  onPutOn: (look: Look) => void;
  onEdit: (look: Look) => void;
};

const LookRow: React.FC<LookRowProps> = ({ look, worn, onPutOn, onEdit }) => (
  <div
    className="flex items-center gap-3 rounded-md p-2 border-default"
    data-fiddy="look-row"
    data-fiddy-look={look.name ?? ''}
  >
    <span className="w-24 flex-none overflow-hidden rounded-md">
      <LookPreview look={look} />
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="truncate text-sm font-semibold">{lookLabel(look)}</span>
      <span className="truncate text-xs text-faint">{describeLook(look)}</span>
      <LookSwatches look={look} />
    </span>
    <span className="flex flex-none flex-col items-end gap-1">
      <DefaultButton
        size="sm"
        variant={worn ? 'muted' : 'normal'}
        data-fiddy={worn ? 'look-worn' : 'look-put-on'}
        disabled={worn}
        onClick={() => {
          onPutOn(look);
        }}
      >
        {worn ? 'On' : 'Put it on'}
      </DefaultButton>
      <button
        type="button"
        className="text-xs underline text-faint"
        data-fiddy="look-edit"
        onClick={() => {
          onEdit(look);
        }}
      >
        Change it
      </button>
    </span>
  </div>
);

const LookPicker: React.FC = () => {
  const { wornLook, savedLooks, putOnLook, takeOffLook } = useWornLook();
  const [editing, setEditing] = React.useState<Look | null | undefined>(
    undefined,
  );

  /** Shipped looks first; then only the person's own, never a duplicate. */
  const library = React.useMemo(() => {
    const others = savedLooks.filter(
      (saved) => !SHIPPED_LOOKS.some((shipped) => sameLook(shipped, saved)),
    );
    return [...SHIPPED_LOOKS, ...others];
  }, [savedLooks]);

  const isWorn = React.useCallback(
    (look: Look) => Boolean(wornLook) && sameLook(wornLook as Look, look),
    [wornLook],
  );

  return (
    <div className="flex flex-col gap-3" data-fiddy="look-picker">
      <div>
        <p className="text-sm font-semibold">Your look</p>
        <p className="text-xs text-faint">
          {wornLook
            ? `Fiddy is wearing ${lookLabel(wornLook, 'a look you made')}.`
            : 'Colours, corners and type — a look Fiddy wears, and one you can hand to someone else.'}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {library.map((look) => (
          <LookRow
            key={look.name ?? JSON.stringify(look)}
            look={look}
            worn={isWorn(look)}
            onPutOn={putOnLook}
            onEdit={(chosen) => {
              setEditing(chosen);
            }}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <DefaultButton
          size="sm"
          variant="secondary"
          data-fiddy="look-make-your-own"
          onClick={() => {
            setEditing(null);
          }}
        >
          Make your own
        </DefaultButton>
        {wornLook && (
          <DefaultButton
            size="sm"
            variant="muted"
            data-fiddy="look-take-off"
            onClick={takeOffLook}
          >
            Take it off
          </DefaultButton>
        )}
      </div>

      {editing !== undefined && (
        <React.Suspense fallback={null}>
          <LookEditorModal
            initial={editing ?? wornLook}
            onClose={() => {
              setEditing(undefined);
            }}
          />
        </React.Suspense>
      )}
    </div>
  );
};

export { LookPicker };
