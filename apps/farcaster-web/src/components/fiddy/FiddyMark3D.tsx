/**
 * The baby Fiddy mark in the top-left chrome.
 *
 * Three rules, in this order:
 *
 *   1. The still paints first, always. The mark is never an empty slot, and it
 *      is never the reason the shell waits — the still is a PNG of the mark's
 *      own first frame (`~/components/fiddy/fiddyMark`), not a placeholder.
 *   2. Motion is asked for, not assumed. Under `prefers-reduced-motion: reduce`
 *      the model is never fetched: the loop is decoration, and a reader who
 *      asked for stillness should not pay for it in bytes either.
 *   3. Anything that goes wrong — no WebGL, a missing model, a parse failure —
 *      leaves the still in place and says nothing. It is a logo.
 *
 * `data-fiddy-mark` reports which of the three is true on screen (`still` or
 * `moving`), so a probe can assert the state instead of guessing from pixels.
 */

import React, { memo, useEffect, useRef, useState } from 'react';

import {
  FIDDY_MARK_POSTER,
  FIDDY_MARK_SIZE,
  markMotionAllowed,
} from './fiddyMark';

/** Long enough that the shell is painted and interactive first. */
const AFTER_FIRST_PAINT_MS = 80;

interface FiddyMark3DProps {
  /** Chrome size in px. */
  size?: number;
}

const FiddyMark3D = memo<FiddyMark3DProps>(({ size = FIDDY_MARK_SIZE }) => {
  const host = useRef<HTMLSpanElement>(null);
  const mounted = useRef<{ dispose(): void } | null>(null);
  const [moving, setMoving] = useState(false);
  const [motionAllowed, setMotionAllowed] = useState(false);

  // Rule 2, read before anything is fetched. `null` (no matchMedia) counts as
  // allowed: an absence of the preference is not a request for stillness.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setMotionAllowed(markMotionAllowed(query.matches));
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!motionAllowed) {
      setMoving(false);
      return;
    }

    const controller = new AbortController();
    // The `import()` is the whole point: three.js is a chunk of its own,
    // fetched here and never as part of the shell.
    const timer = window.setTimeout(() => {
      void import('./fiddyModelScene')
        .then(({ mountFiddyMark }) => {
          if (controller.signal.aborted || !host.current) {
            return undefined;
          }
          return mountFiddyMark(host.current, controller.signal);
        })
        .then((scene) => {
          if (!scene) {
            return;
          }
          if (controller.signal.aborted) {
            scene.dispose();
            return;
          }
          mounted.current = scene;
          setMoving(true);
        })
        .catch(() => {
          // Rule 3: the still is the whole mark in that case, and the reader
          // is not told about a logo's plumbing.
        });
    }, AFTER_FIRST_PAINT_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      mounted.current?.dispose();
      mounted.current = null;
    };
  }, [motionAllowed]);

  return (
    <span
      className="fiddy-brand-mark3d"
      style={{ width: size, height: size }}
      data-fiddy-mark={moving ? 'moving' : 'still'}
      aria-hidden="true"
    >
      {/* The still is the fallback and the first paint at once, so it is an
          <img> with real dimensions rather than a background: no layout shift
          when the model arrives, and no request for the model when it doesn't. */}
      <img
        className="fiddy-brand-mark3d-still"
        src={FIDDY_MARK_POSTER}
        alt=""
        width={size}
        height={size}
        decoding="async"
      />
      <span className="fiddy-brand-mark3d-canvas" ref={host} />
    </span>
  );
});

FiddyMark3D.displayName = 'FiddyMark3D';

export { FiddyMark3D };
