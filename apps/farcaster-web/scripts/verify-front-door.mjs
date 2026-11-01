// The first-time visitor probe: no stored session, no network vocabulary needed.
//
//   FRONT_DOOR_ORIGIN=https://localhost:5173 \
//     node apps/farcaster-web/scripts/verify-front-door.mjs
//
// Set FRONT_DOOR_ORIGIN=https://fiddy.fun for the live check. Screenshots land
// in FRONT_DOOR_SHOT_DIR (default: the system temp dir).
import os from 'node:os';

import { chromium } from 'playwright';

const OUT = process.env.FRONT_DOOR_SHOT_DIR ?? os.tmpdir();
const ORIGIN = process.env.FRONT_DOOR_ORIGIN ?? 'https://localhost:5173';
const EXPECTED_ACTIONS = [
  'Look around first',
  'Say hi',
  'Already have an account? Sign in',
];
const JARGON = [
  'node',
  'protocol',
  'signer',
  'scope',
  'ttl',
  'gasless',
  'api key',
  'endpoint',
  'snapchain',
];

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
};

const sheetText = (page) =>
  page
    .locator('[data-fiddy-step="hi"]')
    .innerText()
    .then((text) => text.replace(/\s+/g, ' ').trim());

const actionLabels = (page) =>
  page.$$eval(
    '[data-fiddy-step="hi"] button, [data-fiddy-step="hi"] a',
    (elements) =>
      elements
        .map((element) =>
          (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
        )
        .filter(Boolean),
  );

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });

  try {
    for (const width of [390, 1440]) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height: width === 390 ? 844 : 800 },
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const prefix = `${width}px`;

      await page.goto(`${ORIGIN}/welcome`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-fiddy-step="hi"]', { timeout: 30000 });

      const labels = await actionLabels(page);
      check(
        `${prefix}: the three first-time actions use plain words`,
        JSON.stringify(labels) === JSON.stringify(EXPECTED_ACTIONS),
        labels.join(' | '),
      );

      const primary = page.locator('[data-fiddy-step="hi"] .fiddy-primary-btn');
      const primaryLabel = (await primary.innerText()).trim();
      const primaryMarker = await primary.getAttribute('data-fiddy');
      check(
        `${prefix}: browsing is the primary action`,
        primaryLabel === 'Look around first' && primaryMarker === 'browse-cta',
        `${primaryLabel} / ${primaryMarker ?? 'no marker'}`,
      );

      const primaryBox = await primary.boundingBox();
      check(
        `${prefix}: the primary action is visible without scrolling`,
        primaryBox !== null &&
          primaryBox.y >= 0 &&
          primaryBox.y + primaryBox.height <= page.viewportSize().height,
        primaryBox
          ? `bottom ${Math.round(primaryBox.y + primaryBox.height)}`
          : 'not drawn',
      );

      const text = await sheetText(page);
      check(
        `${prefix}: the account is Fiddy's, and the network is only its home`,
        text.includes(
          'Your Fiddy account lives on Farcaster, the network Fiddy posts to.',
        ) && !/New to Farcaster|Already on Farcaster/i.test(text),
      );
      const jargon = JARGON.filter((word) => text.toLowerCase().includes(word));
      check(
        `${prefix}: the front door passes the jargon ban`,
        jargon.length === 0,
        jargon.join(', ') || 'none found',
      );
      await page.screenshot({
        path: `${OUT}/front-door-${width}.png`,
        fullPage: true,
      });

      await page
        .getByRole('button', {
          name: 'Already have an account? Sign in',
          exact: true,
        })
        .click();
      await page.waitForSelector('[data-fiddy="create-account-entry"]');
      const createLabel = await page
        .locator('[data-fiddy="create-account-entry"]')
        .innerText();
      check(
        `${prefix}: account creation is named for Fiddy, not the network`,
        createLabel.trim() === 'New here? Make your Fiddy account',
        createLabel.trim(),
      );

      await page.goto(`${ORIGIN}/welcome`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-fiddy="browse-cta"]');
      await page.locator('[data-fiddy="browse-cta"]').click();
      await page.waitForSelector('[data-fiddy="public-browse"]', {
        timeout: 30000,
      });
      check(
        `${prefix}: the primary action opens public reading with no account`,
        new URL(page.url()).pathname === '/feed' &&
          (await page.locator('[data-fiddy="public-browse"]').count()) === 1,
        new URL(page.url()).pathname,
      );
      await page.screenshot({
        path: `${OUT}/front-door-browse-${width}.png`,
        fullPage: true,
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
};

await run();

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(
    `${entry.ok ? 'ok  ' : 'RED '} ${entry.name}${entry.detail ? ` - ${entry.detail}` : ''}`,
  );
}
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${OUT}.`,
);
process.exit(failed.length ? 1 : 0);
