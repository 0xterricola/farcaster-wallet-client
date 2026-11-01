/**
 * The two strings this client writes into cast bodies, and the cheapest
 * possible answer to "is this one of them?".
 *
 * Deliberately tiny and dependency-free: the cast renderer imports this module
 * on every cast, so it must carry no crypto, no curve maths and no price lookup.
 * The real envelope reader (`envelope.ts`) re-exports these names, so there is
 * one definition of each prefix.
 */

export const SEALED_CAST_PREFIX = 'fdy-seal-1:';
export const SEALED_KEY_PREFIX = 'fdy-key-1:';

/** Does this cast body hold a sealed cast? */
export const isSealedCastBody = (text: string): boolean =>
  text.trim().startsWith(SEALED_CAST_PREFIX);

/** Every candidate key-share string in a body — shape only, not validity. */
export const keyShareCandidates = (text: string): string[] =>
  text.match(/fdy-key-1:[A-Za-z0-9_-]+/g) ?? [];
