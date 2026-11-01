import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.ONBOARDING_SERVER ?? 'https://fiddy.fun';
const shotDir = process.env.ONBOARDING_SHOT_DIR ?? join(tmpdir(), 'fiddy-onboarding-resume');
await mkdir(shotDir, { recursive: true });

let passed = 0;
const failures = [];
const check = (condition, label) => {
  if (condition) {
    passed += 1;
    console.log(`ok ${passed} - ${label}`);
  } else {
    failures.push(label);
    console.error(`not ok - ${label}`);
  }
};

const browser = await chromium.launch({ headless: true });
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: 'reduce',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const label = `${viewport.width}px`;

  try {
    await page.goto(`${origin}/welcome/name`, { waitUntil: 'domcontentloaded' });
    const name = page.getByLabel("Your agent's name");
    await name.waitFor();
    await name.fill('Pip');
    await page.locator('[data-fiddy-brain="google"]').click();
    await page.locator('[data-fiddy-field="brain-key"]').fill('probe-only-not-stored');
    await page.locator('[data-fiddy-field="brain-model"]').fill('gemini-test');
    await page.locator('[data-fiddy-action="use-brain"]').click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Add this later', exact: true }).click();
    await page.getByRole('heading', { name: 'Pip is ready.' }).waitFor();
    check(true, `${label}: name and brain reach the ready step`);

    await page.getByRole('button', { name: 'Do this later', exact: true }).click();
    await page.getByRole('button', { name: 'Look around first', exact: true }).click();
    await page.waitForURL('**/feed');
    check(true, `${label}: Do this later still allows public browsing`);

    await page.goto(`${origin}/welcome`, { waitUntil: 'domcontentloaded' });
    const resume = page.locator('[data-fiddy="resume-setup"]');
    await resume.waitFor();
    check(await resume.textContent() === 'Resume with Pip', `${label}: the front door offers a named resume`);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fiddy.setup') ?? '{}'));
    check(saved.agentName === 'Pip', `${label}: the name is persisted locally`);
    check(saved.brain === 'google' && saved.brainModel === 'gemini-test', `${label}: the brain is persisted locally`);
    check(saved.onboardingStep === 'ready', `${label}: the wizard step is persisted locally`);

    await resume.click();
    await page.getByRole('heading', { name: 'Pip is ready.' }).waitFor();
    check(await page.locator('[data-fiddy="step-count"]').textContent() === 'Step 3 of 3', `${label}: resume returns to the same step`);
    check((await page.locator('.fiddy-summary').innerText()).includes('Gemini'), `${label}: resume shows the same brain choice`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: resumed sheet has no horizontal overflow`);
    await page.screenshot({ path: join(shotDir, `resumed-${viewport.width}.png`), fullPage: true });

    await page.getByRole('button', { name: 'Do this later', exact: true }).click();
    await page.locator('[data-fiddy="start-over"]').click();
    await page.getByRole('heading', { name: 'Name your agent, and pick a brain.' }).waitFor();
    const reset = await page.evaluate(() => ({
      setup: JSON.parse(localStorage.getItem('fiddy.setup') ?? '{}'),
      trial: localStorage.getItem('fiddy.trial'),
      name: document.querySelector('input')?.value,
    }));
    check(reset.name === 'Pip' ? false : reset.name === 'Fiddy', `${label}: start over restores the default name field`);
    check(reset.setup.agentName === 'Fiddy' && reset.setup.brain === 'fiddy', `${label}: start over clears the saved choices`);
    check(reset.setup.onboardingStep === 'setup' && reset.setup.completedAt === null, `${label}: start over deliberately restarts the step state`);
    check(reset.trial === null, `${label}: start over clears the saved trial`);
    check(pageErrors.length === 0, `${label}: no uncaught page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);
  } catch (error) {
    failures.push(`${label}: ${error.stack ?? error}`);
    console.error(`not ok - ${label}: ${error.message}`);
    await page.screenshot({ path: join(shotDir, `failure-${viewport.width}.png`), fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
}
await browser.close();

console.log(`${passed} checks passed; ${failures.length} failed. Screenshots: ${shotDir}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
