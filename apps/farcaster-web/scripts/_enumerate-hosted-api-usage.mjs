// Which hosted-API endpoints does each signed-in surface ask for?
//
// Temporary inventory tool for kanban card t_c9861884 (wire the signed-in
// client to our node). It runs the app in the fork's mock-API escape hatch
// (localStorage['farcasterApi.local'] = 'true' → http://localhost:8080) and
// INTERCEPTS those requests in the browser, so nothing is sent to the mock
// server and no other run's log is touched. Every request the app makes while
// a surface is on screen is recorded, per surface.
//
//   node scripts/_enumerate-hosted-api-usage.mjs
//
// Requires the dev server on https://localhost:5173 (pnpm start).
import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.ENUM_SERVER ?? 'https://localhost:5173';
const DOMAIN = new URL(SERVER).host;
const NONCE = 'e'.repeat(128);
const CHANNEL_TOKEN = 'ENUMTOK1';

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
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'content-type': 'application/json',
};

// The same permissive superset the shell-verification mock uses (every
// deeply-dereferenced key present and typed), so the surface renders and keeps
// asking for what it needs.
const user = {
  fid: 4242,
  username: 'fiddy',
  displayName: 'Fiddy Tester',
  pfp: { url: '' },
  profile: { bio: { text: 'enumerating' } },
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
  notifications: [],
  feed: { casts: [], news: [], users: [], next },
  next,
  viewerContext: { defaultFeed: 'forYou', following: false, followedBy: false },
  hasArchived: false,
  hasUnreadRequests: false,
  requestsCount: 0,
  voidCount: 0,
  inboxCount: 0,
  articlesCount: 0,
  notificationsCount: 0,
  warpTransactionCount: 0,
  unseenCount: 0,
  notificationTabs: [],
  unseenNotificationTabs: [],
  channelFeeds: [],
  channelFeedsUnseenStatus: [],
  enabledFeatureFlags: [],
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
  latestMainCastTimestamp: Date.now(),
};
const state = {
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
  user,
};

const bodyFor = (pathname) => {
  if (pathname.includes('onboarding-state')) return { result: { state } };
  if (pathname.includes('blocklist')) return { result: [] };
  if (pathname.includes('/v1/get-trending-topics')) return { result: { topics: [] } };
  return { result: { ...superset } };
};

const surfaceRequests = {};
const allRequests = [];
const consoleErrors = [];
let currentSurface = 'boot';

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
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));

await page.route('http://localhost:8080/**', async (route) => {
  const url = new URL(route.request().url());
  const key = `${route.request().method()} ${url.pathname}${url.search}`;
  allRequests.push(key);
  (surfaceRequests[currentSurface] ??= []).push(key);
  if (route.request().method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  }
  return route.fulfill({
    status: 200,
    headers: CORS,
    body: JSON.stringify(bodyFor(url.pathname)),
  });
});

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
  return route.fulfill({
    status: 200,
    headers: CORS,
    body: JSON.stringify({
      state: 'completed',
      nonce: NONCE,
      message,
      signature,
      fid: 4242,
      username: 'fiddy',
      displayName: 'Fiddy',
      bio: 'enumerating',
      pfpUrl: '',
    }),
  });
});

const settle = async (ms = 5000) => {
  await page.waitForTimeout(ms);
};

await page.goto(`${SERVER}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction(() => document.body.innerText.trim().length > 60, {
  timeout: 60000,
});

for (const el of await page.$$('button, a, [role=button]')) {
  const txt = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
  if (/go social/i.test(txt)) {
    await el.click();
    break;
  }
}
await page
  .waitForFunction(() => /You're signed in/.test(document.body.innerText), { timeout: 30000 })
  .catch(() => {});
await settle(7000);

const surfaces = [
  ['home', '/'],
  ['conversation', '/~/conversations/0x50184b62b4c52fd76628713562e1eda3dccaf63d'],
  ['profile-by-username', '/~/fiddy'],
  ['profile-by-fid', '/~/profiles/4242'],
  ['channel', '/~/channel/ai'],
  ['notifications', '/~/notifications'],
  ['search', '/~/search?q=farcaster'],
  ['explore', '/~/explore'],
  ['following', '/~/following'],
];

const seen = {};
for (const [name, path] of surfaces) {
  currentSurface = name;
  await page.goto(`${SERVER}${path}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await settle(5000);
  seen[name] = {
    url: page.url(),
    text: (await page.innerText('body')).replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

await browser.close();

const out = {};
for (const [k, v] of Object.entries(surfaceRequests)) {
  out[k] = Array.from(new Set(v)).sort();
}
console.log('--- per surface ---');
console.log(JSON.stringify(out, null, 1));
console.log('--- surface outcomes ---');
console.log(JSON.stringify(seen, null, 1));
console.log('--- union ---');
console.log(JSON.stringify(Array.from(new Set(allRequests)).sort(), null, 1));
console.log('--- page errors ---');
console.log(JSON.stringify(consoleErrors.slice(0, 10), null, 1));