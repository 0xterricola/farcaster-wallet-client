// End-to-end proof of the Network card the reader actually meets: it names the
// network Fiddy is reading, it offers only the networks this client can read,
// and pressing one really moves the reads.
//
//   cd apps/farcaster-web
//   HTTPS=true VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     VITE_FIDDY_NETWORK=hypersnap PROBE_VITE_CACHE_DIR=/tmp/network-probe-cache \
//     npx vite --config scripts/probe.vite.config.mjs --port 5217 --strictPort
//   NETWORK_PROBE_SERVER=https://localhost:5217 node scripts/verify-network-choice.mjs
//
// WHAT IS STUBBED, AND WHY
//   - the SIWF relay only, exactly as `verify-provider-picker.mjs` does it: a
//     real SIWE message signed by a throwaway key, so the app's own verifier
//     accepts the sign-in for real. Nothing else about the identity path is
//     faked.
//   - nothing else. The Hypersnap address the card offers is the real public
//     node, and "Check it" really asks it.
//
// WHAT IT ASSERTS
//   1. the Network card is on Advanced → your node, and it says which network
//      this client is reading (from what the build recorded — the deployment's
//      provenance, not a guess: /v1/info carries no network name)
//   2. both networks are NAMED, in the plain words the site uses
//   3. Snapchain is NOT offered on a build with no node of its own — it says
//      why and names the command that changes it, and there is no button to
//      press that would fail
//   4. Hypersnap IS offered, at the real public address, and pressing it saves
//      that address as this reader's server (the node picker then agrees)
//   5. the switch survives a reload, and "Your setup" names the network too
//
// Screenshots land in $NETWORK_PROBE_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.NETWORK_PROBE_SERVER ?? 'https://localhost:5217';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.NETWORK_PROBE_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'NETWORKS1';
const SIGNED_IN_FID = 3;
/** What the dev server was started with: VITE_FIDDY_NETWORK. */
const DECLARED = (process.env.NETWORK_PROBE_DECLARED ?? 'hypersnap').toLowerCase();
/** The real public Hypersnap node — the one address this client can read. */
const PUBLIC_HYPERSNAP = 'https://haatz.quilibrium.com';
/**
 * The other case: a build that DOES run a node of its own, so both networks can
 * be read here. Set NETWORK_PROBE_OWN_NODE to the address the server was built
 * with (VITE_SNAPCHAIN_HTTP_URL) and NETWORK_PROBE_DECLARED=snapchain.
 */
const OWN_NODE = process.env.NETWORK_PROBE_OWN_NODE ?? null;
const BOTH_OFFERED = DECLARED === 'snapchain' && OWN_NODE !== null;

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
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
};

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** What the network card and the node picker say on screen right now. */
const readCard = async (page) => {
  try {
    return await page.evaluate(() => {
      const card = document.querySelector('[data-fiddy="network-choice"]');
      const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
      return {
        onScreen: Boolean(card),
        cardText: text(card),
        current: text(document.querySelector('[data-fiddy="network-current"]')),
        hypersnapRoute: text(
          document.querySelector('[data-fiddy="network-route-hypersnap"]'),
        ),
        snapchainRoute: text(
          document.querySelector('[data-fiddy="network-route-snapchain"]'),
        ),
        snapchainBlocked: text(
          document.querySelector('[data-fiddy="network-blocked-snapchain"]'),
        ),
        useHypersnap: Boolean(
          document.querySelector('[data-fiddy="network-use-hypersnap"]'),
        ),
        useSnapchain: Boolean(
          document.querySelector('[data-fiddy="network-use-snapchain"]'),
        ),
        // Scoped INSIDE the card on purpose: [role=status] also matches the
        // provider pill elsewhere on the page, and taking that one would score
        // this check against someone else's sentence.
        status: text(card?.querySelector('[role="status"]') ?? null),
        nodeNetwork: text(document.querySelector('[data-fiddy="node-network"]')),
        pickerText: text(document.querySelector('[data-fiddy="node-choice"]')),
        pickerSaysPublic: /in use:\s*a public server/i.test(
          text(document.querySelector('[data-fiddy="node-choice"]')) ?? '',
        ),
      };
    });
  } catch {
    // A navigation in flight destroys the JS execution context; poll again.
    return null;
  }
};

const waitForCard = async (page, predicate, budgetS = 45) => {
  const deadline = Date.now() + budgetS * 1_000;
  let last = null;
  while (Date.now() < deadline) {
    const card = await readCard(page);
    if (card) {
      last = card;
      if (predicate(card)) return card;
    }
    await page.waitForTimeout(750);
  }
  return last;
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

const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

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

try {
  // ── 1. sign in through the stubbed relay ───────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => document.body.innerText.trim().length > 40,
    undefined,
    { timeout: 60_000 },
  );

  // The onboarding screen paints its text before its buttons (the step is a
  // lazy chunk), so wait for the door to EXIST rather than clicking at what may
  // still be an empty screen — an early click lands on nothing and the run
  // fails later as "not signed in", which reads like a product bug.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button, a, [role=button]')].some((el) =>
        /go social/i.test(el.textContent || ''),
      ),
    undefined,
    { timeout: 60_000 },
  );

  let clicked = null;
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = flat(await el.innerText());
    if (/go social/i.test(text)) {
      await el.click();
      clicked = text;
      break;
    }
  }

  // A completed sign-in leaves the onboarding path entirely.
  let signedIn = false;
  try {
    await page.waitForFunction(
      () => !window.location.pathname.startsWith('/welcome'),
      undefined,
      { timeout: 90_000 },
    );
    signedIn = true;
  } catch {
    signedIn = false;
  }
  check(
    'a completed sign-in lands in the client',
    clicked !== null && signedIn,
    `clicked="${clicked}" url=${page.url()}`,
  );

  // ── 2. Advanced → your node, where the Network card lives ──────────────────
  await page.goto(`${SERVER}/~/settings/node`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  const card = await waitForCard(page, (c) => c.onScreen, 60);
  check(
    'the Network card is on Advanced → your node',
    Boolean(card?.onScreen),
    card?.cardText?.slice(0, 120) ?? 'no card',
  );
  await page.screenshot({ path: `${OUT}/network-choice-1440.png` });

  // ── 3. it names the network it is reading, from recorded provenance ────────
  check(
    `it says which network this client is reading (${DECLARED})`,
    (card?.current ?? '').includes(DECLARED),
    `current="${card?.current}"`,
  );

  // ── 4. both networks are named, in the plain words ─────────────────────────
  check(
    'both networks are named in plain words',
    (card?.cardText ?? '').includes('Snapchain') &&
      (card?.cardText ?? '').includes('Hypersnap') &&
      (card?.cardText ?? '').includes('every account, cast and follow lives on') &&
      (card?.cardText ?? '').includes('not where your Farcaster account lives'),
    card?.cardText?.slice(0, 200) ?? 'no card',
  );

  if (BOTH_OFFERED) {
    // ── 5b. both networks can be read here: both are offered ─────────────────
    check(
      'Snapchain is offered, at the address this build runs',
      card?.snapchainRoute === OWN_NODE && card?.useSnapchain === true,
      `route="${card?.snapchainRoute}" button=${card?.useSnapchain}`,
    );
    check(
      'Hypersnap is offered too, at the public node',
      card?.hypersnapRoute === PUBLIC_HYPERSNAP && card?.useHypersnap === true,
      `route="${card?.hypersnapRoute}" button=${card?.useHypersnap}`,
    );
  } else {
    // ── 5. Snapchain is not offered without a node of its own, with the why ──
    check(
      'Snapchain is shown as unavailable, with the reason',
      Boolean(card?.snapchainBlocked) && !card?.useSnapchain,
      `blocked="${card?.snapchainBlocked?.slice(0, 90)}" button=${card?.useSnapchain}`,
    );
    check(
      'the reason names the command that changes it',
      (card?.snapchainBlocked ?? '').includes('fiddy node up --network snapchain'),
      card?.snapchainBlocked?.slice(0, 120) ?? 'no reason',
    );

    // ── 6. Hypersnap is offered at the real public address ───────────────────
    check(
      'Hypersnap is offered, at the public node',
      card?.hypersnapRoute === PUBLIC_HYPERSNAP && card?.useHypersnap === true,
      `route="${card?.hypersnapRoute}" button=${card?.useHypersnap}`,
    );
  }

  // ── 7. pressing it saves that address as this reader's server ──────────────
  await page.click(
    BOTH_OFFERED
      ? '[data-fiddy="network-use-snapchain"]'
      : '[data-fiddy="network-use-hypersnap"]',
  );
  const afterPress = await waitForCard(
    page,
    (c) => /answered in|did not answer/.test(c.status ?? ''),
    45,
  );
  check(
    'pressing it really asks the address and reports what it said',
    /answered in|did not answer/.test(afterPress?.status ?? ''),
    afterPress?.status ?? 'no status',
  );
  const pickerSays =
    BOTH_OFFERED
      ? (c) => /in use:\s*your own/i.test(c.pickerText ?? '')
      : (c) => c.pickerSaysPublic;
  const pickerAgrees = await waitForCard(page, pickerSays, 30);
  check(
    'the node picker agrees it is in use',
    pickerAgrees ? pickerSays(pickerAgrees) : false,
    pickerAgrees?.pickerText?.slice(0, 160) ?? 'no picker',
  );
  await page.screenshot({ path: `${OUT}/network-choice-after-1440.png` });

  // ── 8. the switch survives a reload, and "Your setup" names the network ────
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  const reloaded = await waitForCard(page, (c) => c.onScreen, 60);
  check(
    `after a reload the client still reads ${DECLARED}`,
    (reloaded?.current ?? '').includes(DECLARED),
    `current="${reloaded?.current}"`,
  );
  // "Your setup" paints its rows only once the health read has answered, so
  // wait for the row itself rather than for the page to exist.
  const withStatus = await waitForCard(
    page,
    (c) => c.nodeNetwork !== null,
    60,
  );
  check(
    '“Your setup” names the network too',
    withStatus?.nodeNetwork ===
      (DECLARED === 'snapchain' ? 'Snapchain' : 'Hypersnap'),
    `network="${withStatus?.nodeNetwork}"`,
  );

  // Console noise: expected CORS blocks on warpcast avatars and the wallet SDK's
  // own complaint are not this page's failures; an uncaught exception is.
  check(
    'no uncaught page error',
    pageErrors.filter((line) => !/HandledFetchError/.test(line)).length === 0,
    pageErrors.slice(0, 2).join(' | ') || 'none',
  );
} finally {
  await browser.close();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed` +
    (failed.length ? ` — failed: ${failed.map((f) => f.name).join('; ')}` : ''),
);
process.exit(failed.length === 0 ? 0 : 1);
