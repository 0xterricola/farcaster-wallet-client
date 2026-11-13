#!/usr/bin/env node
/**
 * A dev proxy for the screenshots in `evidence/article-*.png`.
 *
 * It is not a fake node: every read it answers with data goes to the same live
 * Snapchain read node the app would use (`UPSTREAM`, default the public
 * Hypersnap node, mainnet, v0.17.7 — a node that carries the article fields).
 * Three things are deliberately shaped, all of them stated here so the
 * screenshots are not mistaken for a live-network capture:
 *
 *   1. `linksByFid` answers with nobody followed, so the feed is one account's
 *      casts instead of a few hundred reads. Set `FIDDY_STUB_FOLLOWS=1` to pass
 *      the follow graph through.
 *   2. `--incomplete` drops the later parts of any article chain it serves, so
 *      the "This looks incomplete: 1 of 2 parts loaded" copy can be photographed.
 *   3. `--fail-chain` answers a chain read (`startTimestamp`) with a 500, so the
 *      "part of an article; the rest did not load" copy can be photographed.
 *
 * Usage (from apps/fiddy-mobile):
 *   node tools/articleStubNode.mjs [--incomplete|--fail-chain] [--port 8791]
 *   EXPO_PUBLIC_FIDDY_NODE_URL=http://127.0.0.1:8791 EXPO_PUBLIC_FIDDY_FID=1 npx expo start
 */

import http from 'node:http';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const PORT = Number(value('--port', '8791'));
const UPSTREAM = process.env.UPSTREAM ?? 'https://haatz.quilibrium.com';
const MODE = flag('--incomplete')
  ? 'incomplete'
  : flag('--fail-chain')
    ? 'fail-chain'
    : 'complete';
const PASS_FOLLOWS = process.env.FIDDY_STUB_FOLLOWS === '1';

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

const upstream = async (path) => {
  const response = await fetch(`${UPSTREAM}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${UPSTREAM}${path} answered ${response.status}`);
  }
  return response.json();
};

/** Keep the root of a chain and drop every later part (what an incomplete read looks like). */
const trimChain = (page) => {
  const messages = (page.messages ?? []).filter((message) => {
    const chain = message.data?.castAddBody?.chain;
    return !chain || !chain.root;
  });
  return { ...page, messages, nextPageToken: undefined };
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = `${url.pathname}${url.search}`;
  try {
    if (url.pathname === '/v1/linksByFid' && !PASS_FOLLOWS) {
      // Nobody followed: one account's casts make a small, honest feed.
      send(res, 200, { messages: [] });
      return;
    }
    if (
      url.pathname === '/v1/castsByFid' &&
      url.searchParams.has('startTimestamp') &&
      MODE !== 'complete'
    ) {
      if (MODE === 'fail-chain') {
        send(res, 500, {
          message: 'the chain read was made to fail for this screenshot',
        });
        return;
      }
      send(res, 200, trimChain(await upstream(path)));
      return;
    }
    send(res, 200, await upstream(path));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[stub] ${path}: ${error instanceof Error ? error.message : error}`,
    );
    send(res, 502, { message: String(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[stub] ${MODE} mode on http://127.0.0.1:${PORT} → ${UPSTREAM}`);
});
