// What the `$TICKER` surfaces render, measured on the live client.
//
//   node apps/farcaster-web/scripts/verify-token-links-live.mjs
//   TOKEN_LINKS_ORIGIN=https://localhost:5191 node apps/farcaster-web/scripts/verify-token-links-live.mjs
//
// WHY THIS EXISTS
//
// MEASURED 2026-10-24 on fiddy.fun: `/v2/token-links` had no source in the
// client's routing table, so the `$TICKER` page, `/~/ca/<address>`, the
// composer's `$` typeahead and the profile's token picker were all shown the
// adapter's fallback sentence ("Fiddy can't read /v2/token-links yet…"). Card
// t_0752118b wired it to a public market index; this probe is what keeps it
// wired, in the only place that matters — a real browser on the real origin.
//
// WHAT IT HOLDS THE PAGE TO
//
//   * `/~/token/degen` paints a real market row: the ticker, a market value and
//     the market index's own read (api.dexscreener.com) really left the page;
//   * no refusal sentence is anywhere on that page — neither the adapter's
//     fallback for this endpoint nor a panel standing in for the row;
//   * `/~/ca/<address>` (a pasted contract address) resolves to that token's own
//     page rather than to an empty state;
//   * a ticker no market uses says exactly that, in words, and does NOT refuse —
//     "nothing here" and "we could not read this" are different facts and the
//     page must not confuse them.
//
// Signed out is enough, deliberately: the read is asked before the page checks
// the session, and a probe that needed a seeded SIWF session to see a token row
// would be measuring a different thing than what a stranger sees.
//
// Env:
//   TOKEN_LINKS_ORIGIN   the origin to measure      (default https://fiddy.fun)
//   TOKEN_LINKS_TICKER   a ticker that has markets  (default degen)
//   TOKEN_LINKS_ADDRESS  its contract address       (default Base's $DEGEN)
//   TOKEN_LINKS_SHOT_DIR where screenshots land     (default: the system temp
//                        dir — never a directory inside the repo, which eslint
//                        walks on every lint run)

import os from 'node:os';

import { chromium } from 'playwright';

const ORIGIN = process.env.TOKEN_LINKS_ORIGIN ?? 'https://fiddy.fun';
const TICKER = (process.env.TOKEN_LINKS_TICKER ?? 'degen').toLowerCase();
const ADDRESS =
  process.env.TOKEN_LINKS_ADDRESS ??
  '0x4ed4e862860bed51a9570b96d89af5e1b0efefed';
const SHOT_DIR = process.env.TOKEN_LINKS_SHOT_DIR ?? os.tmpdir();

/** The sentences this read has no source for — the bug this probe is about. */
const TOKEN_LINK_REFUSALS = [
  /can.t read\s+\/v2\/token-links/i,
  /no reader here answers it/i,
  /has no reader wired up in this app/i,
];

/**
 * Every *other* refusal a page in this client can show. Not judged: the
 * `$TICKER` page also carries a Casts section, which reads Warpcast's own search
 * (`/v2/search-casts`, classified `hosted` — a read node keeps no search index)
 * and says so in place. Printed by name so nothing is hidden, and never a reason
 * to fail a run: this probe measures the token read, not that one.
 */
const OTHER_REFUSALS = [
  /isn.t on your node/i,
  /didn.t load from your node/i,
  /Error retrieving data/i,
  /no search index/i,
];

let pass = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
};

const matches = (text, patterns) =>
  patterns.filter((pattern) => pattern.test(text)).map(String);

/** Report, without judging, the refusals that belong to some other read. */
const reportOthers = (label, text) => {
  const others = matches(text, OTHER_REFUSALS);
  if (others.length > 0) {
    console.log(
      `  ..   ${label}: other refusals on screen (not this read): ${others.join(' | ')}`,
    );
  }
};

/** The page's own words, whitespace collapsed, for matching and for evidence. */
const textOf = (tab) =>
  tab.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());

/**
 * Open a route, hold it to `ready`, and report what it settled on.
 *
 * The client is a single-page app: a route change renders in place, so the wait
 * is on the page's own content rather than on a navigation event.
 */
const visit = async (tab, path, { ready, timeout = 45_000 }) => {
  const requests = [];
  const onRequest = (request) => requests.push(request.url());
  tab.on('request', onRequest);

  await tab.goto(`${ORIGIN}${path}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  const painted = await tab
    .waitForFunction(ready, undefined, { timeout })
    .then(() => true)
    .catch(() => false);

  tab.off('request', onRequest);

  return { painted, text: await textOf(tab), requests };
};

console.log(`\n== a ticker's market really paints (${ORIGIN}/~/token/${TICKER})`);
const browser = await chromium.launch();
let shot = null;
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // A local preview serves its own certificate; the live origin's is real and
    // validates anyway, so this changes nothing about what is measured there.
    ignoreHTTPSErrors: true,
  });
  const tab = await context.newPage();

  const first = await visit(tab, `/~/token/${TICKER}`, {
    ready: () =>
      /\$[A-Z0-9]{2,}\b/.test(document.body.innerText) &&
      !/Loading Fiddy/.test(document.body.innerText),
  });

  const upper = TICKER.toUpperCase();
  check(
    'the page names the token it found',
    first.painted && first.text.includes(`$${upper}`),
    first.text.slice(0, 200),
  );
  check(
    'the market index is what answered it',
    first.requests.some((url) => url.includes('api.dexscreener.com')),
    first.requests.filter((url) => url.includes('api.dexscreener.com')).length +
      ' api.dexscreener.com request(s)',
  );
  check(
    'this read does not refuse anywhere on the page',
    matches(first.text, TOKEN_LINK_REFUSALS).length === 0,
    matches(first.text, TOKEN_LINK_REFUSALS).join(' | '),
  );
  check(
    'the row carries a market value, not just a name',
    /\$[0-9][0-9,.]*(K|M|B)?/.test(first.text),
    (first.text.match(/\$[0-9][0-9,.]*(K|M|B)?/) ?? [''])[0],
  );
  reportOthers('the ticker page', first.text);

  shot = `${SHOT_DIR}/token-links-${TICKER}.png`;
  await tab.screenshot({ path: shot, fullPage: false });
  console.log(`  ..   screenshot ${shot}`);

  console.log(`\n== a pasted contract address resolves to its token`);
  const second = await visit(tab, `/~/ca/${ADDRESS}`, {
    ready: () =>
      /\$[A-Z0-9]{2,}\b/.test(document.body.innerText) &&
      !/Loading Fiddy/.test(document.body.innerText),
  });
  check(
    'the address route lands on the token it is',
    second.painted && second.text.includes(`$${upper}`),
    second.text.slice(0, 200),
  );
  check(
    'the address route does not refuse this read',
    matches(second.text, TOKEN_LINK_REFUSALS).length === 0,
    matches(second.text, TOKEN_LINK_REFUSALS).join(' | '),
  );
  reportOthers('the address route', second.text);

  console.log('\n== a ticker no market uses is answered without inventing one');
  // The empty sentence itself ("No market was found for $X…") is a signed-in
  // surface: the signed-out branch of this page draws the token block only when
  // there is something to draw, and says "Read most recent casts about $X"
  // otherwise. So what a signed-out run can hold here is the honest pair: no
  // refusal, and no market value invented to fill the gap.
  const nothing = await visit(tab, '/~/token/zzzznotaticker', {
    ready: () =>
      /Read most recent casts about|No market was found|no market was found/i.test(
        document.body.innerText,
      ),
  });
  check(
    'an unknown ticker refuses nothing',
    nothing.painted && matches(nothing.text, TOKEN_LINK_REFUSALS).length === 0,
    matches(nothing.text, TOKEN_LINK_REFUSALS).join(' | '),
  );
  check(
    'an unknown ticker is shown no invented market value',
    nothing.painted && !/\$[0-9]/.test(nothing.text),
    (nothing.text.match(/\$[0-9][0-9,.]*/) ?? [''])[0],
  );
  reportOthers('the unknown-ticker page', nothing.text);

  await context.close();
} finally {
  await browser.close();
}

console.log(`\n${pass} ok, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`  - ${failure}`);
  }
  process.exitCode = 1;
}
if (shot !== null) {
  const bytes = await import('node:fs').then(
    (fs) => fs.statSync(shot).size,
  );
  console.log(`evidence: ${shot} (${bytes}B)`);
}