/**
 * A feed page says which app made each cast, and the reader's filter narrows the
 * page by exactly that.
 *
 * The attribution is protocol-native: the signer record's signed key request
 * names the app FID, and that app account's own profile names the app
 * (`farcaster-node-client`'s `clientAttribution`). These tests drive the real
 * page read through the fixture node (`fakeNodeFetch`) and state only the two
 * pages a recording cannot contain — the signer records and the app's profile —
 * so what is measured is the seam's own behaviour, not a stub of it:
 *
 *   - every cast on the page carries the app that really signed it,
 *   - "hide this app" removes those casts from the page,
 *   - "only this app" keeps exactly them,
 *   - a key this client's own app asked for reads as this client.
 */

import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { NodeBackedReads } from '~/snapchain/nodeApi';
import {
  createEmbedCardResolver,
  type EmbedCardResolver,
} from '~/snapchain/nodeApi/embedCards';
import type { EmbedKindResolver } from '~/snapchain/nodeApi/embedKinds';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import {
  createFixtureNodeFetch,
  type FakeNodeRequest,
  TERMINAL_PAGE_TOKEN,
} from './fakeNodeFetch';

const NODE = 'http://node.test';

/** FID 9152 is the account Warpcast's own posts are signed by. */
const WARPCAST_APP_FID = 9152;
/** This client's own app FID, standing in for `THIS_CLIENT_APP_FID`. */
const THIS_APP_FID = 3356372;

/** The card resolver a test uses: it asks nothing, and says so. */
const offlineEmbedCards = (): EmbedCardResolver =>
  createEmbedCardResolver({
    storage: null,
    fetchImpl: (async () => {
      throw new TypeError('probes are offline in tests');
    }) as typeof fetch,
  });

/**
 * The pages a recording cannot hold: which app asked for each signing key, and
 * what that app calls itself. Everything else comes from the recorded node
 * pages.
 */
const statedPages =
  ({
    appFid,
    username,
    displayName,
  }: {
    appFid: number;
    username: string;
    displayName: string;
  }) =>
  ({ path, params }: FakeNodeRequest) => {
    if (path === '/v1/signer') {
      const fid = Number(params.get('fid'));
      const key = params.get('signer') ?? '';
      if (!Number.isSafeInteger(fid) || key.length === 0) {
        return undefined;
      }
      return {
        signer: {
          source: 'farcaster',
          key,
          fid,
          requestFid: appFid,
          nonce: 0,
          addedAt: 1,
        },
      };
    }
    if (path === '/v1/userDataByFid' && params.get('fid') === String(appFid)) {
      return {
        messages: [
          {
            data: {
              type: 'MESSAGE_TYPE_USER_DATA_ADD',
              fid: appFid,
              timestamp: 1,
              network: 'FARCASTER_NETWORK_MAINNET',
              userDataBody: {
                type: 'USER_DATA_TYPE_USERNAME',
                value: username,
              },
            },
            hash: '0xfeed',
            hashScheme: 'HASH_SCHEME_BLAKE3',
            signature: '',
            signatureScheme: 'SIGNATURE_SCHEME_ED25519',
            signer: '0xapp',
          },
          {
            data: {
              type: 'MESSAGE_TYPE_USER_DATA_ADD',
              fid: appFid,
              timestamp: 2,
              network: 'FARCASTER_NETWORK_MAINNET',
              userDataBody: {
                type: 'USER_DATA_TYPE_DISPLAY',
                value: displayName,
              },
            },
            hash: '0xbeef',
            hashScheme: 'HASH_SCHEME_BLAKE3',
            signature: '',
            signatureScheme: 'SIGNATURE_SCHEME_ED25519',
            signer: '0xapp',
          },
        ],
        nextPageToken: TERMINAL_PAGE_TOKEN,
      };
    }
    if (path === '/v1/reactionsByFid') {
      return { messages: [], nextPageToken: TERMINAL_PAGE_TOKEN };
    }
    return undefined;
  };

interface ReaderOptions {
  /** What this client's own app FID is (Fiddy's, in the app). */
  thisAppFid?: number;
  /** The filter the reader has set, read at page time like the app does. */
  clientFilter?: () => ClientFilterPolicyForTest | undefined;
}

interface ClientFilterPolicyForTest {
  mode: 'all' | 'only' | 'exclude';
  clientIds: string[];
}

const readerFor = ({
  appFid = WARPCAST_APP_FID,
  username = 'warpcast',
  displayName = 'Warpcast',
  readerOptions = {},
}: {
  appFid?: number;
  username?: string;
  displayName?: string;
  readerOptions?: ReaderOptions;
} = {}): NodeBackedReads => {
  const fetchImpl = createFixtureNodeFetch({
    fallback: statedPages({ appFid, username, displayName }),
  });
  return new NodeBackedReads({
    node: new SnapchainNodeClient({
      baseUrl: NODE,
      fetch: fetchImpl as unknown as FetchLike,
    }),
    nodeBaseUrl: NODE,
    fetchImpl,
    embedKinds: offlineEmbedKinds() as EmbedKindResolver,
    embedCards: offlineEmbedCards(),
    getSignedInFid: () => 3,
    ...(readerOptions.thisAppFid === undefined
      ? {}
      : { thisAppFid: readerOptions.thisAppFid }),
    ...(readerOptions.clientFilter === undefined
      ? {}
      : { clientFilter: readerOptions.clientFilter }),
  });
};

const readHome = async (reads: NodeBackedReads) =>
  reads.readFeed({ feedKey: 'home', updateState: false });

describe('a feed page says which app made each cast', () => {
  it('labels every cast with the app account that requested its signing key', async () => {
    const page = await readHome(readerFor());

    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.cast.client).toBeDefined();
      expect(item.cast.client?.clientId).toBe(`app:${WARPCAST_APP_FID}`);
      // The name is the app account's own profile, never a vendor name this
      // repo invented.
      expect(item.cast.client?.displayName).toBe('Warpcast');
      expect(item.cast.client?.username).toBe('warpcast');
      expect(item.cast.client?.kind).toBe('known');
    }
  });

  it('reads a cast signed by this client’s own app key as this client', async () => {
    const page = await readHome(
      readerFor({
        appFid: THIS_APP_FID,
        username: 'fiddy-one',
        displayName: 'fiddy one',
        readerOptions: { thisAppFid: THIS_APP_FID },
      }),
    );

    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.cast.client?.kind).toBe('self');
      expect(item.cast.client?.clientId).toBe('self');
      expect(item.cast.client?.displayName).toBe('Fiddy');
    }
  });

  it('reads a cast whose key the account asked for itself as no app at all', async () => {
    // The fixture casts are fid 3's, so an app FID of 3 is the self-requested
    // case — and the stated profile is there to catch the failure measured on
    // live: naming the AUTHOR's own profile as if it were the client.
    const page = await readHome(
      readerFor({ appFid: 3, username: 'dwr', displayName: 'Dan Romero' }),
    );

    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.cast.client?.kind).toBe('own');
      expect(item.cast.client?.clientId).toBe('own');
      expect(item.cast.client?.displayName).toBe('their own key');
    }
  });

  it('carries no client at all when the node cannot name the signer', async () => {
    // No stated signer page: the fake answers 404 for /v1/signer, which is a
    // real answer ("this node has no such key"), not a broken read.
    const fetchImpl = createFixtureNodeFetch();
    const reads = new NodeBackedReads({
      node: new SnapchainNodeClient({
        baseUrl: NODE,
        fetch: fetchImpl as unknown as FetchLike,
      }),
      nodeBaseUrl: NODE,
      fetchImpl,
      embedKinds: offlineEmbedKinds() as EmbedKindResolver,
      embedCards: offlineEmbedCards(),
      getSignedInFid: () => 3,
    });

    const page = await readHome(reads);

    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      // No label beats a guessed one: the field is absent.
      expect(item.cast.client).toBeUndefined();
    }
  });
});

describe('the reader’s client filter narrows a feed by that attribution', () => {
  it('hides the casts of an app the reader excluded', async () => {
    const page = await readHome(
      readerFor({
        readerOptions: {
          clientFilter: () => ({
            mode: 'exclude',
            clientIds: [`app:${WARPCAST_APP_FID}`],
          }),
        },
      }),
    );

    expect(page.items).toHaveLength(0);
  });

  it('keeps only the casts of an app the reader asked for', async () => {
    const unfiltered = await readHome(readerFor());
    const only = await readHome(
      readerFor({
        readerOptions: {
          clientFilter: () => ({
            mode: 'only',
            clientIds: [`app:${WARPCAST_APP_FID}`],
          }),
        },
      }),
    );

    expect(only.items).toHaveLength(unfiltered.items.length);
    for (const item of only.items) {
      expect(item.cast.client?.clientId).toBe(`app:${WARPCAST_APP_FID}`);
    }
  });

  it('shows everything when the reader has no filter', async () => {
    const unfiltered = await readHome(readerFor());
    const all = await readHome(
      readerFor({ readerOptions: { clientFilter: () => undefined } }),
    );

    expect(all.items.length).toBe(unfiltered.items.length);
  });
});
