/**
 * The one place this client loads its sealed-cast and price code from.
 *
 * Both are pulled in by `import()` — never by a static import from a surface that
 * renders in a feed — because the main bundle is already large and a reader
 * scrolling past a cashtag, or a cast with no sealed content in it at all, must
 * not pay for either. `scripts/verify-mask-surfaces.mjs` checks the built
 * bundles for exactly that.
 */
export const loadSealedKeys = () => import('~/lib/sealed/keys');

export const loadSealedCasts = () => import('~/lib/sealed/sealedCast');

export const loadSealedEnvelope = () => import('~/lib/sealed/envelope');

export const loadTokenPrice = () => import('~/lib/tokens/price');
