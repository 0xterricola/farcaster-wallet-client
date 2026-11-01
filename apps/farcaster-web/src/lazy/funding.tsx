/**
 * The funding surfaces, as chunks of their own.
 *
 * WHY A LAZY BOUNDARY AND NOT A PLAIN IMPORT. The add-funds flow is the only
 * thing in this client that pulls in a Base transfer builder, the browser wallet
 * provider and the miniapp host's SDK, and it is only needed once somebody has
 * decided to add money. Two callers want it — the way in's second step and the
 * wallet page's own address — and neither should carry that weight in its entry
 * chunk for a reader who never opens it.
 *
 * `lazyWithPreload` is the client's own helper (`~/lazy/helpers`), so this is
 * the same mechanism the page routes use: a real chunk, plus a `preload()` a
 * caller can fire on hover or on arrival.
 */

import { lazyWithPreload } from './helpers';

export const LazyFiddyFundingPanel = lazyWithPreload(() =>
  import('~/components/fiddy/FiddyFunding').then((res) => ({
    default: res.FiddyFundingPanel,
  })),
);
