/**
 * The baby Fiddy mark, as assets and as one rule about when it may move.
 *
 * The model is the owner-authored 5s loop from fiddy.fun (`fiddy-loader.glb`),
 * not the full mascot: at 36px the two are indistinguishable, and the loop is
 * 148 KB against 572 KB — a mark in the chrome is not worth four times the
 * bytes on every first visit.
 *
 * The still (`fiddy-mark-poster.png`) is not a drawing of the mark: it is one
 * frame of the very same GLB, captured at t=0, so the fallback and the animated
 * version are the same character in the same pose. It is what paints before the
 * model arrives, under reduced motion, and forever on a browser without WebGL.
 */
export const FIDDY_MARK_MODEL = '/fiddy-loader.glb';

/** t=0 of `fiddy-loader.glb`, drawn for one frame on a transparent background. */
export const FIDDY_MARK_POSTER = '/fiddy-mark-poster.png';

/** The clip the owner authored; the file ships exactly one. */
export const FIDDY_MARK_CLIP = 'CuteBaby5sLoop';

/** Chrome size, in px — the design's brand slot. */
export const FIDDY_MARK_SIZE = 36;

/**
 * May the mark move?
 *
 * Read before anything is fetched, so a reader who asked for stillness never
 * downloads the model at all. `null` means the browser could not tell us, which
 * is not a reason to deny motion — it is a reason to animate, as everyone else
 * does. Exported pure so the rule is testable without a browser, and so exactly
 * one place decides it.
 */
export const markMotionAllowed = (reducedMotion: boolean | null): boolean =>
  reducedMotion !== true;
