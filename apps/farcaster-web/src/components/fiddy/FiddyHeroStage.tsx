/**
 * The hero Fiddy, on the page a visitor meets first.
 *
 * Four rules, the same four the chrome's mark keeps, in the same order:
 *
 *   1. The still paints first, always. The stage is never an empty box: the
 *      still is a PNG of this model's own front view, rendered at commit time in
 *      the same lighting the live canvas uses, so what arrives is a Fiddy and
 *      not a placeholder.
 *   2. The box exists before the model does. Its size comes from CSS and is
 *      identical before and after, so the model's arrival moves nothing on the
 *      page — the thing a hero is most likely to wreck.
 *   3. Motion is asked for, not assumed. Under `prefers-reduced-motion: reduce`
 *      the model is never fetched: the loop is decoration, and a reader who
 *      asked for stillness should not pay for it in bytes either.
 *   4. Anything that goes wrong — no WebGL, a missing file, a parse failure —
 *      leaves the still in place and says nothing.
 *
 * THE FRONT DOOR'S STAGE IS A BUTTON. It is the one variant that is a toy: the
 * pointer moves its head from anywhere on the page, and pressing it (a tap, or
 * Enter/Space on a keyboard) is the greeting — so it is a real `<button>` with a
 * name, reachable by keyboard, rather than a decorative box with a click handler
 * hidden in it. The small variant beside the name field is decoration, and is
 * `aria-hidden` with the pointer turned off: a canvas that eats a tap meant for
 * the input next to it is a bug, not a toy.
 *
 * `data-fiddy-hero` reports which state is on screen (`still` or `moving`) and
 * the canvas inside carries what the character is doing (`playing`, `resting`,
 * `reacting`) plus the head's own angle in `data-look`, so a probe can assert
 * all of it instead of guessing from pixels.
 */

import React, { memo, useEffect, useRef, useState } from 'react';

import {
  FIDDY_HERO_CLIP,
  FIDDY_HERO_HEAD,
  FIDDY_HERO_LOOK,
  FIDDY_HERO_MODEL,
  FIDDY_HERO_PADDING,
  FIDDY_HERO_POSTER,
  FIDDY_HERO_REST_AFTER_MS,
  FIDDY_HERO_VIEW,
  heroMotionAllowed,
} from './fiddyHero';

/** Long enough that the front door is painted and readable first. */
const AFTER_FIRST_PAINT_MS = 320;

/** A tiny conversation with the baby. The fifth hello is the easter egg. */
const GREETINGS = [
  'Hiya, you!',
  'Boop received.',
  'Again! Again!',
  'You made my day.',
  'Okay, we are friends now.',
] as const;

export interface FiddyHeroStageProps {
  /**
   * `hero` is the front door's stage: big, listening to the pointer, and
   * greeting a press. `form` is the small one that sits beside a field while you
   * type a name.
   */
  variant?: 'hero' | 'form';
}

const FiddyHeroStage = memo<FiddyHeroStageProps>(({ variant = 'hero' }) => {
  const host = useRef<HTMLSpanElement>(null);
  const mounted = useRef<{ dispose(): void; react(): void } | null>(null);
  const [moving, setMoving] = useState(false);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [greeting, setGreeting] = useState<number | null>(null);

  // Rule 3, read before anything is fetched. `null` (no matchMedia) counts as
  // allowed: an absence of the preference is not a request for stillness.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setMotionAllowed(heroMotionAllowed(query.matches));
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
    // The `import()` is the point: three.js is a chunk of its own, shared with
    // the chrome's mark, fetched here and never as part of the first paint.
    const timer = window.setTimeout(() => {
      void import('./fiddyModelScene')
        .then(({ mountFiddyModel }) => {
          if (controller.signal.aborted || !host.current) {
            return undefined;
          }
          return mountFiddyModel(host.current, controller.signal, {
            model: FIDDY_HERO_MODEL,
            // The character's own loop, and the rig node the pointer turns
            // inside it. Nothing orbits the model: the model is the performer.
            clip: FIDDY_HERO_CLIP,
            look: { node: FIDDY_HERO_HEAD, ...FIDDY_HERO_LOOK },
            restAfterMs: FIDDY_HERO_REST_AFTER_MS,
            view: FIDDY_HERO_VIEW,
            padding: FIDDY_HERO_PADDING,
          });
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
          // Rule 4: the still is the whole hero in that case, and the reader is
          // not told about a mascot's plumbing.
        });
    }, AFTER_FIRST_PAINT_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      mounted.current?.dispose();
      mounted.current = null;
    };
  }, [motionAllowed, variant]);

  const contents = (
    <>
      {/* Rule 1, and rule 2 with it: the still is an <img> with real dimensions
          inside a box CSS has already sized, so nothing below it moves when the
          canvas takes over. */}
      <img
        className="fiddy-hero-stage-still"
        src={FIDDY_HERO_POSTER}
        alt=""
        decoding="async"
        draggable={false}
      />
      <span className="fiddy-hero-stage-canvas" ref={host} />
    </>
  );

  // A press is the greeting, and the browser gives a button Enter and Space for
  // free — so the whole interaction is one onClick, with no key handler to keep
  // in step with it.
  if (variant === 'hero') {
    return (
      <button
        type="button"
        className="fiddy-hero-stage fiddy-hero-stage-hero"
        data-fiddy-hero={moving ? 'moving' : 'still'}
        data-fiddy-hero-variant="hero"
        aria-label="Play with Fiddy"
        onClick={() => {
          mounted.current?.react();
          setGreeting((current) => (current === null ? 0 : current + 1));
        }}
      >
        {contents}
        {greeting !== null ? (
          <span
            key={greeting}
            className="fiddy-hero-greeting"
            data-fiddy="hero-reaction"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {GREETINGS[greeting % GREETINGS.length]}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <span
      className={`fiddy-hero-stage fiddy-hero-stage-${variant}`}
      data-fiddy-hero={moving ? 'moving' : 'still'}
      data-fiddy-hero-variant={variant}
      aria-hidden="true"
    >
      {contents}
    </span>
  );
});

FiddyHeroStage.displayName = 'FiddyHeroStage';

export { FiddyHeroStage };
