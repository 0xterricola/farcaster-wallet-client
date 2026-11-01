/**
 * A look someone handed over: the link, drawn as the thing it is.
 *
 * One component, three places: the page a shared link opens (`/look/<id>`), the
 * card the same link leaves inside a cast, and anywhere else a look link turns
 * up. All three read the look the same way (`useSharedLook` → `cleanLook`), so a
 * look that survives the wire is drawn here and nowhere else.
 *
 * THE FOUR STATES, IN THE PRODUCT'S VOICE:
 *
 *   loading  a quiet line, never a spinner over nothing;
 *   ready    the look, drawn in its own colours, with "Put this look on";
 *   worn     "Saved — you can undo this", with undo putting back what was worn;
 *   missing  ONE plain sentence — "That look link doesn't work any more." —
 *            never a blank card, and never the word "error".
 *
 * The maker's name is never invented: it is either carried by the link or the
 * cast that shared it, or the card says it does not know who made it.
 */

import React from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { LookPreview, LookSwatches } from '~/components/looks/LookPreview';
import { useSharedLook } from '~/hooks/looks/useSharedLook';
import { useWornLook } from '~/hooks/theme/useWornLook';
import { describeLook, Look, lookLabel, sameLook } from '~/utils/lookTheme';

type SharedLookCardProps = {
  id: string;
  /** Who handed it over, from the link or the cast that carried it. */
  by?: string;
  /** `embed` is the card inside a cast: tighter, and it never takes the page. */
  variant?: 'page' | 'embed';
  className?: string;
};

const SharedLookCard: React.FC<SharedLookCardProps> = React.memo(
  ({ id, by, variant = 'page', className }) => {
    const shared = useSharedLook(id);
    const { wornLook, putOnLook, takeOffLook } = useWornLook();
    /** What was worn before this look went on, so undo can put it back. */
    const [previous, setPrevious] = React.useState<Look | undefined>(undefined);

    const putOn = React.useCallback(
      (look: Look) => {
        setPrevious(wornLook);
        putOnLook(look);
      },
      [putOnLook, wornLook],
    );

    // UNDO PUTS BACK WHAT WAS THERE — which is usually NOTHING, and nothing is
    // not "put on the empty look": `putOnLook` refuses an empty look by design
    // (it is the guard that keeps a half-written draft off the screen), so
    // handing it `{}` left the shared look worn and the undo press did nothing.
    // MEASURED 2026-10-23 on fiddy.fun, card t_d85d8520: the link's own page,
    // wearing the look for the first time, then Undo — the palette stayed and
    // `fiddy-look` still held it. Nothing worn before means take it off.
    //
    // What the card SHOWS is `isWorn` alone, and that is the other half of the
    // same rule: an undo leaves this look off, so the card is back to offering
    // it ("Put this look on"), never claiming it is saved.
    const undo = React.useCallback(() => {
      if (previous) {
        putOnLook(previous);
      } else {
        takeOffLook();
      }
    }, [previous, putOnLook, takeOffLook]);

    if (shared.state === 'loading') {
      return (
        <div
          className={`flex items-center gap-3 rounded-lg p-4 border-default ${className ?? ''}`}
          data-fiddy="shared-look-loading"
        >
          <span className="fiddy-look-bar w-24" />
          <span className="text-sm text-faint">Opening this look…</span>
        </div>
      );
    }

    if (shared.state === 'missing') {
      return (
        <div
          className={`flex flex-col gap-2 rounded-lg p-4 border-default ${className ?? ''}`}
          data-fiddy="shared-look-missing"
        >
          <p className="text-sm">{shared.error}</p>
          <p className="text-xs text-faint">
            A look lives behind its link; if nobody has it any more, there is
            nothing here to put on.
          </p>
        </div>
      );
    }

    const { look } = shared;
    const isWorn = Boolean(wornLook) && sameLook(wornLook as Look, look);
    const maker = by ? `@${by.replace(/^@/, '')}` : undefined;

    return (
      <div
        className={`flex flex-col gap-3 rounded-lg p-4 border-default ${className ?? ''}`}
        data-fiddy="shared-look"
        data-fiddy-look-id={id}
      >
        <div className="flex items-center gap-2">
          <LookSwatches look={look} />
          <p className="min-w-0 flex-1 truncate text-sm font-semibold">
            {maker ? `${maker} made this look` : 'A look someone shared'}
          </p>
        </div>

        <LookPreview look={look} />

        <p className="text-xs text-faint">
          {lookLabel(look, 'A look')} · {describeLook(look)}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {isWorn ? (
            <>
              <span
                className="text-sm text-faint"
                data-fiddy="shared-look-saved"
              >
                Saved — you can undo this
              </span>
              <DefaultButton
                size="sm"
                variant="muted"
                data-fiddy="shared-look-undo"
                onClick={undo}
              >
                Undo
              </DefaultButton>
            </>
          ) : (
            <DefaultButton
              size="sm"
              data-fiddy="shared-look-put-on"
              onClick={() => {
                putOn(look);
              }}
            >
              Put this look on
            </DefaultButton>
          )}
        </div>

        {variant === 'embed' && (
          <p className="text-xs text-faint">
            It changes Fiddy&apos;s colours, corners and type for whoever wears
            it — nothing leaves your device.
          </p>
        )}
      </div>
    );
  },
);

SharedLookCard.displayName = 'SharedLookCard';

export { SharedLookCard };
