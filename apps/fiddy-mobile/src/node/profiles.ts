/**
 * Display names, straight from your node's `userDataByFid`.
 *
 * A read node has no profile index, so a name costs one read per author. This
 * module bounds that (cap + concurrency) and memoises per FID for the process
 * lifetime, which is cheap and honest: no third-party profile API.
 */

import { SnapchainNodeClient } from 'farcaster-node-client';
import { useEffect, useState } from 'react';

export interface Profile {
  fid: number;
  display: string | null;
  username: string | null;
}

const cache = new Map<number, Profile>();

export const loadProfile = async (
  client: SnapchainNodeClient,
  fid: number,
): Promise<Profile> => {
  const cached = cache.get(fid);
  if (cached) {
    return cached;
  }
  const profile: Profile = { fid, display: null, username: null };
  try {
    const page = await client.userDataByFid({ fid, pageSize: 30 });
    // Newest wins: a user can set the same field twice, and the later message
    // is the one the network serves in `latest`.
    const newest: Record<string, number> = {};
    for (const message of page.messages) {
      const body = message.userData;
      if (!body) {
        continue;
      }
      if (body.userDataType === 'USER_DATA_TYPE_DISPLAY') {
        if (!newest.display || message.timestamp > newest.display) {
          profile.display = body.value;
          newest.display = message.timestamp;
        }
      } else if (body.userDataType === 'USER_DATA_TYPE_USERNAME') {
        if (!newest.username || message.timestamp > newest.username) {
          profile.username = body.value;
          newest.username = message.timestamp;
        }
      }
    }
  } catch {
    // A missing profile must never blank the feed — the FID still renders.
  }
  cache.set(fid, profile);
  return profile;
};

/** Profiles for a set of FIDs, fetched with a bounded fan-out. */
export const useProfiles = (
  client: SnapchainNodeClient,
  fids: number[],
): Map<number, Profile> => {
  const key = fids.join(',');
  const [profiles, setProfiles] = useState<Map<number, Profile>>(
    () => new Map(cache),
  );

  useEffect(() => {
    if (fids.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const pending = fids.filter((fid) => !cache.has(fid));
      const workers = new Array(Math.min(5, pending.length)).fill(undefined);
      let cursor = 0;
      await Promise.all(
        workers.map(async () => {
          while (cursor < pending.length) {
            const index = cursor;
            cursor += 1;
            await loadProfile(client, pending[index]);
          }
        }),
      );
      if (!cancelled) {
        setProfiles(new Map(cache));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  return profiles;
};