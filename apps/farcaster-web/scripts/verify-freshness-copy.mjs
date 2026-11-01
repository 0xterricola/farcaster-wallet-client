// End-to-end proof of the words the reader actually meets when the node they
// read from is behind: the client says what the field says, per shard, and never
// calls a duration "blocks".
//
//   cd apps/farcaster-web
//   HTTPS=true VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     VITE_FIDDY_NETWORK=hypersnap PROBE_VITE_CACHE_DIR=/tmp/freshness-probe-cache \
//     npx vite --config scripts/probe.vite.config.mjs --port 5183 --strictPort
//   FRESHNESS_SERVER=https://localhost:5183 FRESHNESS_BODY=stale \
//     node scripts/verify-freshness-copy.mjs
//   FRESHNESS_SERVER=https://localhost:5183 FRESHNESS_BODY=healthy \
//     node scripts/verify-freshness-copy.mjs
//
// WHAT IS STUBBED, AND WHY
//   - the SIWF relay only, exactly as `verify-provider-picker.mjs` does it: a
//     real SIWE message signed by a throwaway key, so the app's own verifier
//     accepts the sign-in for real.
//   - the public node's `/v1/info` reads, and only those: they are answered with
//     one of the two bodies measured from that node on 2026-10-24, so the run
//     does not depend on how the node happens to be behaving at the moment.
//     Every other read of that host is passed through to the real node, so
//     nothing here invents data.
//
// WHAT IT ASSERTS
//   FRESHNESS_BODY=stale   (one shard keeping up, two hours behind)
//     1. the sentence the client composes is on screen, word for word
//     2. no copy on that screen says "blocks behind"
//     3. the pill's hover title carries the same sentence
//     4. the node really was asked (the stub counts its own `/v1/info` reads)
//   FRESHNESS_BODY=healthy (every shard keeping up)
//     5. it says the node is answering normally, and never calls it behind
//
// Screenshots land in $FRESHNESS_SHOT_DIR (default: the system temp dir).
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.FRESHNESS_SERVER ?? 'https://localhost:5183';
const SHOTS = process.env.FRESHNESS_SHOT_DIR ?? os.tmpdir();
const DOMAIN = new URL(SERVER).host;
const NONCE = 'a'.repeat(128);
const RELAY = 'https://haatz.quilibrium.com';
const WHICH = process.env.FRESHNESS_BODY ?? 'stale';
const SENTENCE =
  WHICH === 'stale'
    ? 'It answered, but the newest blocks on shards 1 and 2 are 4h 39m and 13m 15s old.'
    : 'Answering normally';

/** MEASURED 2026-10-24 16:27:35 UTC: shard 0 4 s, shard 1 16,773 s, shard 2 795 s. */
const STALE_BODY = {
  version: '0.13.5',
  numShards: 2,
  shardInfos: [
    { shardId: 0, maxHeight: 48_838_710, blockDelay: 4 },
    { shardId: 1, maxHeight: 49_498_964, blockDelay: 16_773 },
    { shardId: 2, maxHeight: 49_350_083, blockDelay: 795 },
  ],
};
const HEALTHY_BODY = {
  ...STALE_BODY,
  version: '1.5.5',
  isSyncing: false,
  shardInfos: [
    { shardId: 0, maxHeight: 48_838_710, blockDelay: 1 },
    { shardId: 1, maxHeight: 49_498_964, blockDelay: 0 },
    { shardId: 2, maxHeight: 49_350_083, blockDelay: 2 },
  ],
};

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

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push({ name, ok: Boolean(ok), detail });
const stub = { probes: 0 };

const browser = await chromium.launch({
  channel: 'chrome',
  ignoreHTTPSErrors: true,
  args: ['--ignore-certificate-errors'],
});
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();

await page.route('https://relay.farcaster.xyz/**', async (route) => {
  const method = route.request().method();
  if (method === 'OPTIONS')
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  if (method === 'POST')
    return route.fulfill({
      status: 201,
      headers: CORS,
      body: JSON.stringify({
        channelToken: 'F1',
        url: 'https://farcaster.xyz/~/siwf?channelToken=F1',
        nonce: NONCE,
      }),
    });
  return route.fulfill({
    status: 200,
    headers: CORS,
    body: JSON.stringify({
      state: 'completed',
      nonce: NONCE,
      message,
      signature,
      fid: 3,
      username: 'dwr',
      displayName: 'dwr',
    }),
  });
});
await page.route(`${RELAY}/**`, async (route) => {
  if (new URL(route.request().url()).pathname !== '/v1/info')
    return route.continue();
  stub.probes += 1;
  return route.fulfill({
    status: 200,
    headers: CORS,
    body: JSON.stringify(WHICH === 'stale' ? STALE_BODY : HEALTHY_BODY),
  });
});

const surface = async () =>
  page
    .evaluate(() => ({
      path: window.location.pathname,
      text: document.body.innerText.replace(/\s+/g, ' ').trim(),
      titles: [...document.querySelectorAll('a[title]')]
        .map((a) => a.getAttribute('title'))
        .filter(Boolean),
    }))
    .catch(() => null);

const settle = async (predicate, budgetS) => {
  const deadline = Date.now() + budgetS * 1_000;
  let last = null;
  while (Date.now() < deadline) {
    const s = await surface();
    if (s) {
      last = s;
      if (predicate(s)) return s;
    }
    await page.waitForTimeout(1_000);
  }
  return last;
};

try {
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(3_000);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const here = await page
      .evaluate(() => window.location.pathname)
      .catch(() => '?');
    if (here === '/') break;
    for (const el of await page.$$(
      '#modal-root button, #modal-root [role=button], button, a, [role=button]',
    )) {
      const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
      if (/go social|sign in|continue|connect/i.test(text)) {
        await el.click({ force: true }).catch(() => {});
        console.log(`attempt ${attempt}: clicked ${text}`);
        break;
      }
    }
    await page.waitForTimeout(8_000);
  }
  console.log(
    `after sign-in: path=${await page.evaluate(() => window.location.pathname).catch(() => '?')}`,
  );

  await page.goto(`${SERVER}/~/settings/node`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  const settings = await settle(
    (s) =>
      s.text.includes('Where Fiddy reads from') &&
      /newest block|Answering normally/.test(s.text),
    90,
  );
  const text = settings?.text ?? '';
  const titles = settings?.titles ?? [];

  console.log(
    `\nFRESHNESS_BODY=${WHICH}  (stub answered /v1/info ${stub.probes} times)`,
  );
  console.log(`path: ${settings?.path}`);
  console.log(`looking for: ${SENTENCE}`);
  const at = text.indexOf(SENTENCE);
  console.log(
    `on-screen context: ${at >= 0 ? text.slice(Math.max(0, at - 220), at + SENTENCE.length + 60) : '(not found)'}`,
  );
  console.log(`page text around it: ${text.slice(0, 900)}`);

  check(
    'the sentence the client composes is on screen',
    text.includes(SENTENCE),
    text.slice(0, 200),
  );
  check(
    'no copy on screen says "blocks behind"',
    !text.includes('blocks behind'),
  );
  if (WHICH === 'stale') {
    check(
      'the pill’s hover title carries it too',
      titles.some((t) => t.includes(SENTENCE)),
      titles.join(' || ').slice(0, 300),
    );
    check(
      'the node really was asked',
      stub.probes > 0,
      `${stub.probes} probes`,
    );
  } else {
    check(
      'a healthy node is not described as behind',
      !/newest block/.test(text),
      text.slice(0, 200),
    );
  }
  await page.screenshot({ path: `${SHOTS}/freshness-${WHICH}-screen.png` });
} finally {
  await browser.close();
}

for (const c of checks)
  console.log(
    `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : `\n       ${c.detail}`}`,
  );
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
