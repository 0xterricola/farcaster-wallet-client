import { useNonSuspenseUserByFid } from 'farcaster-client-hooks';
import { useCallback, useState } from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { useCachedCurrentUser } from '~/hooks/data/useCachedCurrentUser';
import {
  liftMute,
  type MuteKind,
  untilText,
} from '~/snapchain/mutePreferences';
import { useMutePreferences } from '~/snapchain/useMutePreferences';
import { trackError } from '~/utils/errorUtils';
import { toast } from '~/utils/toast';

/**
 * People this account hides, in the account's own list.
 *
 * WHY THIS IS NOT THE HOSTED LISTS: `/v2/get-muted-users` and
 * `/v2/farcaster/mute/list` are reads only an index can answer, and a
 * node-backed build refuses them in its own words ("a node keeps no mute
 * list"). The list that actually hides somebody — the one the read seam
 * consults while it assembles a feed — is this browser's, per account, so this
 * is where a reader can see it and lift it. The settings entries beside it still
 * show whatever the configured provider can answer, which on a node-backed build
 * is the refusal, honestly stated.
 */
const HiddenPersonRow = ({
  targetFid,
  kind,
}: {
  targetFid: number;
  kind: Extract<MuteKind, 'users' | 'blocks'>;
}) => {
  const viewerFid = useCachedCurrentUser()?.fid;
  const { data } = useNonSuspenseUserByFid({ fid: targetFid });
  const [busy, setBusy] = useState(false);

  const user = data?.result?.user;
  const name = user?.username ? `@${user.username}` : `account ${targetFid}`;

  const showAgain = useCallback(async () => {
    if (viewerFid === undefined) {
      return;
    }
    setBusy(true);
    try {
      await liftMute({ fid: viewerFid, kind, value: targetFid });
      toast({ message: `${name} can appear again`, position: 'bottom-center' });
    } catch (error) {
      trackError(error);
      toast({
        message: 'Failed, please try again',
        type: 'error',
        position: 'bottom-center',
      });
    } finally {
      setBusy(false);
    }
  }, [kind, name, targetFid, viewerFid]);

  return (
    <div className="flex flex-row items-center px-4 py-2">
      <div className="flex w-full flex-row items-center">
        <span className="w-auto overflow-hidden text-ellipsis">{name}</span>
        <span className="ml-2 text-sm text-faint">
          {kind === 'blocks' ? 'blocked' : 'hidden'}
        </span>
      </div>
      <DefaultButton
        onClick={() => void showAgain()}
        disabled={busy}
        variant="secondary"
      >
        Show again
      </DefaultButton>
    </div>
  );
};

/** The rows, one per live entry, with the end of each timed one named. */
export const HiddenPeopleList = () => {
  const fid = useCachedCurrentUser()?.fid;
  const mutes = useMutePreferences(fid);

  const rows = [
    ...(mutes?.blocks ?? []).map((entry) => ({
      targetFid: entry.v,
      kind: 'blocks' as const,
      until: entry.until,
    })),
    ...(mutes?.users ?? []).map((entry) => ({
      targetFid: entry.v,
      kind: 'users' as const,
      until: entry.until,
    })),
  ];

  return (
    <div className="mb-4 flex flex-col" data-fiddy="hidden-people">
      <span className="mb-2 font-semibold">People you&#39;ve hidden</span>
      <div className="-mx-4 mb-2 border-b px-4 pb-4 text-muted border-default">
        <p>
          Their posts stay out of your feed and your notifications. Hiding
          somebody does not stop them seeing you; blocking does.
        </p>
      </div>
      <div className="-mx-4 flex flex-col">
        {rows.length === 0 ? (
          <div className="w-full text-center text-faint">Nobody hidden yet</div>
        ) : (
          rows.map((row) => (
            <div
              key={`${row.kind}:${row.targetFid}`}
              data-fiddy="hidden-person"
            >
              <HiddenPersonRow targetFid={row.targetFid} kind={row.kind} />
              {untilText(row.until) !== '' && (
                <div
                  className="px-4 pb-2 text-sm text-faint"
                  data-fiddy="hidden-person-until"
                >
                  {untilText(row.until)}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
