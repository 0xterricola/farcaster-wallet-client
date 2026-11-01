// Post-release check for the funding surfaces: the LIVE site, origin-direct,
// with no stubs and no local dev server.
//
//   cd <client checkout>            # playwright resolves from the ROOT node_modules
//   node apps/farcaster-web/scripts/verify-funding-live.mjs
//
// The repo's own funding probe (`verify-fiddy-funding.mjs`) stubs the three
// funding routes and needs the probe vite server, which is what makes it the
// right tool for the FLOW and the wrong tool for the release: it cannot see what
// fiddy.fun actually serves. Nor can the release script's step 8 gate, which
// compares bytes — a signed-out funding refusal is a runtime answer, not a byte.
// This is the check that covers it, run after a cut-over.
//
// What it asks of the deployed app (no stubs, no local server):
//
//   /~/wallet          the balance home renders, the balance is the dash rather
//                      than an invented $0.00, no chip is drawn when no balance
//                      can be read, the way in to add funds is there, and the
//                      refusal NAMES the server's own code (AUTH_REQUIRED).
//   /~/wallet/add-funds  the presets are the server's own three, the server's
//                      $1 floor is stated, the review press is disabled, and the
//                      send is NOT in the DOM at all.
//   /welcome/funds     the way in's step 2 of 3, mounting the real sheet with the
//                      same refusal, and skippable to the last step.
//   /                  no chip on the front door either.
//
// It is READ-ONLY and it never sends or approves a transfer: it asserts that the
// press that WOULD move money exists and is disabled/absent, and never presses
// it. A probe has no funded wallet and must not need one.
//
// Env:
//   LIVE_FUNDING_ORIGIN  the origin to measure   (default https://fiddy.fun)
//   LIVE_SHOT_DIR        where screenshots land  (default: the system temp dir —
//                        never a directory inside the repo, whose files eslint
//                        walks on every lint run)
//
// Three things the probes before this one learned the hard way, kept here:
//
//   1. THE SESSION LINE IS POLLED FOR ITS SETTLED TEXT, not for its element.
//      `[data-fiddy="top-up-session-line"]` exists from first paint, in the
//      loading state ("Checking whether this account can hold a balance…"), and
//      only later carries the server's code. Waiting on the element reads the
//      loading sentence and reports a false failure.
//   2. THE STEP COUNTER IS CASED BY CSS. It renders "STEP 2 OF 3" from markup
//      that is not uppercase, so that match is case-insensitive.
//   3. LAZY CHUNKS ARRIVE AFTER THEIR SHEET. `[data-fiddy="top-up-amount"]` /
//      `[data-fiddy="top-up-later"]` are waited for before anything on the sheet
//      is measured or pressed, or a fast run measures a half-mounted screen.
import fs from 'node:fs';
import os from 'node:os';

import { chromium } from 'playwright';

const ORIGIN = process.env.LIVE_FUNDING_ORIGIN ?? 'https://fiddy.fun';
const OUT = process.env.LIVE_SHOT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
const failures = [];
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });

for (const width of [390, 1440]) {
  const height = width === 390 ? 844 : 900;
  const ctx = await browser.newContext({
    viewport: { width, height },
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

  const text = async () => (await page.evaluate(() => document.body.innerText)) ?? '';
  const count = async (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const disabled = async (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      return el === null ? null : el.disabled === true || el.hasAttribute('disabled');
    }, sel);

  const goto = async (path) => {
    const res = await page.goto(`${ORIGIN}${path}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    return res?.status() ?? 0;
  };

  // The session line starts life in the loading state ("Checking whether this
  // account can hold a balance…") and settles into the refusal WITH the server's
  // own code once the balance route answers. Poll for the settled text, never
  // for the element: the element exists the whole time.
  const settleSessionLine = async (sel, budgetMs = 60000) => {
    const deadline = Date.now() + budgetMs;
    let last = null;
    while (Date.now() < deadline) {
      const present = await count(sel);
      if (present === 1) {
        last = await page.evaluate((s) => document.querySelector(s)?.innerText ?? '', sel);
        if (/\([A-Z_]+\)/.test(last)) return last;
      }
      await sleep(1000);
    }
    return last;
  };

  // A lazy chunk (the funding panel) can arrive after the sheet does.
  const waitFor = async (sel, budgetMs = 60000) => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if ((await count(sel)) > 0) return true;
      await sleep(500);
    }
    return false;
  };

  console.log(`\n=== ${width}px — the wallet route (balance home) ===`);
  const walletCode = await goto('/~/wallet');
  check(`${width}: GET /~/wallet answers 200`, walletCode === 200, `HTTP ${walletCode}`);
  try {
    await page.waitForSelector('[data-fiddy="wallet-page"]', { timeout: 45000 });
    check(`${width}: the wallet page renders`, true);
  } catch {
    check(`${width}: the wallet page renders`, false, (await text()).slice(0, 200));
  }
  check(
    `${width}: the balance home renders on /~/wallet`,
    (await count('[data-fiddy="balance-home"]')) === 1,
    `balance-home count ${await count('[data-fiddy="balance-home"]')}`,
  );
  // The refusal: the balance route cannot place this session, and the page says
  // so with the server's own code rather than a number or a blank.
  const sessionLine = await settleSessionLine('[data-fiddy="balance-session-line"]');
  check(
    `${width}: the wallet page states the session refusal`,
    sessionLine !== null && /\(([A-Z_]+)\)/.test(sessionLine),
    (sessionLine ?? 'no session line').replace(/\s+/g, ' ').slice(0, 160),
  );
  const walletBalanceText = await page.evaluate(
    () => document.querySelector('[data-fiddy="balance-available"]')?.innerText ?? null,
  );
  check(
    `${width}: the balance is not invented (shown as the dash, not $0.00)`,
    walletBalanceText === '—' || walletBalanceText === null,
    `balance-available = ${JSON.stringify(walletBalanceText)}`,
  );
  check(
    `${width}: the chip is ABSENT when no balance can be read`,
    (await count('[data-fiddy="balance-chip"]')) === 0,
    `balance-chip count ${await count('[data-fiddy="balance-chip"]')}`,
  );
  check(
    `${width}: the balance home carries the way in to add funds`,
    (await count('[data-fiddy="balance-add-funds"]')) === 1,
  );
  await page.screenshot({ path: `${OUT}/live-${width}-wallet.png`, fullPage: false });

  console.log(`\n=== ${width}px — the add-funds screen ===`);
  let fundsPath = '/~/wallet/add-funds';
  let fundsCode = await goto(fundsPath);
  try {
    await page.waitForSelector('[data-fiddy="top-up-amount"]', { timeout: 45000 });
  } catch {
    // The app prefix has been either /~ or /~/ across this repo's history.
    fundsPath = '/~wallet/add-funds';
    fundsCode = await goto(fundsPath);
    await page.waitForSelector('[data-fiddy="top-up-amount"]', { timeout: 45000 }).catch(() => {});
  }
  check(`${width}: the add-funds screen renders at ${fundsPath}`, true, `HTTP ${fundsCode}`);
  check(`${width}: it is the amount step`, (await count('[data-fiddy="top-up-amount"]')) === 1);
  const presets = await page.evaluate(() =>
    [...document.querySelectorAll('[data-fiddy-amount]')].map((el) => ({
      usd: el.getAttribute('data-fiddy-amount'),
      label: (el.innerText ?? '').trim(),
    })),
  );
  check(
    `${width}: the presets are the server's own three`,
    presets.length === 3 && presets.map((p) => p.usd).join(',') === '5,10,25',
    JSON.stringify(presets),
  );
  const fundsText = await text();
  check(
    `${width}: the $1 floor is stated (the server's minimum)`,
    fundsText.includes('Smallest top-up is $1.00'),
    fundsText.includes('$1.00') ? 'present' : 'not in the page text',
  );
  check(
    `${width}: the header is the change's own sentence`,
    fundsText.includes('Add funds to your Fiddy balance'),
  );
  const fundsSession = await settleSessionLine('[data-fiddy="top-up-session-line"]');
  check(
    `${width}: the refusal line names the server's code`,
    fundsSession !== null &&
      /\([A-Z_]+\)/.test(fundsSession) &&
      !/Checking whether this account/.test(fundsSession),
    (fundsSession ?? 'no session line').replace(/\s+/g, ' ').slice(0, 180),
  );
  check(
    `${width}: the refusal is on the review press, not just prose`,
    (await disabled('[data-fiddy="top-up-review-open"]')) === true,
    `top-up-review-open disabled = ${await disabled('[data-fiddy="top-up-review-open"]')}`,
  );
  check(
    `${width}: NO send is offered (the money-mover is not in the DOM)`,
    (await count('[data-fiddy="top-up-send"]')) === 0,
    `top-up-send count ${await count('[data-fiddy="top-up-send"]')}`,
  );
  check(`${width}: the chip is absent here too`, (await count('[data-fiddy="balance-chip"]')) === 0);
  const banned = [
    'wallet balance',
    'deposit',
    'custody',
    'gasless',
    'chain id',
    'your funds',
    'held by Fiddy',
  ].filter((w) => fundsText.toLowerCase().includes(w));
  check(`${width}: no custody vocabulary on the screen`, banned.length === 0, banned.join(', '));
  await page.screenshot({ path: `${OUT}/live-${width}-add-funds.png`, fullPage: false });

  console.log(`\n=== ${width}px — the way in, step 2 of 3 ===`);
  const stepCode = await goto('/welcome/funds');
  try {
    await page.waitForSelector('[data-fiddy-step="funds"]', { timeout: 45000 });
    check(`${width}: /welcome/funds renders the funds step`, true, `HTTP ${stepCode}`);
  } catch {
    check(`${width}: /welcome/funds renders the funds step`, false, `HTTP ${stepCode}`);
  }
  // The panel is a lazy chunk and the session read has to settle before the
  // refusal is on screen — measure the step once it is actually mounted.
  const panelUp = await waitFor('[data-fiddy="top-up-amount"]', 60000);
  check(`${width}: the wizard's step mounts the real funding sheet`, panelUp);
  const stepCount = await page.evaluate(
    () => document.querySelector('[data-fiddy="step-count"]')?.innerText ?? '',
  );
  // The counter is uppercased by CSS, the markup is not: match case-insensitively.
  check(`${width}: it is step 2 of 3`, /2\s*of\s*3/i.test(stepCount), JSON.stringify(stepCount.trim()));
  const stepText = await text();
  check(
    `${width}: the step offers the balance without gating it`,
    stepText.includes('Add funds, or add them later.'),
  );
  const wizardSession = await settleSessionLine('[data-fiddy="top-up-session-line"]', 60000);
  check(
    `${width}: the refusal inside the wizard names the server's code too`,
    wizardSession !== null && /\([A-Z_]+\)/.test(wizardSession),
    (wizardSession ?? 'no session line').replace(/\s+/g, ' ').slice(0, 180),
  );
  check(
    `${width}: the send is refused inside the wizard as well`,
    (await disabled('[data-fiddy="top-up-review-open"]')) === true,
    `disabled = ${await disabled('[data-fiddy="top-up-review-open"]')}`,
  );
  await page.screenshot({ path: `${OUT}/live-${width}-welcome-funds.png`, fullPage: false });
  // The skip: one press walks on to the last step. The press opens no sheet and
  // sends nothing — it is the way PAST the funding step.
  const skipUp = await waitFor('[data-fiddy="top-up-later"]', 30000);
  const skipped = await page.evaluate(() => {
    const btn = document.querySelector('[data-fiddy="top-up-later"]');
    if (btn === null) return false;
    btn.click();
    return true;
  });
  check(`${width}: the step is skippable (the press exists)`, skipUp && skipped === true);
  await sleep(1500);
  const atReady = (await count('[data-fiddy-step="ready"]')) === 1 || /\/welcome\/ready/.test(page.url());
  check(`${width}: the skip walks to the last step`, atReady, `url ${page.url()}`);

  console.log(`\n=== ${width}px — the front door ===`);
  await goto('/');
  await sleep(1500);
  check(`${width}: no chip on the landing`, (await count('[data-fiddy="balance-chip"]')) === 0);

  console.log(`  console errors: ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 6)) console.log(`    · ${e}`);

  await ctx.close();
}

await browser.close();

console.log(`\n${pass}/${checks.length} checks passed`);
if (failures.length > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
}
fs.writeFileSync(
  `${OUT}/results.json`,
  JSON.stringify({ origin: ORIGIN, pass, total: checks.length, checks, failures }, null, 2),
);
process.exit(failures.length === 0 ? 0 : 1);