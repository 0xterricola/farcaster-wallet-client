// Signed-out public reading, with the first read held and then answered empty.
// The app and its state handling are real; only the feed response is controlled.
//
//   PUBLIC_DELIGHT_SERVER=https://localhost:5199 \
//     PUBLIC_DELIGHT_SHOT_DIR=/tmp/fiddy-fun node scripts/verify-public-delight.mjs
//
// Point PUBLIC_DELIGHT_SERVER at https://fiddy.fun for the live check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

const SERVER = process.env.PUBLIC_DELIGHT_SERVER ?? 'https://localhost:5199';
const OUT = process.env.PUBLIC_DELIGHT_SHOT_DIR ?? os.tmpdir();
const WIDTHS = [390, 1440];
const failures = [];
const shots = [];
let checks = 0;

const check = (name, ok, detail = '') => {
  checks += 1;
  if (!ok) failures.push({ name, detail });
};

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));

      const held = [];
      let release = false;
      let requests = 0;
      await page.route('**/v1/userNameProofByName*', async (route) => {
        requests += 1;
        if (!release) {
          held.push(route);
          return;
        }
        // No public anchor resolves, so the app's own read returns an honestly
        // empty window. This is a fixture at the node boundary, not a DOM fake.
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'not found' }),
        });
      });

      await page.goto(`${SERVER}/feed`, { waitUntil: 'domcontentloaded' });
      const loading = page.locator('[data-fiddy="public-loading"]');
      await loading.waitFor({ timeout: 30000 });
      check(
        `${width}: loading says what Fiddy is doing`,
        (await loading.textContent())?.includes(
          'Fiddy is looking for fresh casts…',
        ) === true,
        await loading.textContent(),
      );
      const loadingShot = path.join(OUT, `fiddy-fun-loading-${width}.png`);
      await page.screenshot({ path: loadingShot, fullPage: true });
      shots.push(loadingShot);

      release = true;
      for (const route of held.splice(0)) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'not found' }),
        });
      }

      const empty = page.locator('[data-fiddy="public-empty"]');
      try {
        await empty.waitFor({ timeout: 30000 });
      } catch (error) {
        console.error(
          JSON.stringify({
            width,
            requests,
            body: await page.locator('body').innerText(),
            errors,
          }),
        );
        throw error;
      }
      const emptyText = (await empty.textContent())
        ?.replace(/\s+/g, ' ')
        .trim();
      check(
        `${width}: empty copy is warm and honest`,
        emptyText?.includes('No fresh casts in this corner yet.') === true &&
          emptyText.includes('the server had nothing to share this time') &&
          emptyText.includes('The network is not empty'),
        emptyText,
      );
      check(
        `${width}: the empty state has a real next action`,
        (await empty.getByRole('button', { name: 'Look again' }).count()) === 1,
      );
      const emptyShot = path.join(OUT, `fiddy-fun-empty-${width}.png`);
      await page.screenshot({ path: emptyShot, fullPage: true });
      shots.push(emptyShot);

      const beforeRetry = requests;
      await empty.getByRole('button', { name: 'Look again' }).click();
      await page.waitForTimeout(400);
      check(
        `${width}: Look again really asks for casts`,
        requests > beforeRetry,
        `before=${beforeRetry} after=${requests}`,
      );

      const note = page.locator('[data-fiddy="public-sign-in-prompt"]');
      check(
        `${width}: signed-out copy welcomes browsing and names the next step`,
        (await note.textContent())?.includes(
          'Take a look around. No account needed.',
        ) === true &&
          (await note
            .getByRole('button', { name: 'Sign in to join in' })
            .count()) === 1,
        await note.textContent(),
      );
      await note.getByRole('button', { name: 'Sign in to join in' }).click();
      const accountChoices = page.getByRole('button', {
        name: 'New here? Make your Fiddy account',
      });
      await accountChoices.waitFor({ timeout: 10000 });
      check(
        `${width}: the sign-in next action opens the real choices`,
        await accountChoices.isVisible(),
      );
      check(`${width}: nothing threw`, errors.length === 0, errors.join(' | '));
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const result = { ok: failures.length === 0, checks, failures, shots };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
