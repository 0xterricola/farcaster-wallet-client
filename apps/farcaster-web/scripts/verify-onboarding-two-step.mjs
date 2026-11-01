// What the way in does in a browser: two numbered steps, and no apps screen
// between them.
//
//   pnpm --filter farcaster-web start          # https://localhost:5173
//   node apps/farcaster-web/scripts/verify-onboarding-two-step.mjs
//
// Point it at another origin when the client under test is served elsewhere:
//
//   ONBOARDING_ORIGIN=https://localhost:5199 node apps/farcaster-web/scripts/verify-onboarding-two-step.mjs
//
// Screenshots land in $ONBOARDING_SHOT_DIR (default: the system temp dir).
//
// WHAT IT MEASURES, AND WHY THESE CHECKS
// The flow used to be four numbered steps (`name` → `brain` → `apps` → `ready`),
// and the third of them asked an unauthenticated visitor to allow six apps of
// which five were dead "soon" switches — before they had seen the app or said
// one word to their agent. So this probe walks the whole thing and holds it to
// three claims:
//
//   1. naming and picking a brain are ONE screen (step 1 of 2), and the built-in
//      brain is already picked, so "Continue" finishes the step in one press;
//   2. step 2 of 2 is the last screen there is — the ready sheet — and the apps
//      sheet is nowhere on the way in;
//   3. the addresses that used to be steps are not dead ends: `/welcome/apps`
//      lands on the last step, `/welcome/brain` still lands on the picker.
//
// Nothing here is stubbed. It is the app, signed out, in a real browser.
import os from 'node:os';

import { chromium } from 'playwright';

const OUT = process.env.ONBOARDING_SHOT_DIR ?? os.tmpdir();
const ORIGIN = process.env.ONBOARDING_ORIGIN ?? 'https://localhost:5173';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
};

const appears = async (page, selector, timeout = 15000) => {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
};

const textOf = async (page, selector) =>
  (await page
    .locator(selector)
    .first()
    .innerText()
    .catch(() => '')
  ).replace(/\s+/g, ' ');

const bodyText = (page) =>
  page
    .evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim())
    .catch(() => '');

const where = (page) => new URL(page.url()).pathname;

/** The eight services the brain screen is expected to offer. */
const brainIds = [
  'fiddy',
  'surp',
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'nous',
  'custom',
];

/** Press the first visible control whose text matches, and answer its label. */
const pressByText = async (page, re) => {
  for (const el of await page.$$('button, a, [role=button]')) {
    const label = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (re.test(label) && (await el.isVisible())) {
      await el.click();
      return label;
    }
  }
  return null;
};

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error)}`));

  // 0. The front door, and the press that starts the way in.
  await page.goto(`${ORIGIN}/welcome`, { waitUntil: 'domcontentloaded' });
  const doorShown = await appears(page, '[data-fiddy-step="hi"]');
  const doorText = await bodyText(page);
  await page.screenshot({ path: `${OUT}/onboarding-0-front-door.png`, fullPage: true });
  check(
    'the front door is the greeting, and offers one press to start',
    doorShown && /Meet Fiddy/.test(doorText),
    doorText.slice(0, 80),
  );

  const started = await pressByText(page, /^Say hi$|^Continue as /);
  await page.waitForTimeout(400);
  const step1Text = await bodyText(page);
  check('pressing it opens step 1', started !== null && (await appears(page, '[data-fiddy-step="setup"]')), started ?? '(no control matched)');
  // The counter renders upper-cased by CSS, so it is compared the way a reader
  // sees it rather than the way the DOM stores it.
  check(
    'step 1 is /welcome/name and calls itself Step 1 of 2',
    where(page) === '/welcome/name' && /step 1 of 2/i.test(step1Text),
    `${where(page)} — ${(await textOf(page, '[data-fiddy="step-count"]')) || '(no counter)'}`,
  );

  // 1. Both halves of the decision, on that one screen.
  const nameField = await page.locator('input[placeholder="Fiddy"]').count();
  const cardsOnScreen = [];
  for (const id of brainIds) {
    if (await page.locator(`[data-fiddy-brain="${id}"]`).isVisible().catch(() => false)) {
      cardsOnScreen.push(id);
    }
  }
  await page.screenshot({ path: `${OUT}/onboarding-1-step-one.png`, fullPage: true });
  check(
    'the name field and every brain card are on the same screen',
    nameField === 1 && cardsOnScreen.length === brainIds.length,
    `${nameField} name field(s), ${cardsOnScreen.length}/${brainIds.length} cards`,
  );

  const builtIn = await page
    .locator('[data-fiddy-brain="fiddy"]')
    .getAttribute('data-state')
    .catch(() => null);
  check(
    'the built-in brain is already picked, so one press is enough',
    builtIn === 'selected',
    String(builtIn),
  );

  const choseNothing = await page
    .locator('[data-fiddy="brain-connect"]')
    .count();
  check(
    'nothing is asked of the visitor beyond the two choices',
    choseNothing === 0,
    choseNothing ? 'a connect form was open on arrival' : 'no form open',
  );

  check(
    'the apps sheet is not on the way in',
    (await page.locator('[data-fiddy="apps"]').count()) === 0,
  );

  // 2. One press finishes it — press the primary, touch nothing else.
  const advanced = await pressByText(page, /^Continue$/);
  await page.waitForTimeout(600);
  const step2Text = await bodyText(page);
  await page.screenshot({ path: `${OUT}/onboarding-2-step-two.png`, fullPage: true });
  check('Continue is the one press the step needs', advanced === 'Continue', advanced ?? '(not found)');
  check(
    'it lands on step 2 of 2, /welcome/ready, and that is the last one',
    where(page) === '/welcome/ready' &&
      /step 2 of 2/i.test(step2Text) &&
      /is ready\./.test(step2Text),
    `${where(page)} — ${(await textOf(page, '[data-fiddy="step-count"]')) || '(no counter)'}`,
  );
  check(
    'the last screen names the agent and its brain, and offers the sign-in',
    /Fiddy is ready\./.test(step2Text) &&
      /Fiddy, built in/.test(step2Text) &&
      /Go social/.test(step2Text),
    step2Text.slice(0, 110),
  );
  check(
    'the apps sheet is not on the last screen either',
    (await page.locator('[data-fiddy="apps"]').count()) === 0,
  );

  // 3. The two addresses that used to be steps, from a cold load.
  //
  // MEASURED (2026-10-21): a cold load of a setup screen paints the shell
  // skeleton ("Loading Fiddy…") for several seconds before the screen itself
  // appears, so each of these waits for the screen and not for a stopwatch —
  // reading the skeleton would grade the skeleton.
  await page.goto(`${ORIGIN}/welcome/apps`, { waitUntil: 'domcontentloaded' });
  const appsRendered = await appears(page, '[data-fiddy-step="ready"]', 30000);
  const appsText = await bodyText(page);
  await page.screenshot({ path: `${OUT}/onboarding-3-old-apps-address.png`, fullPage: true });
  check(
    '/welcome/apps is not a dead screen: it lands on the last step',
    appsRendered &&
      where(page) === '/welcome/ready' &&
      /is ready\./.test(appsText) &&
      (await page.locator('[data-fiddy="apps"]').count()) === 0,
    `${where(page)} — ${appsText.slice(0, 70)}`,
  );

  await page.goto(`${ORIGIN}/welcome/brain`, { waitUntil: 'domcontentloaded' });
  const brainRendered = await appears(page, '[data-fiddy-brain="fiddy"]', 30000);
  await page.waitForTimeout(300);
  const brainText = await bodyText(page);
  const brainCards = await page
    .locator('[data-fiddy-brain="fiddy"]')
    .isVisible()
    .catch(() => false);
  const brainNameField = await page.locator('input[placeholder="Fiddy"]').count();
  await page.screenshot({ path: `${OUT}/onboarding-4-old-brain-address.png`, fullPage: true });
  check(
    'an older /welcome/brain link still lands on the picker — step 1 of 2',
    brainRendered &&
      brainCards &&
      brainNameField === 1 &&
      /step 1 of 2/i.test(brainText) &&
      where(page) === '/welcome/brain',
    `${where(page)} — ${brainCards ? 'cards' : 'no cards'}, ${brainNameField} name field(s)`,
  );

  // 4. The same screen at a phone width. This is a phone product and the step
  //    now carries more than it used to, so "it still works on a phone" is a
  //    claim worth measuring rather than assuming.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ORIGIN}/welcome/name`, { waitUntil: 'domcontentloaded' });
  const phoneRendered = await appears(page, '[data-fiddy-step="setup"]', 30000);
  const phoneName = await page.locator('input[placeholder="Fiddy"]').count();
  const phoneCards = await page.locator('[data-fiddy-brain="fiddy"]').isVisible().catch(() => false);
  const phoneContinue = await page.locator('button:has-text("Continue")').isVisible().catch(() => false);
  await page.screenshot({ path: `${OUT}/onboarding-5-phone.png`, fullPage: true });
  check(
    'at a phone width the step still shows both halves and its one press',
    phoneRendered && phoneName === 1 && phoneCards && phoneContinue,
    `${phoneRendered ? 'sheet' : 'no sheet'}, ${phoneName} name field(s), ${phoneCards ? 'cards' : 'no cards'}, ${phoneContinue ? 'Continue' : 'no Continue'}`,
  );

  // 5. No jargon, and nothing broken in the console on the way through.
  const screens = `${step1Text} ${step2Text}`.toLowerCase();
  const jargon = [
    'snapchain',
    'scope',
    'ttl',
    'signer',
    'gasless',
    'api key',
    'mcp',
    'protocol',
    'endpoint',
    'bearer',
    'localhost',
  ];
  const found = jargon.filter((word) => screens.includes(word));
  check('no infrastructure words on either step', found.length === 0, found.join(','));

  const uncaught = consoleErrors.filter((entry) => entry.startsWith('pageerror:'));
  check(
    'the walk raises no console errors',
    consoleErrors.length === 0,
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