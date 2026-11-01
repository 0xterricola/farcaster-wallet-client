/**
 * The embed classifier, for tests that are not about it.
 *
 * The adapter builds a real classifier by default, and a real classifier asks
 * the network what each embed URL is. A test that reads a recorded node page
 * must not depend on `imagedelivery.net` answering — and must not spend a
 * second per read waiting to find out — so these tests hand the adapter this
 * one instead: answers arrive from a table, or from the URL's own file name,
 * and nothing else is ever asked.
 *
 * A URL with no table entry and no media extension is left unclassified, which
 * is the same thing as "a link card": exactly what the production resolver does
 * when nothing can answer for a URL.
 */

import {
  createEmbedKindResolver,
  type EmbedKindAnswer,
  type EmbedKindResolver,
} from '~/snapchain/nodeApi/embedKinds';

export const offlineEmbedKinds = (
  answers: Record<string, EmbedKindAnswer> = {},
): EmbedKindResolver => {
  const resolver = createEmbedKindResolver({
    storage: null,
    imageProbe: async () => undefined,
    // Nothing is asked of the network, ever. The resolver sees the rejection as
    // "could not ask", which is the honest answer in a test.
    fetchImpl: (async () => {
      throw new TypeError('probes are offline in tests');
    }) as typeof fetch,
  });

  const table = new Map(Object.entries(answers));
  if (table.size === 0) {
    return resolver;
  }

  // A table-backed resolver: the same interface, no network at all.
  return {
    kindOf: (url: string) => table.get(url) ?? resolver.kindOf(url),
    classify: async (urls: Iterable<string>) => {
      const rest = [...urls].filter((url) => !table.has(url));
      await resolver.classify(rest);
    },
    settle: () => resolver.settle(),
  };
};
