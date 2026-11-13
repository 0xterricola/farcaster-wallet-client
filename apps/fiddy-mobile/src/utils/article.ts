/**
 * The words a reader sees for an article, in one place so the feed row and the
 * article screen cannot disagree.
 *
 * No "premium", no "unlock": an article is a chain of ordinary casts, and an
 * incomplete one says how incomplete it is rather than guessing.
 */

/** "Article · 2 parts" — and no invented count when the chain doesn't state one. */
export const articleLabel = (count: number): string =>
  count > 0
    ? `Article · ${count} ${count === 1 ? 'part' : 'parts'}`
    : 'Article';

/** What an incomplete chain says, with both numbers stated. */
export const incompleteCopy = (loaded: number, count: number): string =>
  `This looks incomplete: ${loaded} of ${count} parts loaded`;

/** What a chain whose read failed says: the parts that arrived are still shown. */
export const chainFailedCopy = 'part of an article; the rest did not load';
