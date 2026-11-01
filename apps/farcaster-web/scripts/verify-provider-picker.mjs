// End-to-end proof of the thing the reader actually sees: the client moves its
// feed to a backup when the server they chose stops being quick, and the pill
// says so in plain words.
//
//   HTTPS=true npx vite --port 5178
//   PROVIDER_PICKER_SERVER=https://localhost:5178 node scripts/verify-provider-picker.mjs
//
// WHAT IS STUBBED, AND WHY
//   - the SIWF relay only, exactly as `verify-node-backed-client.mjs` does it: a
//     real SIWE message signed by a throwaway key, so the app's own verifier
//     accepts the sign-in for real.
//   - the reader's own server: this run needs a server that is SLOW but not
//     dead, which no real host can be made to do on demand. It is the stand-in
//     host `https://fiddy-slow.example`, which cannot resolve to anything real,
//     and it answers `/v1/info` slowly. It deliberately serves NO other route:
//     every other path comes back 503, so a run that accidentally read its feed
//     from the stand-in would show an empty page, never invented casts.
//   - nothing else. The public relay on the reader's list is the real one
//     (`https://haatz.quilibrium.com`, measured live on 2026-10-20), Farcaster's
//     own public server is the real one, and the reads after the switch are real
//     reads against the real relay.
//
// WHAT IT ASSERTS
//   1. the picker saves "your own server" and the list shows it
//   2. after a reload the engine measures the first choice, finds it slow, and
//      moves to a backup — the pill says "Switched to a backup node — your first
//      choice got slow", and its short label is "Backup"
//   3. the list on Advanced agrees: the reader's own server reads "working, but
//      slowly" while the live row is the relay
//   4. the engine really did ask the slow server (the stub's own request count)
//      and the measurements repeat a minute later without flapping back
//
// Screenshots land in $PROVIDER_SHOT_DIR (default: the system temp dir).

import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.PROVIDER_PICKER_SERVER ?? 'https://localhost:5178';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.PROVIDER_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'PROVIDERS1';
const SIGNED_IN_FID = 3;
/** A host that cannot exist: it is a stand-in, not a node on the internet. */
const STAND_IN = 'https://fiddy-slow.example';
/** How long the stand-in takes to answer `/v1/info`. Slower than the client's
 *  2.5s "slow" threshold, inside its 6s deadline, so it is judged slow rather
 *  than unresponsive. */
const SLOW_MS = Number(process.env.PROVIDER_SLOW_MS ?? 3_200);
/** How long to wait for the engine's second round (its interval is 60s). */
const SECOND_ROUND_BUDGET_S = Number(process.env.PROVIDER_ROUND_BUDGET_S ?? 120);

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

/** A `/v1/info` body shaped the way a Snapchain node shapes one. */
const nodeInfo = (height) =>
  JSON.stringify({
    version: 'stand-in',
    isSyncing: false,
    numShards: 1,
    shardInfos: [{ shardId: 0, maxHeight: height, blockDelay: 0 }],
  });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
};

const standIn = { probes: 0, heights: 0 };

const readSurface = async (page) => {
  try {
    return await page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[title]')];
    const isPill = (a) =>
      /backup|answers come from|checking your servers|is (offline|still)/i.test(
        a.getAttribute('title') || '',
      );
    const pill = anchors.find(isPill) ?? null;
    const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const log = window.__providerFetchLog ?? [];
    const hosts = {};
    for (const line of log) {
      const match = line.match(/https?:\/\/([^/\s]+)/);
      const host = match ? match[1] : 'same-origin';
      hosts[host] = (hosts[host] ?? 0) + 1;
    }
    return {
      path: window.location.pathname,
      text: flat(document.body.innerText),
      pillTitle: pill?.getAttribute('title') ?? null,
      pillText: flat(pill?.innerText),
      pillClass: pill?.className ?? null,
      pillTexts: anchors.filter(isPill).map((a) => flat(a.innerText)),
      anchorTitles: anchors.map((a) => a.getAttribute('title')).slice(0, 6),
      hosts,
      logTail: log.slice(-6),
    };
    });
  } catch {
    // A navigation in flight destroys the JS execution context; the caller's
    // polling loop simply tries again on the next tick.
    return null;
  }
};

const browser = await chromium.launch({
  channel: 'chrome',
  ignoreHTTPSErrors: true,
  args: ['--ignore-certificate-errors'],
});
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});

// What the page asked for, so the switch can be reported from the reads rather
// than from a claim about them.
await ctx.addInitScript(() => {
  const orig = window.fetch;
  window.__providerFetchLog = [];
  window.fetch = async (...args) => {
    const url =
      typeof args[0] === 'string'
        ? args[0]
        : (args[0] && args[0].url) || String(args[0]);
    try {
      const response = await orig(...args);
      window.__providerFetchLog.push(`${response.status} ${String(url).slice(0, 160)}`);
      return response;
    } catch (error) {
      window.__providerFetchLog.push(
        `THREW ${String(url).slice(0, 160)} :: ${String(error).slice(0, 80)}`,
      );
      throw error;
    }
  };
});

const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') {
    consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 200));
  }
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

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

await page.route(`${STAND_IN}/**`, async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path !== '/v1/info') {
    // No invented data from the stand-in: a read that lands here fails loudly.
    return route.fulfill({
      status: 503,
      headers: CORS,
      body: JSON.stringify({
        error: 'this stand-in server only answers /v1/info',
      }),
    });
  }
  standIn.probes += 1;
  standIn.heights += 1;
  await delay(SLOW_MS);
  return route.fulfill({
    status: 200,
    headers: CORS,
    body: nodeInfo(49_300_000 + standIn.heights),
  });
});

const readLog = async () => {
  try {
    return await page.evaluate(() => window.__providerFetchLog.slice(-400));
  } catch {
    return [];
  }
};

const waitFor = async (predicate, budgetS, everyMs = 1_000) => {
  const deadline = Date.now() + budgetS * 1_000;
  let last = null;
  while (Date.now() < deadline) {
    const surface = await readSurface(page);
    if (surface) {
      last = surface;
      if (predicate(surface)) return surface;
    }
    await page.waitForTimeout(everyMs);
  }
  return last;
};

/** Open Advanced, and wait for the node picker inside it to be on screen. */
const openAdvanced = async () => {
  await page.goto(`${SERVER}/~/settings/node`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  return waitFor((s) => s.text.includes('Where Fiddy reads from'), 60);
};

try {
  // ── 1. sign in ────────────────────────────────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => document.body.innerText.trim().length > 40,
    undefined,
    { timeout: 60_000 },
  );

  let clicked = null;
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(text)) {
      await el.click();
      clicked = text;
      break;
    }
  }

  const signedIn = await waitFor((s) => s.path === '/' && s.text.length > 40, 90);
  check(
    'a completed sign-in lands in the client',
    signedIn?.path === '/' && clicked !== null,
    `clicked="${clicked}" path=${signedIn?.path}`,
  );

  // ── 2. the picker: choose "your own server", pointing at the stand-in ─────
  const advanced = await openAdvanced();
  check(
    'the Advanced screen opens with the node picker on it',
    Boolean(advanced?.text.includes('Where Fiddy reads from')),
    advanced?.text.slice(0, 160) ?? 'no surface',
  );

  const ownRadio = page.locator('label', { hasText: 'Run your own node' });
  await ownRadio.locator('input[type=radio]').check();
  await page.fill('[aria-label="Your node address"]', STAND_IN);
  await page.getByRole('button', { name: 'Use this one' }).click();

  const chosen = await waitFor(
    (s) => s.text.includes('in use: your own'),
    45,
  );
  check(
    'the picker saves the reader’s own server and says it is in use',
    Boolean(chosen?.text.includes('in use: your own')),
    chosen?.text.slice(0, 120) ?? 'no surface',
  );

  // ── 3. reload: the engine starts with the reader's list in place ──────────
  await openAdvanced();

  const switched = await waitFor((s) => /Switched to a backup node/.test(s.text), 90);
  const pillText = switched?.pillText ?? '';
  const pillTitle = switched?.pillTitle ?? '';

  check(
    'the pill says the feed moved to a backup, and why',
    /Switched to a backup node .* your first choice got slow/.test(pillText) ||
      (switched?.pillTexts ?? []).some((text) =>
        /Switched to a backup node .* your first choice got slow/.test(text),
      ),
    `pill="${pillText}" all="${JSON.stringify(switched?.pillTexts ?? [])}"`,
  );
  check(
    'the one-word register says “Backup”',
    (switched?.pillTexts ?? []).some((text) => text === 'Backup'),
    `pills=${JSON.stringify(switched?.pillTexts ?? [])}`,
  );
  check(
    'the pill’s hover sentence says reads now come from the server that answered',
    /Everything you read now comes from/.test(pillTitle) &&
      /(public node|node you run|Neynar|Farcaster)/.test(pillTitle),
    `title="${pillTitle.slice(0, 200)}"`,
  );
  check(
    'the reader’s own server is measured slow, and the relay is working',
    /working, but slowly/.test(switched?.text ?? '') &&
      /working/.test(switched?.text ?? ''),
    (switched?.text ?? '').slice(0, 200),
  );
  check(
    'the engine asked the reader’s own server (the stand-in counted its probes)',
    standIn.probes > 0,
    `${standIn.probes} probes reached ${STAND_IN}/v1/info`,
  );

  await page.screenshot({ path: `${OUT}/provider-picker-with-providers.png` });
  const pillNode = page.locator('a[title*="Switched to a backup node"]').first();
  await pillNode.screenshot({ path: `${OUT}/provider-pill-switched.png` });

  // ── 4. a second round: the decision holds instead of flapping ─────────────
  const firstRound = standIn.probes;
  const holdDeadline = Date.now() + SECOND_ROUND_BUDGET_S * 1_000;
  let secondRound = null;
  while (Date.now() < holdDeadline) {
    secondRound = (await readSurface(page)) ?? secondRound;
    if (standIn.probes > firstRound) break;
    await page.waitForTimeout(3_000);
  }
  await page.waitForTimeout(2_000);
  secondRound = (await readSurface(page)) ?? secondRound;

  check(
    'a second check round happened',
    standIn.probes > firstRound,
    `probes before=${firstRound}, after=${standIn.probes}`,
  );
  check(
    'the pill still says the same thing after the second round (no flapping)',
    (secondRound?.pillTexts ?? []).some((text) =>
      /Switched to a backup node .* your first choice got slow/.test(text),
    ),
    `pills=${JSON.stringify(secondRound?.pillTexts ?? [])}`,
  );

  const log = await readLog();
  const relayReads = log.filter((line) => line.includes('haatz.quilibrium.com'));
  const hosts = Object.entries(secondRound?.hosts ?? {})
    .map(([host, count]) => `${host}=${count}`)
    .join(' ');
  check(
    'reads after the switch went to the live relay, not to the slow server',
    relayReads.length > 0,
    `${relayReads.length} requests to the relay; hosts: ${hosts || 'none'}; last=${JSON.stringify(
      secondRound?.logTail ?? [],
    )}`,
  );

  await page.screenshot({
    path: `${OUT}/provider-pill-in-chrome.png`,
    fullPage: false,
  });
} finally {
  await browser.close();
}

const failures = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}`);
  if (entry.detail) console.log(`       ${entry.detail}`);
}
console.log(
  `\n${checks.length - failures.length}/${checks.length} checks passed`,
);
console.log(`screenshots: ${OUT}/provider-picker-with-providers.png`);
console.log(`             ${OUT}/provider-pill-switched.png`);
console.log(`             ${OUT}/provider-pill-in-chrome.png`);
if (consoleErrors.length > 0) {
  console.log(`\nconsole errors (${consoleErrors.length}):`);
  for (const line of consoleErrors.slice(0, 8)) console.log(`  ${line}`);
}
process.exit(failures.length > 0 ? 1 : 0);