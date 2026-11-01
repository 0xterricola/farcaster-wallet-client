// What the last screen of the way in does in a real browser: one message to the
// agent you just named, before the Farcaster sign-in.
//
//   pnpm --filter farcaster-web start          # https://localhost:5173
//   node apps/farcaster-web/scripts/verify-onboarding-trial-chat.mjs
//
// Point it at another origin when the client under test is served elsewhere:
//
//   TRIAL_ORIGIN=https://localhost:5199 node apps/farcaster-web/scripts/verify-onboarding-trial-chat.mjs
//
// Screenshots land in $TRIAL_SHOT_DIR (default: the system temp dir).
//
// WHAT IT MEASURES, AND WHY THESE CHECKS
// The flow says "No account needed for this part" and then asks for a sign-in,
// so the ready sheet now carries one real message. Three outcomes have to be
// true in a browser, and each one is walked rather than read:
//
//   1. the box is on the last screen, names the agent, and offers its openers;
//   2. an OPENER sends the message (a chip that only filled the field would cost
//      the visitor their one turn on a second press) and the real reply replaces
//      the input, with the primary action becoming the named "Save … & sign in";
//   3. when no brain can answer, the screen says so in words — no fabricated
//      reply, and the sign-in is still there.
//
// The service is answered by Playwright's route interception, not by a canned
// page script: the client runs its own code path (fetch → parse → render), and
// the third case below is measured against whatever is actually deployed when
// no interception is installed.
import os from 'node:os';

import { chromium } from 'playwright';

const OUT = process.env.TRIAL_SHOT_DIR ?? os.tmpdir();
const ORIGIN = process.env.TRIAL_ORIGIN ?? 'https://localhost:5173';
const LIVE = process.env.TRIAL_LIVE === '1';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
};

const appears = async (page, selector, timeout = 20000) => {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
};

const bodyText = (page) =>
  page
    .evaluate(() =>
      (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim(),
    )
    .catch(() => '');

const primaryText = (page) =>
  page
    .locator('.fiddy-primary-btn')
    .first()
    .innerText()
    .then((text) => text.replace(/\s+/g, ' ').trim())
    .catch(() => '');

const primaryHighlighted = (page) =>
  page
    .locator('.fiddy-primary-btn')
    .first()
    .getAttribute('data-highlighted')
    .catch(() => null);

/** Walk step 1 so the ready sheet belongs to a named agent, as a visitor does. */
const walkToReady = async (page) => {
  await page.goto(`${ORIGIN}/welcome`, { waitUntil: 'domcontentloaded' });
  await appears(page, '[data-fiddy-step="hi"]', 30000);
  for (const el of await page.$$('button')) {
    const label = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/^Say hi$|^Continue as /.test(label) && (await el.isVisible())) {
      await el.click();
      break;
    }
  }
  await appears(page, '[data-fiddy-step="setup"]', 30000);
  await page.fill('input[placeholder="Fiddy"]', 'Momo');
  for (const el of await page.$$('button')) {
    const label = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (label === 'Continue' && (await el.isVisible())) {
      await el.click();
      break;
    }
  }
  await appears(page, '[data-fiddy-step="ready"]', 30000);
};

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  // The dev server transforms this app on first request and that takes ~40 s on
  // a cold server, so the waits are generous: a stopwatch is not a measurement.
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);
  const consoleErrors = [];
  const requests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) =>
    consoleErrors.push(`pageerror: ${String(error)}`),
  );
  page.on('request', (request) => {
    if (request.url().includes('/api/fiddy/trial-chat')) {
      requests.push(request.url());
    }
  });

  // 1. The box is on the last screen, and it names the agent the visitor chose.
  await walkToReady(page);
  const readyText = await bodyText(page);
  await page.screenshot({
    path: `${OUT}/trial-1-ready-box.png`,
    fullPage: true,
  });
  check(
    'the ready sheet carries the trial, naming the agent the visitor chose',
    (await appears(page, '[data-fiddy="trial"]', 5000)) &&
      /Say hi to Momo/.test(readyText) &&
      /Step 2 of 2/i.test(readyText),
    readyText.slice(0, 110),
  );
  check(
    'the openers are offered instead of a blank field',
    /What can you do for me on Farcaster\?/.test(readyText) &&
      /Draft a morning intro cast/.test(readyText) &&
      /Watch my mentions/.test(readyText),
  );
  check(
    'the sign-in is the ordinary one until the agent has answered',
    !/Save Momo/.test(await primaryText(page)) &&
      (await primaryHighlighted(page)) === null,
    await primaryText(page),
  );

  // 2. An opener sends the message, and the real reply replaces the input.
  await page.route('**/api/fiddy/trial-chat', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        reply:
          'I can read your mentions and draft casts for you — nothing is posted until you say so.',
        source: 'operator',
        note: null,
        agentName: 'Momo',
      }),
    });
  });
  await page.click('[data-trial-starter="Watch my mentions"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-fiddy="trial"]')
        ?.getAttribute('data-trial') === 'answered',
    null,
    { timeout: 15000 },
  );
  const answeredText = await bodyText(page);
  await page.screenshot({
    path: `${OUT}/trial-2-answered.png`,
    fullPage: true,
  });
  check(
    'an opener is a press that sends: the message asked for what the chip said',
    requests.length === 1 && /Watch my mentions/.test(answeredText),
    `${requests.length} request(s) to the trial route`,
  );
  check(
    'the real reply is on the screen, and the input is gone',
    /I can read your mentions/.test(answeredText) &&
      (await page.locator('[data-trial="input"]').count()) === 0 &&
      (await page.locator('[data-trial="reply"]').count()) === 1,
  );
  check(
    'the primary action becomes the named save-and-sign-in, and is drawn as the loud one',
    /Save Momo & sign in with Farcaster/.test(await primaryText(page)) &&
      (await primaryHighlighted(page)) === 'true',
    await primaryText(page),
  );

  const stored = await page.evaluate(() =>
    window.localStorage.getItem('fiddy.trial'),
  );
  check(
    'the exchange is kept for the signed-in chat to pick up',
    typeof stored === 'string' && /I can read your mentions/.test(stored),
    String(stored).slice(0, 80),
  );

  // A reload keeps it, and spends no second message.
  const before = requests.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await appears(page, '[data-fiddy="trial"]', 30000);
  await page.waitForFunction(
    () => document.querySelector('[data-trial="reply"]') !== null,
    null,
    { timeout: 15000 },
  );
  check(
    'a reload shows the same exchange and asks the service nothing',
    /I can read your mentions/.test(await bodyText(page)) &&
      requests.length === before,
    `${requests.length - before} new request(s)`,
  );

  // 3. When no brain can answer, the screen says so — and invents nothing.
  // The console is read BEFORE this step: the 503 below is deliberately provoked,
  // and a browser logs a failed resource load as a console error even when the
  // page handled it. What matters is that nothing threw on the way here.
  const errorsBeforeRefusal = consoleErrors.length;
  await page.unroute('**/api/fiddy/trial-chat');
  await page.route('**/api/fiddy/trial-chat', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        code: 'TRIAL_NOT_OPEN',
        message:
          'The live trial is not open on this service yet. Sign in and your first message goes straight to your agent.',
      }),
    });
  });
  await page.evaluate(() => {
    window.localStorage.removeItem('fiddy.trial');
    window.sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await appears(page, '[data-fiddy="trial"]', 30000);
  await page.click('[data-trial-starter="Draft a morning intro cast"]');
  await page.waitForFunction(
    () => document.querySelector('[data-trial="refusal"]') !== null,
    null,
    { timeout: 15000 },
  );
  const refusedText = await bodyText(page);
  await page.screenshot({
    path: `${OUT}/trial-3-not-open.png`,
    fullPage: true,
  });
  check(
    'an unreachable trial is stated in words, with no invented reply',
    /not open on this service yet/.test(refusedText) &&
      (await page.locator('[data-trial="reply"]').count()) === 0 &&
      (await page.locator('[data-trial="input"]').count()) === 1,
    refusedText.slice(0, 90),
  );
  check(
    'the sign-in is still the way in while the trial is closed',
    /Go social/.test(await primaryText(page)),
    await primaryText(page),
  );

  // 4. No jargon, and nothing broken in the console on the way through.
  const screens = `${readyText} ${answeredText} ${refusedText}`.toLowerCase();
  const jargon = [
    'endpoint',
    'bearer',
    'localhost',
    'api key',
    'cors',
    'rate limit',
    'provider',
    'model id',
    'token',
    'undefined',
    'null',
    'nan',
  ];
  const found = jargon.filter((word) => screens.includes(word));
  check(
    'no infrastructure words on the trial box',
    found.length === 0,
    found.join(','),
  );

  // 5. What the deployed service actually answers, when asked to look.
  if (LIVE) {
    const probe = await page.evaluate(async () => {
      const response = await fetch('/api/fiddy/trial-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi', agentName: 'Momo' }),
      });
      const text = await response.text();
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        body: text.slice(0, 120),
      };
    });
    check(
      'the live service answers the trial route with JSON',
      probe.status === 200 || String(probe.type).includes('json'),
      `${probe.status} ${probe.type} ${probe.body}`,
    );
  }

  const uncaught = consoleErrors.filter((entry) =>
    entry.startsWith('pageerror:'),
  );
  check(
    'the walk raises no console errors of its own',
    errorsBeforeRefusal === 0 && uncaught.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || `(${uncaught.length} uncaught)`,
  );

  await browser.close();
};

await run();

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(
    `${entry.ok ? 'ok  ' : 'RED '} ${entry.name}${entry.detail ? `  — ${entry.detail}` : ''}`,
  );
}
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${OUT}.`,
);
process.exit(failed.length ? 1 : 0);
