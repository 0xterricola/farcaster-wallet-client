// What a signed-in owner gets on /~/agent: a chat, not a pairing form.
//
//   pnpm start                                  # https://localhost:5173
//   node apps/farcaster-web/scripts/verify-agent-autopair.mjs
//
// Point it at another origin when the client under test is served elsewhere:
//
//   AUTOPAIR_ORIGIN=https://localhost:5199 node apps/farcaster-web/scripts/verify-agent-autopair.mjs
//
// Screenshots land in $AUTOPAIR_SHOT_DIR (default: the system temp dir).
//
// THE CLIENT UNDER TEST MUST BE NODE-BACKED. A client started without
// VITE_SNAPCHAIN_HTTP_URL sends a signed-in session to the device-only landing
// (`~/components/session/useDeviceOnlySession`), so `/~/agent` never renders the
// agent surface and every check below reads that landing instead. Measured on
// 2026-10-22: that is exactly what the first run of this probe measured, and it
// is a harness gap, not a product bug. Start it the way the release does:
//
//   VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com HTTPS=true \
//     npx vite --port 5266 --strictPort
//
// The check named "the client under test is node-backed" fails loudly when a run
// forgets it.
//
// WHAT IT REPRODUCES, AND WHY THESE CHECKS
// The bug: somebody named their agent, picked the built-in brain, signed in with
// Farcaster — and `/~/agent` showed "Hatch your Fiddy · soon" plus a form asking
// for an agent service address and a session token. So this probe walks the real
// way in (the greeting, the one setup screen, the ready sheet, the sign-in) and
// then holds the surface to four claims:
//
//   1. the service is asked for the owner's session, and the request carries the
//      proof from the sign-in and the name the owner chose — nothing else;
//   2. the agent API is then used with the session that came back;
//   3. the surface is a CHAT: the owner's name, the conversation they already had
//      before signing in, and an input — and no URL field or token field exists;
//   4. when that service cannot start an agent (closed, or unreachable), the
//      header says so in one sentence and the form stays one disclosure away.
//
// Only the SIWF relay, the trial route, the owner-session route and the agent
// API are stubbed. The relay is stubbed with a REAL SIWE message signed by a
// throwaway key, so the app's own verifier has to accept it — that is what makes
// the proof this probe then forwards a real one. Everything else is the app.
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const OUT = process.env.AUTOPAIR_SHOT_DIR ?? os.tmpdir();
const ORIGIN = process.env.AUTOPAIR_ORIGIN ?? 'https://localhost:5173';
const DOMAIN = new URL(ORIGIN).host;
const NONCE = 'c'.repeat(128);
const CHANNEL_TOKEN = 'TESTTOK1';
const AGENT_NAME = 'Flo';
const TRIAL_MESSAGE = 'What can you do for me on Farcaster?';
const TRIAL_REPLY = 'I read your mentions and draft replies. Shall I start?';
const SESSION_TOKEN = 'owner-session-token-from-the-service';
const NOT_OPEN_SENTENCE =
  'This service cannot start your agent yet. Nothing was changed.';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `https://${DOMAIN}/login`,
  version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'content-type': 'application/json',
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
};

const where = (page) => new URL(page.url()).pathname;

const bodyText = (page) =>
  page
    .evaluate(() =>
      (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim(),
    )
    .catch(() => '');

/** Press the first visible control whose text matches, and answer its label. */
const pressByText = async (page, re) => {
  const controls = await page.$$('button, a, [role=button]').catch(() => []);
  for (const el of controls) {
    let label = '';
    try {
      label = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    } catch {
      // The page navigated under us while reading: there is nothing to press
      // here any more, and a harness must not abort a run for that.
      return null;
    }
    if (re.test(label) && (await el.isVisible().catch(() => false))) {
      try {
        await el.click();
      } catch {
        return label;
      }
      return label;
    }
  }
  return null;
};

/** What the agent surface is showing, in the terms the bug is about. */
const readSurface = (page) =>
  page.evaluate(() => {
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    return {
      path: window.location.pathname,
      // The whole page, because every claim here is "is this sentence on the
      // surface" — the shell's navigation precedes the agent panel in the
      // document, so a truncated prefix measures the sidebar and nothing else
      // (that is how this probe's first green-ish runs mis-read the surface).
      text,
      // For a human reading a failing line.
      textPreview: text.slice(0, 400),
      urlFields: document.querySelectorAll('input[type="url"]').length,
      tokenFields: Array.from(document.querySelectorAll('label')).filter(
        (label) => /session token/i.test(label.textContent || ''),
      ).length,
      chatInput: Boolean(
        document.querySelector('textarea[placeholder="Message your agent…"]'),
      ),
      // A client with no server named sends a signed-in session here instead of
      // to the agent surface — named so a run can say why it saw no surface.
      deviceOnlyLanding: /signed in on this device/i.test(text),
      // The not-awake state replaces the input with a sentence rather than
      // leaving a field that would swallow a message.
      awaitingNote: Array.from(document.querySelectorAll('[role="status"]'))
        .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((value) => /once it is awake/i.test(value)).length,
      headings: Array.from(document.querySelectorAll('h1, h2')).map((h) =>
        (h.textContent || '').trim(),
      ),
      buttons: Array.from(document.querySelectorAll('button, a, [role=button]'))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 24),
      liveRegions: Array.from(
        document.querySelectorAll('[role="status"],[role="alert"]'),
      )
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index),
      ownerMessages: document.querySelectorAll(
        '[aria-label="Conversation with your agent"] div',
      ).length,
    };
  });

const runCase = async (browser, { label, ownerSession }) => {
  const events = [];
  const seen = { ownerSession: [], agentApi: [], trial: 0 };

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error')
      events.push(`console.error: ${m.text().slice(0, 160)}`);
  });
  page.on('pageerror', (e) =>
    events.push(`pageerror: ${String(e).slice(0, 160)}`),
  );

  // The SIWF relay, with a real signed message.
  let statusCalls = 0;
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
              authMethod: 'custody',
            },
      ),
    });
  });

  // One real reply before sign-in, so the signed-in chat has something to adopt.
  await page.route('**/api/fiddy/trial-chat', async (route) => {
    seen.trial += 1;
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        reply: TRIAL_REPLY,
        source: 'fiddy',
        note: 'That answer came from Fiddy’s own brain.',
        agentName: AGENT_NAME,
      }),
    });
  });

  // The route this card is about.
  await page.route('**/api/fiddy/owner-session', async (route) => {
    const request = route.request();
    seen.ownerSession.push({
      body: (() => {
        try {
          return JSON.parse(request.postData() ?? '{}');
        } catch {
          return null;
        }
      })(),
    });
    return ownerSession(route);
  });

  // The agent service itself: health, the catalog, and the owner's agents.
  await page.route('https://fiddy.fun/api/**', async (route) => {
    const url = new URL(route.request().url());
    seen.agentApi.push({
      path: url.pathname,
      authorization: route.request().headers().authorization ?? null,
    });
    const body = (() => {
      if (url.pathname === '/api/health') return { ok: true, mode: 'demo' };
      if (url.pathname === '/api/hermes/catalog')
        return { items: [], counts: { skills: 0, plugins: 0 } };
      if (url.pathname === '/api/agents/instances')
        return {
          ok: true,
          data: [{ id: 'inst-1', name: AGENT_NAME, status: 'running' }],
        };
      if (url.pathname.endsWith('/integrations'))
        return { toolkits: [], connections: [] };
      return { ok: false, code: 'NOT_DEPLOYED' };
    })();
    const status = url.pathname === '/api/fiddy/hatch-quote' ? 404 : 200;
    return route.fulfill({
      status,
      headers: CORS,
      body: JSON.stringify(
        status === 404 ? { ok: false, code: 'NOT_DEPLOYED' } : body,
      ),
    });
  });

  // 1. The way in: the greeting, the one setup screen, the ready sheet.
  // MEASURED: a cold dev server takes ~110s to render its first screen in this
  // monorepo (module scripts block DOMContentLoaded, so waiting for that event is
  // not the same thing as waiting for the app). Wait for the screen itself.
  await page.goto(`${ORIGIN}/welcome`, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForSelector('[data-fiddy-step="hi"]', { timeout: 180000 });
  await pressByText(page, /^Say hi$/);
  await page.waitForSelector('input[placeholder="Fiddy"]', { timeout: 20000 });
  await page.fill('input[placeholder="Fiddy"]', AGENT_NAME);
  await pressByText(page, /^Continue$/);
  await page
    .waitForSelector('[data-fiddy-step="ready"]', { timeout: 20000 })
    .catch(() => undefined);
  await page.waitForTimeout(600);
  const readyText = await bodyText(page);

  // 2. One real message before signing in: the exchange the chat must adopt.
  // The trial box's own field and its own send action — measured, `TrialChat`
  // renders `<input data-trial="input">` plus `<button data-trial="send">`, and
  // looking for a textarea here is how the first runs of this probe silently
  // skipped the whole step (`trialFieldFound: false`).
  const trialField = page
    .locator('[data-fiddy="trial"] [data-trial="input"]')
    .first();
  const trialFieldFound = (await trialField.count()) > 0;
  let trialPressed = null;
  if (trialFieldFound) {
    await trialField.fill(TRIAL_MESSAGE);
    trialPressed = await page
      .locator('[data-fiddy="trial"] [data-trial="send"]')
      .first()
      .click({ timeout: 5000 })
      .then(() => 'Send')
      .catch(() => null);
    await page
      .waitForFunction(
        (reply) => (document.body?.innerText ?? '').includes(reply),
        TRIAL_REPLY,
        { timeout: 20000 },
      )
      .catch(() => undefined);
  }
  const trialAnsweredOnScreen = (await bodyText(page)).includes(TRIAL_REPLY);
  const trialKeptBeforeSignIn = await page.evaluate(() => {
    try {
      return window.localStorage.getItem('fiddy.trial');
    } catch {
      return null;
    }
  });

  // 3. The sign-in, which is what leaves the proof behind.
  const signedIn = await pressByText(page, /Go social|sign in/i);
  await page.waitForTimeout(4000);
  const proofKept = await page.evaluate(() => {
    try {
      return window.sessionStorage.getItem('fiddy.siwf.proof');
    } catch {
      return null;
    }
  });

  // 4. The surface this card is about.
  await page.goto(`${ORIGIN}/~/agent`, { waitUntil: 'commit', timeout: 60000 });
  await page
    .waitForSelector(
      'textarea[placeholder="Message your agent…"], [role="alert"]',
      { timeout: 120000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(4000);
  const surface = await readSurface(page);
  await page.screenshot({
    path: `${OUT}/autopair-${label}-1-surface.png`,
    fullPage: true,
  });

  // 5. The self-hoster's form, one disclosure away — and only there.
  let revealedTokenField = false;
  const revealed = await pressByText(page, /pair it$/);
  if (revealed) {
    await page.waitForTimeout(400);
    const after = await readSurface(page);
    revealedTokenField = after.tokenFields > 0;
    await page.screenshot({
      path: `${OUT}/autopair-${label}-2-pair-own.png`,
      fullPage: true,
    });
  }

  await context.close();
  return {
    seen,
    surface,
    events,
    prepared: {
      readyText: readyText.slice(0, 200),
      whereAfterSignIn: where(page),
      signedIn,
      trialEmitted: seen.trial > 0,
      trialFieldFound,
      trialPressed,
      trialAnsweredOnScreen,
      trialKeptBeforeSignIn,
      proofKept,
      revealed,
      revealedTokenField,
    },
  };
};

const main = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });

  // A. The service mints the session: the owner lands in Chat.
  const open = await runCase(browser, {
    label: 'open',
    ownerSession: (route) =>
      route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          session: {
            token: SESSION_TOKEN,
            expiresAt: Date.now() + 1_000_000,
            fid: 4242,
            subject: 'farcaster:4242',
            name: AGENT_NAME,
          },
          agent: { name: AGENT_NAME, brain: { kind: 'default' } },
          provisioning: {
            open: false,
            code: 'HATCH_NOT_ENABLED',
            message:
              'Your agent is not awake on this service yet — starting one is not open here.',
          },
        }),
      }),
  });

  check(
    'the pre-login exchange was kept for the signed-in chat',
    typeof open.prepared.trialKeptBeforeSignIn === 'string' &&
      open.prepared.trialKeptBeforeSignIn.includes(TRIAL_REPLY),
    `trial box: ${open.prepared.trialFieldFound ? 'found' : 'NOT FOUND'}, pressed: ${
      open.prepared.trialPressed ?? 'nothing'
    }, reply on screen: ${open.prepared.trialAnsweredOnScreen}, kept: ${String(
      open.prepared.trialKeptBeforeSignIn,
    ).slice(0, 80)}`,
  );
  check(
    'the sign-in left a proof for the exchange',
    typeof open.prepared.proofKept === 'string' &&
      open.prepared.proofKept.includes('4242'),
    String(open.prepared.proofKept).slice(0, 80),
  );
  const openAsk = open.seen.ownerSession[0]?.body;
  check(
    'the service was asked for the owner session, with the proof and the chosen name',
    Boolean(openAsk) &&
      openAsk.proof?.fid === 4242 &&
      typeof openAsk.proof?.message === 'string' &&
      typeof openAsk.proof?.signature === 'string' &&
      openAsk.agent?.name === AGENT_NAME &&
      openAsk.agent?.brain?.kind === 'default',
    openAsk
      ? JSON.stringify(openAsk).slice(0, 160)
      : 'the route was never called',
  );
  check(
    'the session that came back is what the agent API is called with',
    open.seen.agentApi.some(
      (call) =>
        call.path === '/api/agents/instances' &&
        call.authorization === `Bearer ${SESSION_TOKEN}`,
    ),
    JSON.stringify(open.seen.agentApi.slice(0, 6)),
  );
  check(
    'the surface is a chat: the owner’s name, the exchange they already had, an input',
    open.surface.text.includes(AGENT_NAME) &&
      open.surface.text.includes(TRIAL_MESSAGE) &&
      open.surface.text.includes(TRIAL_REPLY) &&
      open.surface.chatInput,
    open.surface.text.slice(0, 160),
  );
  check(
    'no address field and no token field exist on arrival',
    open.surface.urlFields === 0 && open.surface.tokenFields === 0,
    `${open.surface.urlFields} url field(s), ${open.surface.tokenFields} token field(s)`,
  );
  check(
    'the client under test is node-backed (a signed-in session reaches this surface)',
    !open.surface.deviceOnlyLanding,
    open.surface.deviceOnlyLanding
      ? 'the browser landed on the device-only session page — start the client with VITE_SNAPCHAIN_HTTP_URL set (see the header of this file)'
      : 'node-backed',
  );
  check(
    'a paired owner is not offered the pairing form at all',
    open.prepared.revealed === null,
    open.prepared.revealed ?? 'no pairing action on the paired surface',
  );

  // B. The service refuses: one sentence, still a chat, still no form.
  const closed = await runCase(browser, {
    label: 'closed',
    ownerSession: (route) =>
      route.fulfill({
        status: 503,
        headers: CORS,
        body: JSON.stringify({
          ok: false,
          code: 'OWNER_SESSION_NOT_OPEN',
          message: NOT_OPEN_SENTENCE,
        }),
      }),
  });

  check(
    'a refusal is said in the service’s own words, in the header',
    closed.surface.text.includes(NOT_OPEN_SENTENCE),
    closed.surface.text.slice(0, 200),
  );
  check(
    'the owner’s name is on screen even when no agent was started',
    closed.surface.text.includes(AGENT_NAME),
    closed.surface.headings.join(' | '),
  );
  check(
    'a refusal still shows the conversation they already had, and hides both fields',
    closed.surface.text.includes(TRIAL_MESSAGE) &&
      closed.surface.text.includes(TRIAL_REPLY) &&
      closed.surface.urlFields === 0 &&
      closed.surface.tokenFields === 0,
    `${closed.surface.urlFields} url, ${closed.surface.tokenFields} token`,
  );
  check(
    'and the input is a sentence, not a field that would swallow a message',
    closed.surface.chatInput === false && closed.surface.awaitingNote === 1,
    `chat input: ${closed.surface.chatInput}, awaiting sentence: ${closed.surface.awaitingNote}`,
  );
  check(
    'and the hatch CTA is gone — "soon" is not what this surface says',
    !closed.surface.buttons.some((label) => /Hatch your Fiddy/.test(label)),
    closed.surface.buttons.join(' | '),
  );
  check(
    'the form is reachable for a self-hoster, when they ask for it',
    closed.prepared.revealedTokenField,
    String(closed.prepared.revealed),
  );

  // C. The service cannot be reached at all: a sentence, never a form.
  const unreachable = await runCase(browser, {
    label: 'unreachable',
    ownerSession: (route) => route.abort(),
  });

  check(
    'an unreachable service is answered with a sentence and no form',
    unreachable.surface.text.includes('did not answer') &&
      unreachable.surface.text.includes(TRIAL_REPLY) &&
      unreachable.surface.urlFields === 0 &&
      unreachable.surface.tokenFields === 0,
    unreachable.surface.text.slice(0, 200),
  );

  await browser.close();

  const failed = checks.filter((c) => !c.ok);
  for (const { name, ok, detail } of checks) {
    console.log(
      `${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`,
    );
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed — screenshots in ${OUT}`,
  );
  if (failed.length) {
    console.log(
      `console/page errors seen: ${[...open.events, ...closed.events, ...unreachable.events].slice(0, 8).join(' | ')}`,
    );
    process.exitCode = 1;
  }
};

await main();
