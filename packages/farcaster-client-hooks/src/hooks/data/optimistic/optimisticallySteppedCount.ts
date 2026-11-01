/**
 * One step of an optimistic count, or nothing at all when the count has not
 * been read yet.
 *
 * A cast's `reactions` / `recasts` are optional now: the node-backed client
 * paints a feed page before its engagement counts are read (a cold first cast
 * used to wait ~5.5 s for the slowest count on the page), so a cast the reader
 * has only just seen carries no count at all. `count + 1` on that reads as
 * `NaN` in the cache and in the UI, which is a number nobody counted — worse
 * than showing nothing.
 *
 * So an optimistic like on an unread count moves NOTHING: the heart still
 * fills (`viewerContext.reacted`), the number stays absent, and the count the
 * second pass reads is the one that shows. An empty object here merges to a
 * no-op, which is exactly that.
 */
export const optimisticallySteppedCount = ({
  count,
  delta,
}: {
  count: number | undefined;
  delta: number;
}): { count: number } | Record<string, never> => {
  if (typeof count !== 'number') {
    return {};
  }
  return { count: Math.max(0, count + delta) };
};
