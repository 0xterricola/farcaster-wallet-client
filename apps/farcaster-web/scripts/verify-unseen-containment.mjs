// End-to-end check of what happens to the shell when /v2/unseen fails.
//
//   node scripts/verify-unseen-containment.mjs
//
// Needs:
//   - the dev server (any https origin; PROBE_BASE, default
//     https://localhost:5173), and
//   - `npx tsc` run in packages/farcaster-client-hooks since the last change to
//     it — the web app imports that package's dist, so a source change there is
//     not live until it is rebuilt (and the dev server restarted).
//
// The app's own dev escape hatch is used (localStorage
// 'farcasterApi.local' = 'true', see src/constants/api.ts), so the fork's mock
// API is served from this process, and a real SIWF handshake is completed
// against a stubbed relay (a real SIWE signature, domain = this origin) so the
// app enters its own signed-in state. Everything else is the app.
//
// WHY THIS EXISTS
// The nav's badges come from `UnseenProvider`'s own read of /v2/unseen, which
// runs from a timer (`setTimeout` for the first poll, `setInterval` every 30s
// after). A rejected fetch there has no React owner, so no error boundary can
// contain it: before this card's fix it reached `window` as an uncaught
// `UnhandledFetchError` from `buildUnseenFetcher`, and the badges it failed to
// fill read exactly like badges that were zero.
//
// The three runs, each in a fresh context:
//   fail     every /v2/unseen read is aborted (net::ERR_FAILED — what a token
//            the edge will not serve produces): the rail stays on screen, one
//            honest line says the counts could not load, nothing uncaught
//   ok       every read succeeds: the line is absent and the badges carry the
//            real counts (so the line is not a permanent fixture)
//   recover  the first read fails, the rest succeed: the line clears itself
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const OUT = process.env.PROBE_SHOT_DIR ?? os.tmpdir();
const BASE = process.env.PROBE_BASE ?? 'https://localhost:5173';
const DOMAIN = new URL(BASE).host;
const NONCE = 'u'.repeat(128);
const CHANNEL_TOKEN = 'UNSEENTOK1';
const NOTIF_COUNT = 3;
// The first poll fires 2s after the provider mounts and the next one 30s after
// that, so 'recover' has to outwait one interval.
const SETTLE_MS = { fail: 14000, ok: 14000, recover: 48000 };

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${BASE}/login`,
  version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

// The fork's mock API: a superset of every key the shell's readers touch, so the
// only failure in the run is the one under test.
const user = {
  fid: 4242,
  username: 'fiddy',
  displayName: 'Fiddy Tester',
  pfp: { url: '' },
  profile: { bio: { text: 'verifying the unseen failure path' } },
  followerCount: 12,
  followingCount: 34,
  neynarScore: 0.5,
  activeOnFarcaster: true,
  score: 0.5,
  viewerContext: { following: false, followedBy: false },
  verifiedAddresses: { ethAddresses: [], solAddresses: [] },
  powerBadge: false,
};
const next = { cursor: '' };
const superset = {
  casts: [],
  news: [],
  users: [user],
  topics: [],
  rooms: [],
  frames: [],
  channels: [],
  feeds: [],
  streaks: [],
  verifications: [],
  conversations: [],
  collectionsOwned: [],
  requests: [],
  invites: [],
  members: [],
  items: [],
  feed: { casts: [], news: [], users: [], next },
  next,
  viewerContext: { defaultFeed: 'forYou', following: false, followedBy: false },
  hasArchived: false,
  hasUnreadRequests: false,
  requestsCount: 0,
  voidCount: 0,
  preferences: { ackFrameTransactionRisks: true, optOutChannelStreaks: false },
  context: {
    canAddLinks: true,
    showConnectedApps: false,
    signerRequestsEnabled: false,
    prompts: [],
    castActions: [],
    canAddCastAction: true,
    canEditAllChannels: false,
    adminForChannelKeys: [],
    modOfChannelKeys: [],
    memberOfChannelKeys: [],
    canUploadVideo: false,
    notificationTabsV2: [],
    higherClientEventSamplingRateEnabled: false,
    castShareEnabledMiniApps: [],
  },
  user,
  extras: { fid: user.fid, v2: true },
  enabledFeatureFlags: [],
  channelFeeds: [],
  channelFeedsUnseenStatus: [],
  inboxCount: NOTIF_COUNT,
  articlesCount: 0,
  notificationsCount: NOTIF_COUNT,
  warpTransactionCount: 0,
  unseenCount: 0,
  notificationTabs: [],
  unseenNotificationTabs: [],
};
const onboardingState = {
  result: {
    state: {
      id: 'probe-session',
      user,
      hasOnboarding: true,
      hasConfirmedEmail: true,
      needsRegistrationPayment: false,
      hasFid: true,
      hasFname: true,
      hasDelegatedSigner: true,
      hasSetupProfile: true,
      hasCompletedRegistration: true,
      hasStorage: true,
      hasWarpcastWalletAddress: false,
      hasWarpcastSolanaWalletAddress: false,
      geoRestricted: false,
    },
  },
};

const bodyFor = (pathname) => {
  if (pathname.includes('onboarding-state')) return onboardingState;
  if (pathname.includes('blocklist')) return { result: [] };
  if (pathname.includes('/v1/get-trending-topics')) return { result: { topics: [] } };
  return { result: { ...superset } };
};

const readRail = (page) =>
  page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    // A document being replaced by a navigation has no body for an instant, and a
    // bare read there is `Cannot read properties of null` — which killed the
    // sibling composer probe outright (MEASURED 2026-10-21). An empty rail is the
    // honest read of that instant; the checks below judge what is missing and say
    // so, instead of the run dying with nothing printed.
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    // "Notifications 3" — a badge appends its count to the entry's label.
    const labels = ['Feed', 'Wallet', 'Settings', 'Notifications', 'Direct Casts'];
    const nav = {};
    for (const label of labels) {
      nav[label] = [...document.querySelectorAll('a, button')].some((el) => {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        return (t === label || t.startsWith(`${label} `)) && visible(el);
      });
    }
    const line = document.querySelector('[data-fiddy="unseen-unavailable"]');
    return {
      url: window.location.pathname,
      text: text.slice(0, 300),
      nav,
      navVisible: Object.values(nav).filter(Boolean).length,
      shellFrame: Boolean(document.querySelector('.fiddy-shell-frame')),
      honestLine: line ? line.innerText.replace(/\s+/g, ' ').trim() : null,
      honestVisible: line ? line.getBoundingClientRect().height > 0 : false,
      badges: [...document.querySelectorAll('a, button')]
        .map((el) => ({
          label: (el.innerText || '').replace(/\s+/g, ' ').trim(),
          badge:
            (el.querySelector('div[class*="rounded-full"] span') || {}).textContent ?? null,
        }))
        .filter((x) => x.badge !== null),
      errorPage: /Could not reach Farcaster|Error retrieving data/.test(text),
    };
  });

const run = async (mode) => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem('farcasterApi.local', 'true');
    } catch {}
  });
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));

  let unseenReads = 0;
  await page.route('http://localhost:8080/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/v2/unseen') {
      unseenReads += 1;
      const fails = mode === 'fail' || (mode === 'recover' && unseenReads === 1);
      if (fails) {
        return route.abort('failed'); // net::ERR_FAILED
      }
    }
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify(bodyFor(url.pathname)),
    });
  });
  await page.route('ws://localhost:8080/**', async (route) => route.abort('failed'));

  let statusCalls = 0;
  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
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
    statusCalls += 1;
    const pending = statusCalls <= 2;
    return route.fulfill({
      status: pending ? 202 : 200,
      headers: CORS,
      body: JSON.stringify(
        pending
          ? { state: 'pending', nonce: NONCE }
          : {
              state: 'completed',
              nonce: NONCE,
              message,
              signature,
              fid: 4242,
              username: 'fiddy',
              displayName: 'Fiddy',
              bio: 'your agent, living in your pocket',
              pfpUrl: 'https://example.com/pfp.png',
            },
      ),
    });
  });

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => (document.body?.innerText ?? '').trim().length > 60, {
    timeout: 90000,
  });

  for (const el of await page.$$('button, a, [role=button]')) {
    const txt = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(txt)) {
      await el.click();
      break;
    }
  }

  const signedIn = await page
    .waitForFunction(() => /You're signed in/.test((document.body?.innerText ?? '')), { timeout: 60000 })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(SETTLE_MS[mode]);
  const rail = await readRail(page);
  await page.screenshot({ path: `${OUT}/unseen-containment-${mode}.png` });
  await browser.close();

  return { mode, signedIn, unseenReads, pageErrors, rail };
};

const results = {};
for (const mode of ['fail', 'ok', 'recover']) {
  results[mode] = await run(mode);
}
console.log(JSON.stringify(results, null, 1));

const { fail, ok, recover } = results;
const noErrors = (r) => r.pageErrors.length === 0;
const shellUp = (r) =>
  r.rail.shellFrame && r.rail.navVisible >= 5 && !r.rail.errorPage;

const checks = {
  'a session still reaches the signed-in shell': fail.signedIn && ok.signedIn && recover.signedIn,
  'the failing read happens (the probe is not passing by accident)':
    fail.unseenReads >= 1 && recover.unseenReads >= 2,
  'with /v2/unseen failing, nothing uncaught reaches window': noErrors(fail),
  'with /v2/unseen failing, the rail and the shell stay on screen': shellUp(fail),
  'with /v2/unseen failing, a visible line says the counts could not load':
    fail.rail.honestVisible && /unseen counts could not load|couldn.t load/i.test(fail.rail.honestLine ?? ''),
  'with /v2/unseen succeeding, the line is gone and the badges carry the counts':
    noErrors(ok) &&
    !ok.rail.honestLine &&
    ok.rail.badges.length >= 2 &&
    ok.rail.badges.every((b) => b.badge === String(NOTIF_COUNT)),
  'after the read recovers, the line clears itself':
    noErrors(recover) && !recover.rail.honestLine && recover.rail.badges.length >= 2,
};

console.log('--- checks ---');
let failed = 0;
for (const [name, passed] of Object.entries(checks)) {
  if (!passed) failed += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`PROBE_EXIT=${failed === 0 ? 0 : 1} (${failed} failed)`);
process.exitCode = failed === 0 ? 0 : 1;