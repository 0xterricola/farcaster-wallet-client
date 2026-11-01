/**
 * The hero Fiddy, as assets and as the rules about when and how it moves.
 *
 * This is the owner's baby mascot (`fiddy-baby.glb`, 572 KB, 35 meshes, the
 * authored 5s loop `CuteBaby5sLoop` baked into the file) — the character the
 * front door shipped first, restored because the vinyl toy that replaced it was
 * a still figure with no rig, which had to be spun by the camera to look alive
 * at all. This one performs on its own: its `HeadGroup` turns toward the
 * pointer, it hops when it is greeted, and the loop does the rest. It is a
 * different file from the 148 KB baby in the chrome on purpose — at 36px the two
 * are indistinguishable, and a mark in a top bar is not worth four times the
 * bytes on every first visit. Both are drawn by the same scene module
 * (`~/components/fiddy/fiddyModelScene`): one three.js setup for the whole app.
 *
 * The still (`fiddy-hero-poster.png`) is one frame of this GLB, rendered by
 * `scripts/render-hero-poster.mjs` at commit time in the same lighting the live
 * canvas uses. It is what paints before the model arrives, under reduced motion,
 * and forever on a browser without WebGL — so no visitor ever meets an empty box
 * where the mascot should be.
 */
export const FIDDY_HERO_MODEL = '/fiddy-baby.glb';

/** One frame of `fiddy-baby.glb`, drawn on a transparent background. */
export const FIDDY_HERO_POSTER = '/fiddy-hero-poster.png';

/** The clip the owner authored; the file ships exactly one, five seconds long. */
export const FIDDY_HERO_CLIP = 'CuteBaby5sLoop';

/** The rig node the pointer turns. A model without it simply does not look. */
export const FIDDY_HERO_HEAD = 'HeadGroup';

/**
 * How far the head turns at full deflection, in radians: a quarter turn of the
 * head's own range, about 14° left or right and 7° up or down. Deliberately
 * small — a character whose head snaps around reads as broken, and this one is
 * looking at a cursor, not following it.
 */
export const FIDDY_HERO_LOOK = { yaw: 0.25, pitch: 0.12 };

/**
 * The loop runs once on arrival and then settles. A mascot that never stops
 * moving is something the eye cannot leave, and this one shares a page with the
 * sentence that has to be read; a pointer move or a greeting wakes it again.
 */
export const FIDDY_HERO_REST_AFTER_MS = 4800;

/**
 * How the camera sits on the hero, as a direction in the model's own frame:
 * nearly straight on, a little to the right and looking slightly down at the
 * face. `scripts/render-hero-poster.mjs` carries the same numbers, and
 * `verify-fiddy-hero.mjs` measures the still it writes against the live canvas —
 * so the two cannot drift apart quietly.
 */
export const FIDDY_HERO_VIEW: [number, number, number] = [0.22, 0.16, 1];

/**
 * How tight the camera is on the model, as a share of the distance that would
 * fit its whole bounding sphere. 0.78 draws the figure across about three
 * quarters of the stage at every width, with room above it for the hop it does
 * when it is greeted — the still is drawn in the rest pose, and a greeting must
 * not push it out of its own box.
 */
export const FIDDY_HERO_PADDING = 0.78;

/**
 * May the hero move?
 *
 * Read before anything is fetched, so a reader who asked for stillness never
 * downloads the model at all. `null` means the browser could not tell us, which
 * is not a reason to deny motion — it is a reason to animate, as everyone else
 * does. Deliberately the same one rule the chrome's mark obeys, from the same
 * place: a second implementation of "is this reader asking for stillness?" is a
 * second answer waiting to disagree.
 */
export { markMotionAllowed as heroMotionAllowed } from './fiddyMark';
