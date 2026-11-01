/**
 * A look someone else shared, read from its link.
 *
 * Three honest states, and no fourth: `loading`, `ready` (with the checked look)
 * or `missing` (with one plain sentence). A link that was never there, a link
 * whose look was removed, and a host that cannot answer all land on `missing`,
 * because from the reader's side those are the same thing: nothing to put on.
 */

import { useEffect, useState } from 'react';

import { readSharedLook } from '~/lib/lookShare';
import { Look } from '~/utils/lookTheme';

export type SharedLook =
  | { state: 'loading' }
  | { state: 'ready'; look: Look }
  | { state: 'missing'; error: string };

export function useSharedLook(id: string | undefined): SharedLook {
  const [shared, setShared] = useState<SharedLook>({ state: 'loading' });

  useEffect(() => {
    if (!id) {
      setShared({ state: 'loading' });
      return;
    }

    let live = true;
    setShared({ state: 'loading' });
    readSharedLook(id).then((result) => {
      if (!live) {
        return;
      }
      setShared(
        result.ok
          ? { state: 'ready', look: result.look }
          : { state: 'missing', error: result.error },
      );
    });

    return () => {
      live = false;
    };
  }, [id]);

  return shared;
}
