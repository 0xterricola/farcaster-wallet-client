/**
 * A cast body that folds at 10 lines, with ONE "Show more" — and only when
 * something is really cut off.
 *
 * WHY THIS EXISTS
 *
 * The fold itself was always here (`line-clamp-feed`, 10 lines). What was wrong
 * was the button: `UnfocusedCast` decided whether to show it twice, in two ways
 * that disagreed. One was a ref callback that measured the element exactly once,
 * when React attached it; the other was a length guess made before rendering
 * (is this body longer than the cast byte limit?), which knew nothing about the
 * width the text was drawn at. So a short cast could show a "Show more" that
 * revealed nothing, and a body that got LONGER after that first measurement —
 * a translation swapped in, an edit, content that arrived late — kept the button
 * it had, or lost the one it now needed.
 *
 * PATTERN, AND WHERE IT CAME FROM
 *
 * quilcast (MIT, https://github.com/backmeupplz/quilcast) commit `50283aa5acc1`,
 * "long casts fold at 10 lines behind Show more in feeds" (0.10.6): its `Folded`
 * component measures the clamped element in a layout effect keyed on the text —
 * `p.scrollHeight > p.clientHeight + 1`, the +1 absorbing sub-pixel rounding —
 * and shows the button only when something is actually cut. Borrowed with
 * attribution; see the PR.
 *
 * WHAT THIS ADDS ON TOP
 *
 *   - Re-measures whenever the text it is measuring changes, and whenever the
 *     box it sits in changes (a window resize, a panel opening): a layout effect
 *     for the text, a `ResizeObserver` plus a resize listener for the box.
 *   - One measurement, one button. The length guess in `useCastBody` is gone, so
 *     nothing else can put a second "Show more" on the same cast — and the body
 *     is no longer cut at the byte limit before it is drawn, which used to lose
 *     the tail of a long cast with no way to see it.
 *   - Measurement is cheap and idempotent: it only calls `setState` when the
 *     answer actually changed, so a re-render cannot loop.
 */

import cn from 'classnames';
import React, {
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/**
 * Scroll height can exceed client height by a fraction of a pixel on a clamped
 * box (rounding, sub-pixel line boxes) with nothing hidden at all. A whole pixel
 * is the tolerance: anything a reader could actually see is far more than that.
 */
export const CLAMP_ROUNDING_TOLERANCE_PX = 1;

type ClampedCastBodyProps = {
  /**
   * The text being drawn, so a change to it re-measures. The same text a
   * translation swap or an edit replaces.
   */
  text: string;
  /** Feeds fold their casts; a focused cast, or an expanded body, does not. */
  fold: boolean;
  onExpand: () => void;
  children: ReactNode;
};

const ClampedCastBody: React.FC<ClampedCastBodyProps> = ({
  text,
  fold,
  onExpand,
  children,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [isClamped, setIsClamped] = useState(false);

  const measure = useCallback(() => {
    const element = bodyRef.current;
    const clamped =
      element !== null &&
      fold &&
      element.scrollHeight > element.clientHeight + CLAMP_ROUNDING_TOLERANCE_PX;

    // Only a changed answer is a new render: measuring cannot loop.
    setIsClamped((previous) => (previous === clamped ? previous : clamped));
  }, [fold]);

  // After every paint that could change the fold: the text it is measuring.
  useLayoutEffect(() => {
    measure();
  }, [measure, text]);

  // ...and the box it is measuring in, which changes without the text changing.
  useEffect(() => {
    if (!fold) {
      return;
    }

    const element = bodyRef.current;
    const observer =
      typeof ResizeObserver === 'function' && element !== null
        ? new ResizeObserver(measure)
        : null;
    observer?.observe(element as HTMLDivElement);

    window.addEventListener('resize', measure);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [fold, measure, text]);

  return (
    <>
      <div
        ref={bodyRef}
        className={cn(fold && 'line-clamp-feed', '[overflow-wrap:anywhere]')}
      >
        {children}
      </div>
      {fold && isClamped && (
        <button
          type="button"
          className={cn(
            'inline cursor-pointer border-0 bg-transparent p-0 text-left text-link hover:underline',
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onExpand();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          Show more
        </button>
      )}
    </>
  );
};

export { ClampedCastBody };
