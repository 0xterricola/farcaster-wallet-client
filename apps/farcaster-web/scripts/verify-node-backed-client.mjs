// End-to-end check that a signed-in client reads its surfaces from a server it
// can actually reach — and that what it shows came back from that server.
//
//   node scripts/verify-node-backed-client.mjs
//
// Requires a dev server pointed at a live read node. Both routes are legitimate
// and both are measured here:
//
//   SNAPCHAIN_HTTP_URL=https://<node> npx vite --port 5174
//   NODE_BACKED_SERVER=https://localhost:5174 node scripts/verify-node-backed-client.mjs
//
//   NODE_BACKED_RELAY_TARGET=https://<node>   (optional: named in the report)
//
// `NODE_BACKED_ISOLATE=1` puts every *other* server the provider chain could
// fall back to out of reach (Farcaster's own public server, Neynar, the public
// read node), leaving the build's own relay as the only route. That is the
// fail-capability case: a signed-in client with no server that answers must
// fail these checks, and the run must still print its report. MEASURED
// (2026-10-21): without isolation, a relay pointed at a black-holed node is not
// a failure at all — the chain moves to a node that answers and the feed fills
// with real casts, which is the chain behaving correctly, not the probe being
// green for no reason.
//
// MEASURED in that isolated case (5176 → the black-holed
// `http://34.101.47.167:3381`, every other server aborted at the browser):
// **4/12, exit 1** — every read the page attempted threw, no cast text reached
// the DOM, and the four checks that do not depend on a read still passed. The
// feed column did not carry the client's own "did not load from your node"
// sentence in that run; what this client says when a node never answers is
// measured by `verify-dead-node-feed.mjs`, and this probe does not restate it.
//
// Only the SIWF relay is stubbed, and it is stubbed with a REAL SIWE message
// signed by a throwaway key, so the app's own verifier accepts the sign-in for
// real. The FID the stubbed relay names is 3 (`dwr`) — a real, active account —
// because the point of this probe is that real casts come back from a node, and
// an invented FID has no follow graph to read. Nothing here writes: the whole
// probe is reads.
//
// WHAT CHANGED, AND WHY (re-pointed 2026-10-21)
// The provider chain (`~/snapchain/providers`) moved *where reads come from* out
// of this probe's assumptions. A signed-in client no longer reads through one
// fixed route: its fetch seam answers from whichever server the failover engine
// measured as live, and that server has an address of its own — so a read may
// leave the page as `https://<node>/v1/castsByFid…` (the provider's own origin)
// or as `<this origin>/snapchain-api/v1/castsByFid…` (the build's relay to the
// node it was configured with). The previous revision demanded the relay path
// and failed 7 of its 11 checks on a client that was working; it was measuring
// its own expectation, not the client.
//
// So this revision asserts what still matters and attributes every read:
//
//   1. a completed sign-in lands in the CLIENT (not the setup, not the
//      device-only landing that says nothing can load here)
//   2. the home feed renders cast text that came back from a server the client
//      read from — the text is compared against the bytes that server returned,
//      so an empty or foreign feed cannot pass
//   3. the feed's cast reads went to a server this client can read from (a
//      Snapchain node: the provider's own origin, or this build's relay)
//   4. the feed is not an error page, and the rail still says what a read node
//      cannot do (direct messages)
//   5. a cast detail opens and shows the thread it read
//   6. a profile page renders and names the account, with its reads attributed
//   7. a channel page renders and answers — never an empty success
//   8. notifications are derived from a node read, not from a refusal
//   9. no surface has fallen back to generic error copy
//  10. after a reload the client still reads the feed from the server it named —
//      the check that flips on a live node, so when it fails its detail names the
//      surface's own state (the column's panel, or the fork's copy) and the read
//      that did not answer, and the reload document's own reads are reported
//  11. the client's own words about which server is answering, and every route
//      it used, are reported with the statuses — evidence, not a verdict
//
// MEASURED (2026-10-21), and deliberately not hidden here: the failover engine
// can land the reader on `farcaster-public`, which a browser cannot read
// cross-origin (api.farcaster.xyz sends no CORS header for these paths, so every
// read through it throws `TypeError: Failed to fetch`). When that happens the
// affected surface is replaced by the client's own sentence — "This page didn't
// load from your node · Farcaster's own public server did not answer" — and this
// probe fails that surface, as it should. Because such a surface still renders
// correctly on a fresh load (a cold client reads from its first choice until the
// first measurement lands), the probe re-opens a surface that ended in that
// panel exactly once, and says so in the check's detail. The retry is a
// measurement, not a tolerance: the panel is the client admitting a read failed.
//
// Screenshots land in $NODE_BACKED_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.NODE_BACKED_SERVER ?? 'https://localhost:5174';
const DOMAIN = new URL(SERVER).host;
const PAGE_ORIGIN = new URL(SERVER).origin;
const RELAY_TARGET = process.env.NODE_BACKED_RELAY_TARGET ?? null;
const ISOLATE = process.env.NODE_BACKED_ISOLATE === '1';
const OUT = process.env.NODE_BACKED_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'NODEBACK1';
const SIGNED_IN_FID = 3;
const CHANNEL = 'dev';

/** Every other server the provider chain could fall back to, for isolation. */
const OTHER_SERVERS = [
  'https://api.farcaster.xyz/**',
  'https://api.neynar.com/**',
  'https://snapchain-api.neynar.com/**',
  'https://haatz.quilibrium.com/**',
  'http://34.101.47.167:**',
];

/** How long a surface may take to read a real node before the check gives up. */
const FEED_BUDGET_MS = 90_000;
const SURFACE_BUDGET_MS = 45_000;
const RELOAD_BUDGET_MS = 60_000;

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SERVER}/login`,
  version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

// ── which server a read left for ────────────────────────────────────────────
//
// A read is named by the machine that answered it, because that is the only
// claim this probe is entitled to make. The three third-party origins are named
// as the providers they are; any other absolute origin is a node (that is what
// the client's own catalog is made of — `snapchain:<url>`).

const THIRD_PARTY = {
  'api.farcaster.xyz': 'Farcaster’s own public server (the farcaster-public provider)',
  'api.neynar.com': 'Neynar (the neynar provider)',
};

const parseRead = (entry) => {
  let parsed;
  try {
    parsed = new URL(entry.url, SERVER);
  } catch {
    return { ...entry, path: entry.url, serverKey: 'unparseable', server: `unparseable ${entry.url}`, nodeRoute: null };
  }
  const relayPath = parsed.pathname.startsWith('/snapchain-api');
  const path = relayPath ? parsed.pathname.replace(/^\/snapchain-api/, '') : parsed.pathname;

  let serverKey;
  let server;
  if (relayPath) {
    serverKey = 'relay';
    server = `this build’s relay (${PAGE_ORIGIN}/snapchain-api${
      RELAY_TARGET ? ` → ${RELAY_TARGET}` : ''
    })`;
  } else if (parsed.origin === PAGE_ORIGIN) {
    serverKey = 'app';
    server = 'this app itself (not a read node)';
  } else if (THIRD_PARTY[parsed.hostname]) {
    serverKey = parsed.hostname;
    server = THIRD_PARTY[parsed.hostname];
  } else if (/^\/v1\/[A-Za-z]+/.test(parsed.pathname)) {
    // A protocol route answered at an absolute origin can only be a Snapchain
    // node: the client's own catalog is made of them (`snapchain:<url>`), and
    // nothing else in this app speaks `/v1/castsByFid…`.
    serverKey = `node:${parsed.origin}`;
    server = `the node at ${parsed.origin}`;
  } else {
    // MEASURED (2026-10-21): the page also calls origins that are not read
    // servers at all — `api.web3modal.org`, `pulse.walletconnect.org` (the
    // wallet kit), `ph.neynar.com` (an unset analytics placeholder) and an ENS
    // gateway. Naming those "the node at …" was a lie the report told, so they
    // get a bucket of their own and no check accepts them.
    serverKey = `other:${parsed.origin}`;
    server = `an unrelated origin the page called (not a read server): ${parsed.origin}`;
  }

  const nodeRoute = /^\/v1\/[A-Za-z]+/.exec(path)?.[0] ?? null;
  return {
    ...entry,
    path,
    serverKey,
    server,
    // Only a Snapchain node answers the protocol's own routes; a third-party
    // provider answering `/v1/...` would be a different machine wearing the
    // same path, which is exactly why the server is reported next to the route.
    nodeRoute: serverKey === 'relay' || serverKey.startsWith('node:') ? nodeRoute : null,
  };
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
};

const isNodeServer = (key) => key === 'relay' || key.startsWith('node:');
const describeServers = (reads) => {
  const byServer = new Map();
  for (const read of reads) {
    const entry = byServer.get(read.serverKey) ?? { server: read.server, calls: 0, statuses: new Set() };
    entry.calls += 1;
    entry.statuses.add(read.status);
    byServer.set(read.serverKey, entry);
  }
  return [...byServer.values()]
    .map((e) => `${e.server} ×${e.calls} (${[...e.statuses].sort().join('/')})`)
    .join('; ');
};

/**
 * Read the surface, tolerating a page that is mid-navigation.
 *
 * MEASURED (2026-10-21, under load): a read taken while the client is still
 * swapping routes throws `Execution context was destroyed, most likely because
 * of a navigation` and takes the whole probe down with it — the checks it was
 * about to make never run. A destroyed execution context is retried; anything
 * else still throws.
 */
const readSurface = async (page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await page.evaluate(surfaceProbe);
    } catch (error) {
      if (!/Execution context was destroyed|Target closed|navigat|Cannot read properties of null/.test(String(error))) {
        throw error;
      }
      await page.waitForTimeout(250);
    }
  }
  return { path: '', text: '', castLinks: [] };
};

const surfaceProbe = () => {
  // MEASURED (2026-10-21): mid-navigation `document.body` is null for a frame,
  // and reading `.innerText` off it took the whole run down at the cast-detail
  // step — after sign-in and the feed had already been measured. An empty body
  // is an empty reading, not a crash.
  const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main');
  return {
    path: window.location.pathname,
    text,
    // The page column's own words, without the rail and the top bar.
    //
    // MEASURED (2026-10-21): a whole-document predicate is satisfied by the
    // RAIL — its `Notifications` item made the notifications surface look like
    // it had answered while the column had rendered and read nothing, and the
    // profile surface could be "answered" by a rail word. `main` is the column
    // (the sibling dead-node probe reads it the same way); a layout with no
    // `main` is reported as such and the callers fall back to the whole page.
    columnText: (main?.innerText ?? '').replace(/\s+/g, ' ').trim(),
    columnPresent: Boolean(main),
    onboardingSheet: Boolean(document.querySelector('[data-fiddy="onboarding"]')),
    deviceOnlyLanding: Boolean(
      document.querySelector('[data-fiddy="device-only-session"]'),
    ),
    dmsUnavailable: Boolean(document.querySelector('[data-fiddy="dms-unavailable"]')),
    dmsNoteText: /direct casts\s+soon/i.test(text),
    /**
     * The client's own answer for a read it could not complete. That is a
     * refusal to render, and it is never mistaken for content: it names the
     * server that did not answer, which is the honest report this client makes.
     */
    cannotAnswer:
      /didn[’']t load from your node|isn[’']t on your node|could not be loaded from your node/i.test(
        text,
      ),
    /** The fork's own copy — the sentence the fixes above exist to replace. */
    genericError: /Could not reach Farcaster|Error retrieving data|Something went wrong/i.test(
      text,
    ),
    castLinks: Array.from(document.querySelectorAll('a[href*="/conversations/"]'))
      .map((a) => a.getAttribute('href'))
      .slice(0, 12),
  };
};

/**
 * Take a screenshot without letting it end the run.
 *
 * MEASURED (2026-10-21, machine at load average ~230): `page.screenshot` waits
 * for fonts to load and throws `Timeout 30000ms exceeded` — the probe died
 * before a single check was printed, so a screenshot nobody asked for took the
 * whole measurement down with it. The screenshots are evidence, not the result:
 * a failed one is reported and the checks carry on.
 */
const shot = async (page, name) => {
  try {
    await page.screenshot({
      path: `${OUT}/node-backed-${name}.png`,
      timeout: 20_000,
      animations: 'disabled',
    });
  } catch (error) {
    console.log(`(screenshot ${name} skipped: ${String(error).split('\n')[0]})`);
  }
};

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  // Out of reach, so the build's own route is the only one left — see the note
  // on `NODE_BACKED_ISOLATE` at the top of this file.
  const blocked = [];
  if (ISOLATE) {
    for (const pattern of OTHER_SERVERS) {
      await ctx.route(pattern, (route) => {
        blocked.push(route.request().url());
        return route.abort();
      });
    }
  }

  // Every call that leaves the page through `window.fetch`, with the status it
  // came back with. A read is attributed to the machine in its URL — see
  // `parseRead` — so this log is the evidence of which server answered what.
  await ctx.addInitScript(() => {
    const original = window.fetch;
    window.__providerReadLog = [];
    window.fetch = async (...args) => {
      const url =
        typeof args[0] === 'string'
          ? args[0]
          : (args[0] && args[0].url) || String(args[0]);
      const method = ((args[1] && args[1].method) || 'GET').toUpperCase();
      const started = Date.now();
      try {
        const response = await original(...args);
        window.__providerReadLog.push({
          method,
          status: response.status,
          url: String(url),
          ms: Date.now() - started,
        });
        return response;
      } catch (error) {
        window.__providerReadLog.push({
          method,
          status: 'THREW',
          url: String(url),
          ms: Date.now() - started,
          error: String(error).slice(0, 120),
        });
        throw error;
      }
    };
  });

  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 240));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 240)}`));

  /**
   * The casts a server actually returned, with the server that returned them.
   * Captured from every route — the provider's own origin AND this build's
   * relay — so the DOM can be checked against real bytes rather than against
   * "some text rendered", whichever route the client chose.
   */
  const servedCasts = [];
  /**
   * Every protocol read the *network* saw, with how it ended — a second lens,
   * independent of the page's own log.
   *
   * MEASURED (2026-10-21, 5175 with the relay on a refused port): after the
   * client navigates during sign-in, `window.__providerReadLog` starts empty in
   * the new document while the reads that filled an already-rendered feed were
   * served in the old one. The feed check then read "no cast read left the
   * page; 0 reads total" on a run whose feed was full of casts a node had just
   * returned — a false failure about the probe's own lens, not about the
   * client. Attribution therefore accepts either lens, and says which one.
   */
  const netSeen = [];
  page.on('response', async (response) => {
    const read = parseRead({ url: response.url(), method: 'GET', status: response.status() });
    if (read.nodeRoute) netSeen.push(read);
    if (read.serverKey === 'app' || !/^\/v1\/(castsByFid|castsByParent|castById)$/.test(read.path)) {
      return;
    }
    if (response.status() !== 200) return;
    try {
      const body = await response.json();
      for (const msg of body.messages ?? []) {
        const text = msg?.data?.castAddBody?.text;
        if (typeof text === 'string' && text.trim().length > 12) {
          servedCasts.push({ text, hash: msg.hash, fid: msg.data?.fid, route: read.path, status: response.status(), server: read.server, serverKey: read.serverKey });
        }
      }
    } catch {
      /* the read is still reported through the fetch log */
    }
  });

  const readLog = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return (await page.evaluate(() => window.__providerReadLog ?? [])).map(parseRead);
      } catch (error) {
        // Same mid-navigation window as `readSurface`: a log that cannot be read
        // yet is retried, never allowed to end the run.
        if (!/Execution context was destroyed|Target closed|navigat|Cannot read properties of null/.test(String(error))) {
          throw error;
        }
        await page.waitForTimeout(250);
      }
    }
    return [];
  };

  const seen = [];

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    if (method === 'POST') {
      return route.fulfill({
        status: 201,
        headers: CORS,
        body: JSON.stringify({
          channelToken: CHANNEL_TOKEN,
          url: `https://farcaster.xyz/~/siwf?channelToken=${CHANNEL_TOKEN}`,
          nonce: NONCE,
        }),
      });
    }
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        state: 'completed',
        nonce: NONCE,
        message,
        signature,
        fid: SIGNED_IN_FID,
        username: 'dwr',
        displayName: 'dwr',
      }),
    });
  });

  const onScreen = (haystack, text) => {
    const needle = text.replace(/\s+/g, ' ').trim().slice(0, 30);
    return needle.length > 12 && haystack.includes(needle);
  };
  /** The page column when there is one; the whole page when the layout has none. */
  const columnOf = (surface) =>
    surface.columnPresent && surface.columnText ? surface.columnText : surface.text;
  /**
   * The refusal sentence a piece of surface text carries — the client's own
   * panel, or the fork's generic copy that panel replaces.
   *
   * MEASURED (2026-10-21, review round 1 and this revision's own 9/12 run): the
   * reload check's failure detail named the node it had read from and left out
   * the sentence the reader was actually looking at, while the column carried the
   * client's own refusal for the whole budget and well past it. Which surface
   * said it matters: on that 9/12 run the only refusal on the page was the RAIL's
   * Explore panel ("Cmd+K Explore didn't load from your node …") while the column
   * under test said nothing — so the column is asked first and the rest of the
   * page is reported separately, never conflated. Sentences are split on `[.!?]`
   * followed by space, not on every period, so `haatz.quilibrium.com` survives.
   */
  const CLIENT_PHRASE =
    /didn[’']t load from your node|isn[’']t on your node|could not be loaded from your node/i;
  const FORK_COPY = /Could not reach Farcaster|Error retrieving data|Something went wrong/i;
  const refusalSentence = (text) => {
    for (const sentence of String(text ?? '').split(/(?<=[.!?])\s+/)) {
      if (CLIENT_PHRASE.test(sentence) || FORK_COPY.test(sentence)) {
        return sentence.replace(/\s+/g, ' ').trim().slice(0, 220);
      }
    }
    return null;
  };
  /** The labelled sentence, or null when that text carries no refusal at all. */
  const wordsFor = (text) => {
    const sentence = refusalSentence(text);
    if (!sentence) return null;
    return `${FORK_COPY.test(sentence) ? 'the fork’s generic copy' : 'the client’s own panel'}: "${sentence}"`;
  };
  /** Casts a server returned whose text is in the COLUMN the reader is looking at. */
  const matchedCasts = (surface) =>
    servedCasts.filter((cast) => onScreen(columnOf(surface), cast.text));

  const inClient = (surface) =>
    !surface.onboardingSheet && !surface.deviceOnlyLanding && surface.path === '/';

  /**
   * Poll a surface until it answers. `done` decides what "answered" means, and
   * it is the only thing that ends the wait early — MEASURED (2026-10-21): an
   * early exit as soon as *any* read answered cut the profile wait short, and the
   * page then failed a check it would have passed a few seconds later.
   */
  const readSurfaceUntil = async (done, budgetMs) => {
    const deadline = Date.now() + budgetMs;
    let surface = await readSurface(page);
    while (Date.now() < deadline) {
      surface = await readSurface(page);
      if (done(surface)) return surface;
      await page.waitForTimeout(2000);
    }
    return await readSurface(page);
  };

  const NOTIFICATION_ROUTES =
    /^\/v1\/(castsByMention|reactionsByFid|reactionsByCast|linksByTargetFid|castsByParent|castById)/;
  const PROFILE_ROUTES = /^\/v1\/(userDataByFid|userNameProofByName|verificationsByFid)$/;
  const CHANNEL_ROUTES = /^\/v1\/(castsByParent|castsByFid|userDataByFid|linksByFid|linksByTargetFid)/;

  /**
   * Open a surface and wait for it to answer. `done` decides what "answered"
   * means for that surface.
   *
   * A surface the client replaced with its own "did not answer" panel is opened
   * once more — a cold client reads from its first choice until the first
   * measurement lands, so the same surface usually renders on a fresh load. So
   * is a surface still showing the shell's own loading copy: MEASURED
   * (2026-10-21, two probes at once on a machine at load ~230) `/~/channel/dev`
   * was still `Loading Fiddy…` after two 45s budgets — the dev server compiles
   * routes on demand, and a route that never painted is not a client that
   * refused. The retry count is part of every check's detail, never hidden.
   */
  const visitSurface = async ({ path, done, budgetMs = SURFACE_BUDGET_MS }) => {
    let last = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const netAtVisit = netSeen.length;
      await page.goto(`${SERVER}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const surface = await readSurfaceUntil(done, budgetMs);
      const reads = await readLog(page);
      seen.push(...reads);
      // "Unfinished" is the honest reason to open a surface once more: it
      // refused, it fell back to the fork's copy, it never painted, or it made
      // no answered read at all (the notifications surface did exactly that in
      // one loaded run — shell rendered, nothing read). Both lenses count.
      const answeredSomewhere = [...reads, ...netSeen.slice(netAtVisit)].some(
        (read) => isNodeServer(read.serverKey) && read.status === 200,
      );
      const neverPainted =
        surface.text.trim().length < 40 || /^Loading Fiddy…?/.test(surface.text.trim());
      const unfinished =
        surface.cannotAnswer || surface.genericError || neverPainted || !answeredSomewhere;
      last = { surface, reads, attempts: attempt };
      if (done(surface) || !unfinished) break;
    }
    return last;
  };

  // ── 1. sign in ────────────────────────────────────────────────────────────
  //
  // MEASURED (2026-10-21): `/welcome/ready` paints `Loading Fiddy…` for 6–10s
  // before the setup sheet exists at all, so a click issued as soon as the page
  // has *any* text finds no button and silently drives the rest of the probe
  // unsigned (every surface then lands on the public landing page). The button
  // is therefore waited for by its own words, and a run that still cannot sign
  // in says so with the screen it actually saw instead of failing ten checks
  // downstream with no cause.
  const signIn = async () => {
    const goat = /go social/i;
    let clicked = null;
    let sawText = '';

    // MEASURED (2026-10-21, machine at load average ~230): two waits, not one.
    // `/welcome/ready` paints `Loading Fiddy…` — and the shell skeleton, since
    // the shell now paints itself — while the sheet's own JS is still being
    // evaluated; on a loaded machine that passed 45s and the probe then drove
    // ten unsigned checks against the public landing page with the real cause
    // (a sign-in button that had not appeared yet) nowhere in the report. The
    // button is waited for by its own words for two minutes, and a screen that
    // never offers it is navigated to once more before the run gives up.
    for (let attempt = 1; attempt <= 2 && clicked === null; attempt += 1) {
      await page.goto(`${SERVER}/welcome/ready`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });

      try {
        await page.waitForFunction(
          (pattern) =>
            Array.from(document.querySelectorAll('button, a, [role=button]')).some((el) =>
              new RegExp(pattern, 'i').test((el.innerText || '').replace(/\s+/g, ' ')),
            ),
          'go social',
          { timeout: 120_000 },
        );
        for (const element of await page.$$('button, a, [role=button]')) {
          const text = ((await element.innerText()) || '').replace(/\s+/g, ' ').trim();
          if (goat.test(text)) {
            await element.click();
            clicked = text;
            break;
          }
        }
      } catch {
        sawText = (await readSurface(page)).text.slice(0, 200);
      }
    }

    const surface = await readSurfaceUntil(inClient, 60_000);
    return { surface, clicked, sawText };
  };

  let { surface: afterSignIn, clicked, sawText } = await signIn();
  if (!inClient(afterSignIn)) {
    // A cold client that landed somewhere else gets one more try rather than a
    // cascade of failures from every check below.
    ({ surface: afterSignIn, clicked, sawText } = await signIn());
  }
  await shot(page, 'after-signin');

  check(
    'a completed sign-in lands in the client, not on a setup or device-only screen',
    inClient(afterSignIn) && clicked !== null,
    `clicked="${clicked}" path=${afterSignIn.path} deviceOnly=${afterSignIn.deviceOnlyLanding} onboarding=${afterSignIn.onboardingSheet}${
      clicked === null ? ` | the sign-in button never appeared; screen: "${sawText}"` : ''
    }`,
  );

  // ── 2. the feed shows casts that a server really returned ─────────────────
  const netAtFeed = netSeen.length;
  const feedSurface = await readSurfaceUntil((s) => matchedCasts(s).length > 0, FEED_BUDGET_MS);
  // The response bodies are parsed asynchronously by the listener above, so a
  // beat here lets the last ones land before the DOM is compared against them.
  await page.waitForTimeout(1500);
  const feedReads = await readLog(page);
  seen.push(...feedReads);
  await shot(page, 'feed');

  const feedMatches = matchedCasts(feedSurface);
  const CAST_ROUTES = /^\/v1\/(castsByFid|castsByParent|castById)$/;
  const feedNetReads = netSeen.slice(netAtFeed);
  const pageCastReads = feedReads.filter((read) => CAST_ROUTES.test(read.path));
  const netCastReads = feedNetReads.filter((read) => CAST_ROUTES.test(read.path));
  const castReads = [...pageCastReads, ...netCastReads];
  const nodeCastReads = castReads.filter((read) => isNodeServer(read.serverKey) && read.status === 200);
  const lenses = `page's own log ×${pageCastReads.length}, network ×${netCastReads.length}`;

  check(
    'the feed rendered cast text that came back from the server it read from',
    feedMatches.length > 0,
    feedMatches.length > 0
      ? `${feedMatches.length} of ${servedCasts.length} casts returned by ${describeServers(
          servedCasts,
        )} are on screen; first: "${feedMatches[0].text.slice(0, 50)}" from ${feedMatches[0].server}`
      : `${feedMatches.length} of ${servedCasts.length} casts returned by ${
          servedCasts.length > 0 ? describeServers(servedCasts) : 'nobody'
        } are on screen`,
  );

  check(
    'the feed’s cast reads came from a server this client can read from (a node, its own origin or the relay)',
    nodeCastReads.length > 0,
    castReads.length > 0
      ? `${nodeCastReads.length} of ${castReads.length} cast reads answered by a node (${lenses}): ${describeServers(
          nodeCastReads.slice(0, 6),
        )}`
      : `no cast read left the page (${lenses}); ${feedReads.length} reads in the page's own log: ${describeServers(
          feedReads,
        )}`,
  );

  check(
    'the feed is not an error page',
    !(feedSurface.cannotAnswer && feedMatches.length === 0),
    feedSurface.cannotAnswer
      ? feedMatches.length > 0
        ? `the column also carries a refusal panel for another surface ("${feedSurface.text.slice(0, 90)}"), but the feed itself rendered ${feedMatches.length} casts a node returned`
        : feedSurface.text.slice(0, 180)
      : 'no refusal to render',
  );
  check(
    'the rail says what the node cannot do (direct messages)',
    feedSurface.dmsUnavailable || feedSurface.dmsNoteText,
    `element=${feedSurface.dmsUnavailable} text=${feedSurface.dmsNoteText}`,
  );

  // ── 3. a cast detail, a profile, a channel, notifications ─────────────────
  //
  // Open a cast the FEED itself just rendered: its text was on screen, and the
  // hash came from the bytes a server returned. The fork's cast components are
  // not anchors, so the URL is built rather than scraped.
  //
  // MEASURED (2026-10-21, 5175 with the relay on a refused port): the first
  // candidate is not always the right one to open — the feed's top cast was an
  // embed-heavy one and its own text was not on the detail surface while the
  // thread it opened had been read from a node ten times over. The check now
  // asks what it means: the detail renders cast text a server returned, and the
  // thread was read from a server this client can read from. Up to three
  // candidates are tried, and every attempt is named in the detail.
  const candidates = feedMatches.filter((cast) => cast.hash).slice(0, 3);
  let castReport = null;
  let castSurface = null;
  let castOk = false;
  for (const candidate of candidates) {
    const castVisit = await visitSurface({
      path: `/~/conversations/${candidate.hash}`,
      done: (surface) => matchedCasts(surface).length > 0 && !surface.cannotAnswer,
    });
    const threadReads = castVisit.reads.filter(
      (read) => /^\/v1\/(castsByParent|castById)$/.test(read.path) && read.status === 200,
    );
    const threadCasts = matchedCasts(castVisit.surface);
    castSurface = castVisit.surface;
    await shot(page, 'cast');
    castOk = threadCasts.length > 0 && threadReads.length > 0;
    castReport = `${candidate.hash.slice(0, 12)}…: ${
      threadCasts.length > 0
        ? `${threadCasts.length} cast texts a server returned are on screen`
        : 'no cast text a server returned is on screen'
    }; thread reads: ${threadReads.length > 0 ? describeServers(threadReads) : 'none'}${
      castVisit.attempts > 1 ? '; opened twice (first load refused to render)' : ''
    }`;
    if (castOk) break;
  }
  if (candidates.length === 0) {
    check(
      'a cast detail opens and shows its thread, read from the server the client read from',
      false,
      'no cast the feed rendered carried a hash to open',
    );
  } else {
    check(
      'a cast detail opens and shows its thread, read from the server the client read from',
      castOk,
      `${castReport}${castSurface?.cannotAnswer ? ` | panel: ${castSurface.text.slice(0, 90)}` : ''}`,
    );
  }

  const profileNamed = (surface) =>
    columnOf(surface).includes('dwr') && /Followers/.test(columnOf(surface));
  const profileVisit = await visitSurface({
    path: `/~/profiles/${SIGNED_IN_FID}`,
    done: profileNamed,
  });
  const profileReads = profileVisit.reads.filter(
    (read) =>
      PROFILE_ROUTES.test(read.path) && read.status === 200 && isNodeServer(read.serverKey),
  );
  await shot(page, 'profile');
  check(
    'a profile page renders and names the account, with its reads going to a server the client read from',
    profileNamed(profileVisit.surface) && profileReads.length > 0,
    `${profileReads.length > 0 ? describeServers(profileReads) : 'no profile read answered'}; page column names dwr: ${
      profileNamed(profileVisit.surface)
    }${profileVisit.attempts > 1 ? '; opened twice (first load refused to render)' : ''}${
      profileVisit.surface.cannotAnswer ? ` | panel: ${profileVisit.surface.text.slice(0, 90)}` : ''
    }`,
  );

  const channelRendered = (surface) => /members/i.test(columnOf(surface));
  const channelVisit = await visitSurface({
    path: `/~/channel/${CHANNEL}`,
    done: channelRendered,
    budgetMs: SURFACE_BUDGET_MS,
  });
  const channelReads = channelVisit.reads.filter(
    (read) =>
      CHANNEL_ROUTES.test(read.path) && read.status === 200 && isNodeServer(read.serverKey),
  );
  await shot(page, 'channel');
  check(
    'a channel page renders and answers from a server the client read from (never an empty success)',
    channelRendered(channelVisit.surface) &&
      channelReads.length > 0 &&
      !channelVisit.surface.cannotAnswer,
    `${channelReads.length > 0 ? describeServers(channelReads) : 'no channel read answered'}; page column: "${columnOf(
      channelVisit.surface,
    )
      .slice(0, 110)
      .trim()}"${channelVisit.attempts > 1 ? '; opened twice (first load refused to render)' : ''}`,
  );

  // MEASURED (2026-10-21, 5174): the rail's own `Notifications` item satisfied a
  // whole-document `done` while the page column had rendered and read nothing,
  // so one run in three failed this check on a working client. The column is
  // what is measured now: this page's single tab (`name: 'All'`, from
  // `nodeBackedFetch.ts`) or its own empty state (`No notifications yet.`, from
  // `components/notificationsTabs/NotificationsTab.tsx`). When the page's
  // `notificationTabs` never arrives, the page renders nothing and neither
  // marker appears — which is the honest reading of that surface.
  const notificationsRendered = (surface) =>
    /No notifications yet\./.test(columnOf(surface)) || /\bAll\b/.test(columnOf(surface));
  const notificationsVisit = await visitSurface({
    path: '/~/notifications',
    done: notificationsRendered,
  });
  const notificationReads = notificationsVisit.reads.filter(
    (read) =>
      NOTIFICATION_ROUTES.test(read.path) &&
      read.status === 200 &&
      isNodeServer(read.serverKey),
  );
  await shot(page, 'notifications');
  check(
    'notifications are derived from a node read, not from a refusal',
    notificationReads.length > 0 && !notificationsVisit.surface.cannotAnswer,
    `${notificationReads.length > 0 ? describeServers(notificationReads) : 'no notification read answered'}; page column: "${columnOf(
      notificationsVisit.surface,
    )
      .slice(0, 110)
      .trim()}"${notificationsVisit.attempts > 1 ? '; opened twice (first load refused to render)' : ''}`,
  );
  check(
    'the notifications surface does not render an error page',
    !notificationsVisit.surface.cannotAnswer && !notificationsVisit.surface.genericError,
    notificationsVisit.surface.cannotAnswer
      ? notificationsVisit.surface.text.slice(0, 160)
      : notificationsVisit.surface.text.slice(0, 90),
  );

  // ── 4. a reload keeps it working ──────────────────────────────────────────
  const netAtReload = netSeen.length;
  await page.goto(`${SERVER}/`, { waitUntil: 'domcontentloaded' });
  const reloadSurface = await readSurfaceUntil(
    (s) => inClient(s) && matchedCasts(s).length > 0,
    RELOAD_BUDGET_MS,
  );
  await page.waitForTimeout(1500);
  const reloadReads = await readLog(page);
  seen.push(...reloadReads);
  const reloadNetReads = netSeen.slice(netAtReload);
  const reloadNodeReads = reloadReads.filter(
    (read) =>
      /^\/v1\/castsByFid/.test(read.path) && read.status === 200 && isNodeServer(read.serverKey),
  );
  const reloadMatches = matchedCasts(reloadSurface);
  // MEASURED (2026-10-21, review round 1 + this card's own runs): this is the
  // check that flips on a live node — the review's two runs of the previous
  // revision were 11/12, this card's thirteen live-node runs of it were twelve
  // green and one 9/12, and always with the same detail: "×1 (200) | casts back
  // on screen: 0".
  // That detail read as "the node's reads stopped", which is not what happened —
  // the node answered every read it was handed (770 in one measured run, all
  // 200) while the column carried the client's own refusal, unchanged for the
  // whole budget and 75s past it. Both facts are in the probe already
  // (`surfaceProbe`'s refusal patterns, and the reads that did not answer), so
  // the failure detail now names the surface's own state and the read that
  // failed, the way the cast-detail/profile/channel checks do. The check itself
  // is unchanged on purpose: no re-open and no tolerance, because the state it
  // reports is a real client condition — a reload that does not recover — and
  // `visitSurface`'s one-re-open policy would hide the very thing this check
  // exists to catch.
  const reloadFailures = reloadReads.filter((read) => read.status !== 200);
  const reloadFeedFailures = reloadFailures.filter((read) =>
    /^\/(?:v2\/feed-items|v1\/castsByFid)/.test(read.path),
  );
  const reloadOk =
    inClient(reloadSurface) && reloadMatches.length > 0 && reloadNodeReads.length > 0;
  const columnWords = wordsFor(columnOf(reloadSurface));
  // Only a failing check explains itself: a passing one keeps the detail the
  // release doc quotes (the reads, and the casts back on screen). On a failure
  // the detail answers the two questions an operator has — what does the reader
  // see, and which read failed — and never blames the node when it answered.
  const reloadStateParts = [];
  if (!inClient(reloadSurface)) {
    reloadStateParts.push(
      `landed at ${reloadSurface.path || '(no path read)'} deviceOnly=${
        reloadSurface.deviceOnlyLanding
      } onboarding=${reloadSurface.onboardingSheet}`,
    );
  }
  if (columnWords) {
    reloadStateParts.push(columnWords);
  } else {
    reloadStateParts.push(`page column: "${columnOf(reloadSurface).slice(0, 160).trim()}"`);
    const elsewhere = wordsFor(reloadSurface.text);
    if (elsewhere) reloadStateParts.push(`elsewhere on the page — ${elsewhere}`);
  }
  if (reloadFailures.length > 0) {
    const listed = reloadFeedFailures.length > 0 ? reloadFeedFailures : reloadFailures;
    const label =
      reloadFeedFailures.length > 0
        ? `${reloadFeedFailures.length} feed read${reloadFeedFailures.length === 1 ? '' : 's'}`
        : `${reloadFailures.length} read${reloadFailures.length === 1 ? '' : 's'} in the reload’s own log`;
    reloadStateParts.push(
      `${label} did not answer 200: ${listed
        .slice(0, 4)
        .map((read) => `${read.status} ${read.method} ${read.path} (${read.server})`)
        .join('; ')}`,
    );
  }
  const reloadState = reloadOk ? '' : reloadStateParts.map((part) => ` | ${part}`).join('');
  await shot(page, 'after-reload');
  check(
    'after a reload the client still reads the feed from a server it read from',
    reloadOk,
    `${reloadNodeReads.length > 0 ? describeServers(reloadNodeReads) : 'no castsByFid read answered by a node after the reload'} | casts back on screen: ${reloadMatches.length}${reloadState}`,
  );

  // ── 5. no surface fell back to the fork's generic copy ────────────────────
  const surfacesSeen = [
    { name: 'the feed', surface: feedSurface },
    { name: 'a cast detail', surface: castSurface },
    { name: 'a profile', surface: profileVisit.surface },
    { name: `the ${CHANNEL} channel`, surface: channelVisit.surface },
    { name: 'notifications', surface: notificationsVisit.surface },
    { name: 'the feed after a reload', surface: reloadSurface },
  ].filter((entry) => entry.surface);
  const generic = surfacesSeen.filter((entry) => entry.surface.genericError);
  check(
    'no surface fell back to generic error copy',
    generic.length === 0,
    generic.length === 0
      ? `${surfacesSeen.length} surfaces read, none with the fork’s generic copy`
      : generic.map((entry) => `${entry.name}: ${entry.surface.text.slice(0, 90)}`).join(' | '),
  );

  // ── 6. the client's own words about where its reads come from ─────────────
  await page.goto(`${SERVER}/~/settings/node`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(12_000);
  let providerWords = null;
  try {
    providerWords = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('span,div')).find(
        (el) => (el.innerText || '').trim() === 'Which servers to read from',
      );
      const container = heading?.closest('div.solid-glass-pane') ?? null;
      if (!container) return null;
      const rows = Array.from(container.querySelectorAll('div'))
        .filter(
          (el) =>
            /^\s*\d+\.\s/.test(el.innerText || '') &&
            (el.innerText || '').split('\n').length >= 2,
        )
        .map((el) => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 160));
      const pill = Array.from(document.querySelectorAll('div,span,button'))
        .map((el) => (el.innerText || '').trim())
        .filter((text) => /^(Backup|Public|Your own|Shared|Checking…|Offline)$/.test(text));
      const rightNow = /Right now: ([^.]+)\./.exec(container.innerText.replace(/\s+/g, ' '));
      return { rows, pill: pill[0] ?? null, rightNow: rightNow?.[1] ?? null };
    });
  } catch (error) {
    // The provider card is reported evidence, not a check — losing it must not
    // lose the run (measured: a mid-navigation evaluate has thrown here).
    console.log(`(the provider card could not be read: ${String(error).split('\n')[0]})`);
  }

  await browser.close();

  // ── the report: what left the page, and what answered it ──────────────────
  const byServer = new Map();
  for (const read of seen) {
    const entry = byServer.get(read.serverKey) ?? { read, calls: 0, routes: new Map() };
    entry.calls += 1;
    const key = `${read.status} ${read.method} ${read.path.split('?')[0]}`;
    entry.routes.set(key, (entry.routes.get(key) ?? 0) + 1);
    byServer.set(read.serverKey, entry);
  }

  const byRoute = new Map();
  for (const read of seen) {
    if (!read.nodeRoute) continue;
    const key = `${read.server} ${read.method} ${read.nodeRoute}`;
    const entry = byRoute.get(key) ?? { key, calls: 0, statuses: new Set() };
    entry.calls += 1;
    entry.statuses.add(read.status);
    byRoute.set(key, entry);
  }
  const routeReport = [...byRoute.values()]
    .map((e) => ({ key: e.key, calls: e.calls, statuses: [...e.statuses].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const gapLines = consoleErrors.filter((line) => /HandledFetchError|501/.test(line));
  const failed = checks.filter((c) => !c.ok);

  console.log(
    `── the client, driven with a real SIWF session against a real node${
      ISOLATE ? ' (every other server out of reach)' : ''
    } ──`,
  );
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }

  console.log(`\n── where the client says its answers come from ──`);
  if (providerWords) {
    console.log(`  pill: ${providerWords.pill ?? '(none)'}; Right now: ${providerWords.rightNow ?? '(not measured yet)'}`);
    for (const row of providerWords.rows) console.log(`  ${row}`);
  } else {
    console.log('  (the provider card did not render on this run)');
  }

  console.log(`\n── reads that left the page (${seen.length}), by server ──`);
  for (const [, entry] of [...byServer.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(`  ${entry.read.server} — ${entry.calls} read${entry.calls === 1 ? '' : 's'}`);
    for (const [key, calls] of [...entry.routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`      ×${String(calls).padStart(3)}  ${key}`);
    }
  }

  // The reload is the check that flips (see the note at it), so what the reload
  // document itself did is reported on its own — both lenses, every server, and
  // the cast texts that made it back to the column. That is the evidence an
  // operator needs when the red bisects to the provider seam rather than the node.
  console.log(`\n── what the reload document did (after goto('/')) ──`);
  const reloadByServer = new Map();
  for (const read of [...reloadReads, ...reloadNetReads]) {
    const entry = reloadByServer.get(read.serverKey) ?? { server: read.server, calls: 0, routes: new Map() };
    entry.calls += 1;
    const key = `${read.status} ${read.method} ${read.path.split('?')[0]}`;
    entry.routes.set(key, (entry.routes.get(key) ?? 0) + 1);
    reloadByServer.set(read.serverKey, entry);
  }
  if (reloadByServer.size === 0) console.log('  (no read left the page)');
  for (const [, entry] of [...reloadByServer.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(`  ${entry.server} — ${entry.calls} read${entry.calls === 1 ? '' : 's'}`);
    for (const [key, calls] of [...entry.routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`      ×${String(calls).padStart(3)}  ${key}`);
    }
  }
  console.log(
    `  casts a server returned, back on screen: ${reloadMatches.length} of ${servedCasts.length}; castsByFid 200s in the reload's own log: ${reloadNodeReads.length}`,
  );

  console.log(`\n── node routes the client used (${routeReport.length}) ──`);
  for (const r of routeReport) {
    console.log(`${r.statuses.join('/')}  x${String(r.calls).padStart(3)}  ${r.key}`);
  }

  console.log(`\n── endpoints the node could not answer (501) ──`);
  const seenGaps = new Set();
  for (const line of gapLines) {
    const name = /HandledFetchError: ([A-Za-z]+) 501 - (.{0,110})/.exec(line);
    if (!name || seenGaps.has(name[1])) continue;
    seenGaps.add(name[1]);
    console.log(`  ${name[1]}: ${name[2]}`);
  }
  if (seenGaps.size === 0) console.log('  (none)');

  if (ISOLATE) {
    console.log(`\n── every other server blocked (${blocked.length}) ──`);
    for (const url of [...new Set(blocked)].slice(0, 12)) console.log(`  ${url}`);
  }

  console.log(
    `\nconsole errors: ${consoleErrors.length} (${gapLines.length} of them the adapter saying "not on the node")`,
  );

  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`,
  );

  if (failed.length > 0) process.exitCode = 1;
};

await run();