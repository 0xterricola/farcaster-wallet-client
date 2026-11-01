// The reads that leave a signed-in page — and every one of them that went to an
// origin which will refuse it.
//
//   SERVER=https://fiddy.fun node scripts/verify-no-off-site-reads.mjs
//
// WHY THIS EXISTS
//
// MEASURED 2026-10-21 on the live release (https://fiddy.fun, 89cdd01): a real
// signed-in browser session made reads to `api.farcaster.xyz` that could not
// come back — every `/v1/**` and `/v2/**` path answers `Vary: Origin` and no
// `Access-Control-Allow-Origin`, so the browser threw each one away with
// "Failed to fetch". Eleven distinct paths, twice a poll, most of the release
// probe's 66 console errors. The same release asked `ph.neynar.com` for the
// fork's PostHog config with a template key (404/401). Both are the sort of
// thing a status check cannot see: the page loads, the feed renders, and the
// console is full of reads that were never going to be answered.
//
// So this probe watches the one thing that matters: what left the page. It signs
// in exactly as a reader does (the SIWF relay is stubbed with a REAL SIWE message
// signed by a throwaway key, so the app's own verifier accepts it), waits for the
// polling hooks to fire, and then classifies every fetch attempt.
//
// WHAT IT FAILS ON
//
//   - any read the page made to `api.farcaster.xyz` other than `/fc/*` — every
//     `/v1/**` and `/v2/**` path permits its own origins only, while `/fc/*`
//     answers and is left as it was (see
//     `~/snapchain/providers/publicServerOffTheWeb`)
//   - any read the page made to a PostHog host (analytics with no key of its own
//     must send nothing; see `~/constants/analytics`)
//
// WHAT IT REPORTS WITHOUT FAILING
//
//   - reads that went to the node the build was configured with, and to the page
//     itself (those are the client working)
//   - reads to `li.quest`, the wallet's keyless route and price API: it answers
//     `access-control-allow-origin: *` (measured 2026-10-23) and carries no key,
//     so it is a read the page is allowed to make
//   - requests from a third-party frame's own document (Farcaster's wallet
//     mini-app modal measures itself with its own key; that is inside their
//     frame, not this page's doing)
//   - anything else it saw, by name, so nothing is hidden.
//
// PRECONDITIONS
//
//   - a client served on $SERVER (the released one, or a local build:
//       cd apps/farcaster-web
//       VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//       VITE_FIDDY_MEDIA_URL=https://fiddy.fun npx vite build
//       npx vite preview --port 5190      # https://localhost:5190
//     then SERVER=https://localhost:5190 node scripts/verify-no-off-site-reads.mjs)
//   - playwright with a real Chrome, like the other probes here
//   - the node the build reads through must be reachable: this probe signs in and
//     lets the client read, so a node that never answers means nothing to watch.
//
// Set SETTLE_MS to watch longer (default 30000), FID to sign in as someone else.

import { chromium } from 'playwright';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const SERVER = (process.env.SERVER ?? 'https://fiddy.fun').replace(/\/+$/, '');
const DOMAIN = new URL(SERVER).host;
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'OFFSITE1';
const SIGNED_IN_FID = Number(process.env.FID ?? 3);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 30000);
const NODE = process.env.NODE_BACKED_SERVER ?? null;

/** Origins that can never answer a page on another origin. */
const REFUSED = [
  // Every `/v1/**` and `/v2/**` path refuses a page; `/fc/*` is the one path
  // that does answer, and it is left exactly as it was (see ALLOWED below).
  /^https:\/\/api\.farcaster\.xyz\/(?!fc\/)/,
  /posthog\.com\//,
  /ph\.neynar\.com\//,
];

/** Origins this probe expects to see: the page itself, the node, and stubs. */
const SAME_ORIGIN = new RegExp(
  `^${SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`,
);
const ALLOWED = [
  SAME_ORIGIN,
  /^data:/,
  /^blob:/,
  // The one path on api.farcaster.xyz a page IS allowed to read
  // (`access-control-allow-origin: *`). It answers, it is not routed through the
  // provider seam, and this probe does not exist to relitigate it.
  /^https:\/\/api\.farcaster\.xyz\/fc\//,
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /^https:\/\/relay\.farcaster\.xyz\//, // stubbed below, as the app's own sign-in
  /^https:\/\/farcaster\.xyz\//,
  // The wallet's keyless route, price and transfer-status API
  // (`utils/lifiWallet.ts`, `utils/lifiSwap.ts`). Third-party, but it answers
  // `access-control-allow-origin: *` and needs no key, so nothing about it
  // leaves the page unanswerable. Kept explicit so the audit names it instead of
  // lumping it into "anything else it saw".
  /^https:\/\/li\.quest\//,
  ...(NODE
    ? [new RegExp(`^${NODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)]
    : []),
];

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

const browser = await chromium.launch({
  channel: 'chrome',
  ignoreHTTPSErrors: true,
  args: ['--ignore-certificate-errors'],
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

// Log a fetch attempt BEFORE it settles, so a refused (CORS-blocked) request is
// visible at all — awaiting first would lose exactly the requests this probe is
// about.
await ctx.addInitScript(() => {
  window.__attempts = [];
  const orig = window.fetch;
  window.fetch = async (...args) => {
    const url =
      typeof args[0] === 'string'
        ? args[0]
        : (args[0] && args[0].url) || String(args[0]);
    const record = {
      method: (args[1] && args[1].method) || 'GET',
      url: String(url),
      outcome: 'pending',
    };
    window.__attempts.push(record);
    try {
      const response = await orig(...args);
      record.outcome = `status ${response.status}`;
      return response;
    } catch (error) {
      record.outcome = `REJECTED ${String(error).slice(0, 120)}`;
      throw error;
    }
  };
});

const consoleMsgs = [];
const page = await ctx.newPage();
page.on('console', (m) =>
  consoleMsgs.push(
    `${m.type()}: ${m.text().replace(/\s+/g, ' ').slice(0, 240)}`,
  ),
);
page.on('pageerror', (e) =>
  consoleMsgs.push(`pageerror: ${String(e).slice(0, 240)}`),
);

// Requests nobody in this page's own code made: a third-party frame's document
// has its own scripts and its own analytics, and those show up here.
const fromOtherDocuments = [];
page.on('request', (r) => {
  const url = r.url();
  if (!REFUSED.some((re) => re.test(url))) return;
  let frame = SERVER;
  try {
    frame = r.frame().url();
  } catch {
    frame = 'detached';
  }
  if (!frame.startsWith(SERVER)) {
    fromOtherDocuments.push(
      `${r.method()} ${url} (frame: ${frame.slice(0, 80)})`,
    );
  }
});

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

const surface = () =>
  page.evaluate(() => ({
    path: window.location.pathname,
    shell: Boolean(document.querySelector('.fiddy-shell-frame')),
    text: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 240),
  }));

await page.goto(`${SERVER}/welcome/ready`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForFunction(() => document.body.innerText.trim().length > 40, {
  timeout: 60000,
});

// The "Go social" control lands with its own step's content, so wait for it by
// name rather than for the first paint.
const signedInAlready = (await surface()).shell;
if (!signedInAlready) {
  await page
    .waitForFunction(() => /go social/i.test(document.body.innerText), {
      timeout: 90000,
    })
    .catch(() => {});
  const clicked = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('button, a, [role="button"]'),
    );
    const hit = nodes
      .reverse()
      .find((el) =>
        /go social/i.test((el.innerText || '').replace(/\s+/g, ' ').trim()),
      );
    if (!hit) return 'not found';
    hit.click();
    return 'clicked';
  });
  console.log(`── sign-in ──  ${clicked}`);
}

let s = await surface();
for (let i = 0; i < 60 && !(s.path === '/' && s.shell); i += 1) {
  await page.waitForTimeout(1000);
  s = await surface();
}
console.log(`── signed in: path=${s.path} shell=${s.shell} ──`);
if (!s.shell) {
  console.log(
    '  (no shell: nothing was signed in, so there are no reads to watch)',
  );
  console.log(`  page said: ${s.text}`);
}

console.log(`── settling ${SETTLE_MS} ms so the polling hooks fire ──`);
await page.waitForTimeout(SETTLE_MS);

const attempts = await page.evaluate(() => window.__attempts ?? []);
const refused = attempts.filter((a) => REFUSED.some((re) => re.test(a.url)));

/** Where each read went, counted by origin. */
const byOrigin = new Map();
for (const a of attempts) {
  let origin = a.url;
  try {
    origin = new URL(a.url).origin;
  } catch {
    /* a relative URL is the page's own origin */
  }
  const key = origin.startsWith(SERVER) ? SERVER : origin;
  byOrigin.set(key, (byOrigin.get(key) ?? 0) + 1);
}
const ranked = [...byOrigin].sort((x, y) => y[1] - x[1]);
// The server most of the reads went to is the node this client is reading
// through — named in the report rather than passed in.
const nodeOrigin = ranked.find(
  ([origin]) => origin !== SERVER && !origin.startsWith('/'),
)?.[0];

const wanted = attempts.filter(
  (a) =>
    !ALLOWED.some((re) => re.test(a.url)) &&
    !REFUSED.some((re) => re.test(a.url)) &&
    !(nodeOrigin && a.url.startsWith(nodeOrigin)),
);

console.log(`\n── reads that left the page (${attempts.length}) ──`);
for (const [origin, count] of ranked) {
  const label =
    origin === SERVER || origin.startsWith('/')
      ? ' (this page)'
      : origin === nodeOrigin
        ? ' (the node it reads through)'
        : '';
  console.log(`  ${String(count).padStart(4)}  ${origin}${label}`);
}

if (wanted.length > 0) {
  console.log(
    '\n── origins this probe did not expect (not a failure, but look) ──',
  );
  for (const a of wanted) console.log(`  ${a.method} ${a.url} → ${a.outcome}`);
}

if (fromOtherDocuments.length > 0) {
  console.log(
    '\n── the same origins, asked by ANOTHER document (their own doing) ──',
  );
  for (const r of fromOtherDocuments) console.log(`  ${r}`);
}

console.log('\n── console, the refused-reads part ──');
const corsLines = consoleMsgs.filter((c) =>
  /CORS policy|Access-Control-Allow-Origin|net::ERR_FAILED/.test(c),
);
if (corsLines.length === 0) console.log('  (no CORS failures in the console)');
for (const c of corsLines) console.log(`  ${c}`);

console.log('\n── verdict ──');
if (refused.length === 0) {
  console.log(
    '  PASS  no read left the page for an origin that will refuse it',
  );
} else {
  console.log(
    `  FAIL  ${refused.length} read(s) went to an origin that refuses a page:`,
  );
  for (const a of refused)
    console.log(`    ${a.method} ${a.url} → ${a.outcome}`);
}

await browser.close();
process.exit(refused.length === 0 ? 0 : 1);
