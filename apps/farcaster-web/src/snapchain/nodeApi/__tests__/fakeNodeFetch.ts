/**
 * A fixture-backed fake Snapchain node.
 *
 * Every fixture in `./fixtures` is a page captured from a live public read node
 * (HTTP `GET /v1/…`, recorded 2026-10-20) — real FIDs, real hashes, real
 * signatures, so the code under test decodes actual node JSON rather than a
 * shape somebody typed by hand.
 *
 * ONE PAGE THEN THE END. A node's `pageSize` is a minimum, not a maximum (a
 * request for 3 can come back with 6), and a page token of `[null,null]` means
 * "nothing after this". The fake therefore answers the first request for a
 * route with the recorded page and every later request for the same route with
 * an empty page and that terminal token — which is what the real node does for
 * an account whose log fits in one page.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;

const read = (name: string): Json =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Json;

/**
 * A page recorded for one specific FID, by the fixture-naming convention
 * (`castsByFid.fid<FID>.json`, `userDataByFid.fid<FID>.json`).
 *
 * These are the accounts a recorded cast mentions: a mention's handle is its own
 * account's user data, so a test that renders mentions has to be able to read
 * those accounts the way a live node answers for them. Anything not recorded
 * still falls through to the fid-3 set and then to empty pages, so a test can
 * never read somebody else's data by accident.
 */
const recordedPageFor = (
  path: string,
  fid: string | null,
): Json | undefined => {
  if (fid === null || !/^\d+$/.test(fid)) {
    return undefined;
  }
  const name =
    path === '/v1/castsByFid'
      ? `castsByFid.fid${fid}.json`
      : path === '/v1/userDataByFid'
        ? `userDataByFid.fid${fid}.json`
        : undefined;
  if (name === undefined || !existsSync(join(__dirname, 'fixtures', name))) {
    return undefined;
  }
  return read(name);
};

/**
 * The hash the recording is about — and so the one hash this origin knows an
 * author for (see `CAST_AUTHOR_PATH`).
 */
const RECORDED_CAST_HASH =
  (read('castById.sample.json') as { hash?: string }).hash ?? '';

/**
 * This origin's own cast→author index, at the path the client asks it on.
 *
 * A shared fiddy.fun cast link is opened by a reader who has served nothing, so
 * `readThread` cannot know whose cast a bare hash is, and asks THIS ORIGIN
 * (`~/snapchain/providers/castAuthorHandoff.ts`). That request goes through the
 * same fetch seam as the node's — the host's CSP is `connect-src 'self'`, and a
 * test that fakes reads must not reach the open web — so the fake answers it
 * too: the recorded cast belongs to the fixture account, fid 3, and any other
 * hash is a 404, which is what the real service answers for a hash no index
 * knows.
 */
export const CAST_AUTHOR_PATH = '/unfurl/cast-author/';

export const TERMINAL_PAGE_TOKEN = 'W251bGwsbnVsbF0=';

export interface FakeNodeRequest {
  path: string;
  params: URLSearchParams;
}

export interface FixtureNodeOptions {
  /**
   * A page the test states, consulted BEFORE the recordings: a case that needs
   * a page the recording does not contain (one account's snaps, or user data
   * for every account in an intersection) has no other way to say so.
   * `undefined` → fall through; a route nothing answers → 404.
   */
  fallback?: (request: FakeNodeRequest) => Json | undefined;
  /** Records every route served, for assertions about what was read. */
  log?: string[];
}

// The recording is one name's proof; the fixture answers with it whatever name
// the client asked for, so it takes no request at all.
const byName = (): Json => read('userNameProofByName.dwr.json') as Json;

/**
 * A `fetch` that speaks the node's own routes, backed by the recorded pages.
 */
export const createFixtureNodeFetch = ({
  fallback,
  log,
}: FixtureNodeOptions = {}) => {
  const served = new Set<string>();

  const route = (request: FakeNodeRequest): Json | undefined => {
    const { path, params } = request;
    const key = `${path}?${params.toString()}`;

    // This origin's cast→author index, not the node's: it is asked by the
    // client's shared-link path through the same seam (see CAST_AUTHOR_PATH).
    if (path.startsWith(CAST_AUTHOR_PATH)) {
      const hash = path.slice(CAST_AUTHOR_PATH.length).toLowerCase();
      return hash === RECORDED_CAST_HASH.toLowerCase()
        ? { hash, fid: 3 }
        : undefined;
    }

    // A request that carries a page token is asking for the page AFTER the
    // recorded one. The recording is one page, so the honest answer is an
    // empty page and a terminal token — never the recorded page again, which
    // would double every counted number (the counters page until they see a
    // terminal token).
    const pageToken = params.get('pageToken');
    if (pageToken !== null && pageToken.length > 0) {
      return { messages: [], nextPageToken: TERMINAL_PAGE_TOKEN };
    }

    // One page per route: later pages are empty and terminal.
    if (served.has(key)) {
      return { messages: [], nextPageToken: TERMINAL_PAGE_TOKEN };
    }

    // A page the test stated wins over the recording below (see
    // `FixtureNodeOptions.fallback`). The page-token and one-page rules above
    // still hold first, so a reader that pages a stated route terminates.
    const stated = fallback?.(request);
    if (stated !== undefined) {
      return stated;
    }

    // The captured pages are one account's (fid 3). Anything else is answered
    // with an empty page rather than with somebody else's data.
    const fidParam = params.get('fid') ?? params.get('target_fid');

    // ...except a page recorded for that exact FID: the accounts a recorded cast
    // mentions, so mentions resolve the way they do on a live node.
    const recorded = recordedPageFor(path, fidParam);
    if (recorded !== undefined) {
      return recorded;
    }

    const isRecordedFid = fidParam === '3' || fidParam === '2';
    const fidScoped = [
      '/v1/userDataByFid',
      '/v1/linksByFid',
      '/v1/linksByTargetFid',
      '/v1/castsByFid',
      '/v1/castsByMention',
      '/v1/verificationsByFid',
    ];
    if (fidScoped.includes(path) && fidParam !== null && !isRecordedFid) {
      return { messages: [], nextPageToken: TERMINAL_PAGE_TOKEN };
    }

    switch (path) {
      case '/v1/userDataByFid':
        return read('userDataByFid.fid3.json');
      case '/v1/linksByFid':
        return read('linksByFid.fid3.follow.json');
      case '/v1/linksByTargetFid':
        return read('linksByTargetFid.fid3.follow.json');
      case '/v1/userNameProofByName':
        return byName();
      case '/v1/verificationsByFid':
        return read('verificationsByFid.fid2.json');
      case '/v1/castsByFid':
        return read('castsByFid.fid3.json');
      case '/v1/castsByMention':
        return read('castsByMention.fid3.json');
      case '/v1/castById':
        return read('castById.sample.json');
      case '/v1/castsByParent': {
        const url = params.get('url') ?? '';
        return url.includes('~/channel/')
          ? read('castsByParent.channel.dev.json')
          : read('castsByParent.sample.json');
      }
      case '/v1/reactionsByCast':
        // The recorded like page, and a recast page derived from it (same
        // recorded envelopes, the reaction type switched) so both readers are
        // tested against pages shaped like the node's own.
        return params.get('reaction_type') === 'Recast'
          ? read('reactionsByCast.recast.sample.json')
          : read('reactionsByCast.sample.json');
      default:
        // Already consulted above, before the recordings.
        return undefined;
    }
  };

  const fakeFetch = async (input: string) => {
    const url = new URL(input, 'http://node.test');
    const params = url.searchParams;
    const key = `${url.pathname}?${params.toString()}`;
    log?.push(`${url.pathname}${url.search}`);

    const body = route({ path: url.pathname, params });
    if (body === undefined) {
      served.add(key);
      return new Response('Not Found', { status: 404 });
    }

    served.add(key);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return fakeFetch as unknown as typeof fetch;
};
