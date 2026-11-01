// What the "Add a brain" sheet actually does in a browser.
//
//   pnpm --filter farcaster-web start          # https://localhost:5173
//   node apps/farcaster-web/scripts/verify-fiddy-brains.mjs
//
// The sheet is the pivot's pick-a-brain step (/welcome/brain) and the same
// component behind the Agent screen's "Add a brain" page, so this drives the
// onboarding route: it is reachable signed out, which is the point of the step.
//
// What is real here: the app, the sheet, every card, the fields, the local
// storage it does and does not write, and the plain words it shows when a check
// fails on the owner's side of the wire (an empty form, an unusable address).
//
// What is stubbed, and why: the ANSWER from the agent service, which is a
// different deployment living at mate.legitclub.com. This probe is about the
// client, so the service answers from a route interceptor. The service's own
// behaviour — the real model list, the SSRF refusal, the rate limit — is verified
// against the real route in the control plane repo
// (docs/fiddy/BRING-YOUR-OWN-BRAIN.md).
//
// Screenshots land in $BRAIN_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';

const OUT = process.env.BRAIN_SHOT_DIR ?? os.tmpdir();
const ORIGIN = process.env.BRAIN_ORIGIN ?? 'https://localhost:5173';
const PROBE_PATH = '**/api/agents/brains/probe';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
};

/**
 * Wait for something, and answer whether it arrived. A probe that throws on the
 * first missing element reports one failure and hides the rest; this one records
 * every check it can and says what it saw instead.
 */
const appears = async (page, selector, timeout = 8000) => {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
};

const textOf = async (page, selector) =>
  (await page.locator(selector).first().innerText().catch(() => '')).replace(/\s+/g, ' ');

const cards = [
  ['fiddy', 'Fiddy'],
  ['surp', 'Surp'],
  ['openai', 'ChatGPT'],
  ['anthropic', 'Claude'],
  ['google', 'Gemini'],
  ['openrouter', 'OpenRouter'],
  ['nous', 'Nous Portal'],
  ['custom', 'Your own AI service'],
];

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
    if (message.type() !== 'error') {
      return;
    }
    // One host is allowed to be noisy here, and only because the noise is the
    // measurement: the Surp panel reads surp.ivc.lol straight from this page,
    // Surp sends no CORS header, and the browser refuses the read (see
    // lib/surp/transport.ts). Chrome logs that refusal — a failed resource,
    // with the host on the message's location rather than in its text — the
    // panel says it in one sentence on screen, and the check below holds it to
    // saying it. Everything else on the sheet still keeps the console clean.
    if (
      /surp\.ivc\.lol/.test(message.text()) ||
      /surp\.ivc\.lol/.test(message.location()?.url ?? '')
    ) {
      return;
    }
    consoleErrors.push(message.text());
  });

  // The service's answer, and how it is asked.
  let probeRequests = [];
  let probeAnswer = {
    ok: true,
    status: 'ok',
    code: 'BRAIN_OK',
    models: ['model-one', 'model-two'],
  };
  await page.route(PROBE_PATH, async (route) => {
    probeRequests.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(probeAnswer),
    });
  });

  await page.goto(`${ORIGIN}/welcome/brain`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('[data-fiddy="brains"]', { timeout: 20000 });
  } catch {
    // A probe that fails must say what it saw: the URL it is actually on, the
    // text the page rendered, the console errors, and a screenshot.
    const url = page.url();
    const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
    await page.screenshot({ path: `${OUT}/fiddy-brains-FAILED.png`, fullPage: true }).catch(() => {});
    console.log(`RED  the sheet did not render at ${ORIGIN}/welcome/brain`);
    console.log(`     the browser is on ${url}`);
    console.log(`     the page says: ${text || '(nothing)'}`);
    console.log(`     console errors: ${consoleErrors.slice(0, 3).join(' | ') || '(none)'}`);
    console.log(`     screenshot: ${OUT}/fiddy-brains-FAILED.png`);
    await browser.close();
    process.exit(1);
  }
  await page.screenshot({ path: `${OUT}/fiddy-brains-step.png`, fullPage: true });

  check('the pick-a-brain step renders the sheet', true);

  // 1. Every card is there, and the built-in one says it needs nothing.
  for (const [id, title] of cards) {
    const card = page.locator(`[data-fiddy-brain="${id}"]`);
    const visible = await card.isVisible().catch(() => false);
    const text = visible ? await card.innerText() : '';
    check(`card ${id} is on the sheet and names ${title}`, visible && text.includes(title), text.slice(0, 60));
  }
  const builtIn = await page.locator('[data-fiddy-brain="fiddy"]').innerText();
  check(
    'the built-in card says it works out of the box',
    /works out of the box/i.test(builtIn) && /built-in brain/i.test(builtIn),
    builtIn.replace(/\s+/g, ' ').slice(0, 90),
  );

  // 2. Surp is a preset with its own panel: a key and a model, no address, the
  //    price line, and the one button that makes a key here.
  await page.locator('[data-fiddy-brain="surp"]').click();
  await appears(page, '[data-fiddy="surp"]');
  const surpFields = await page.locator('[data-fiddy="brain-connect"] [data-fiddy-field]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-fiddy-field')));
  check(
    'Surp asks for the key and the model, never for the address',
    surpFields.includes('brain-key') && surpFields.includes('brain-model') && !surpFields.includes('brain-address'),
    surpFields.join(','),
  );
  await page.screenshot({ path: `${OUT}/fiddy-brains-surp.png`, fullPage: true });
  // The price read is a real cross-origin attempt, so it is not decided on the
  // first frame: wait for the panel to leave its "reading…" state, whichever of
  // the honest states it lands in.
  await page
    .locator(
      '[data-fiddy-surp="pricing"][data-state="live"], [data-fiddy-surp="pricing"][data-state="blocked"], [data-fiddy-surp="pricing"][data-state="failed"]',
    )
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  const surpPricing = (await page.locator('[data-fiddy-surp="pricing"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const live = await page.locator('[data-fiddy-surp="savings"]').count();
  check(
    'Surp says what it costs and where that came from, or why it cannot',
    (live === 1 && /month/i.test(surpPricing)) || /blocked this page from reading Surp|did not answer in a way this page could read/i.test(surpPricing),
    surpPricing.slice(0, 110),
  );
  check(
    'Surp shows no comparison it did not read',
    live === 0 ? !/savings|\$0\./i.test(surpPricing) : true,
    `${live} comparison(s): ${surpPricing.slice(0, 90)}`,
  );
  check(
    'Surp offers the key that is made here, and says where it is kept',
    (await page.locator('[data-fiddy-surp="make-key"]').count()) === 1 &&
      /kept in this browser/i.test(await textOf(page, '[data-fiddy="surp"]')),
    (await textOf(page, '[data-fiddy="surp"]')).slice(0, 90),
  );

  // 3. An account card asks for a key and a model, and never for an address.
  await page.locator('[data-fiddy-brain="openrouter"]').click();
  const accountKeys = await page.locator('[data-fiddy="brain-connect"] [data-fiddy-field]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-fiddy-field')));
  check(
    'an account card asks for the key and the model, not the address',
    accountKeys.includes('brain-key') && accountKeys.includes('brain-model') && !accountKeys.includes('brain-address'),
    accountKeys.join(','),
  );

  // 3. Your own service asks for the three things, in that order.
  await page.locator('[data-fiddy-brain="custom"]').click();
  const ownFields = await page.locator('[data-fiddy="brain-connect"] [data-fiddy-field]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-fiddy-field')));
  check(
    'your own service asks for address, key and model',
    JSON.stringify(ownFields.filter((field) => field.startsWith('brain-') && field !== 'brain-agent')).includes('["brain-address","brain-key","brain-model"]'),
    ownFields.join(','),
  );

  // 4. An empty form is refused on this side, in plain words, with no call made.
  probeRequests = [];
  await page.locator('[data-fiddy-action="test-brain"]').click();
  const emptyError = await textOf(page, '[data-fiddy="brain-error"]');
  check(
    'an empty form is refused before anything is asked of the service',
    /address/i.test(emptyError) && probeRequests.length === 0,
    emptyError || '(no refusal appeared)',
  );

  // 5. A private address is refused in words an owner can act on.
  await page.locator('[data-fiddy-field="brain-address"]').fill('https://192.168.1.5/v1');
  await page.screenshot({ path: `${OUT}/fiddy-brains-own-service.png`, fullPage: true });
  await page.locator('[data-fiddy-field="brain-key"]').fill('sk-owner-secret-9f3a1c');
  await page.locator('[data-fiddy-field="brain-model"]').fill('model-one');
  probeAnswer = {
    ok: false,
    status: 'not_public',
    code: 'BRAIN_ADDRESS_NOT_PUBLIC',
    models: [],
  };
  await page.locator('[data-fiddy-action="test-brain"]').click();
  await appears(page, '[data-fiddy="brain-error"]');
  const refused = await textOf(page, '[data-fiddy="brain-error"]');
  check(
    'a private address is refused, and the refusal says what to do',
    /private network/i.test(refused) && /public address/i.test(refused),
    refused || '(no refusal appeared)',
  );
  const asked = probeRequests.at(-1) ?? {};
  check(
    'the check sent exactly the three things the owner typed',
    asked.kind === 'custom' && asked.baseUrl === 'https://192.168.1.5/v1' && asked.model === 'model-one' && asked.key === 'sk-owner-secret-9f3a1c',
    JSON.stringify({ ...asked, key: asked.key ? `${String(asked.key).slice(0, 8)}…` : null }),
  );

  // 6. A working answer offers the models it found, and one can be picked.
  probeAnswer = {
    ok: true,
    status: 'ok',
    code: 'BRAIN_OK',
    models: ['model-one', 'model-two'],
  };
  await page.locator('[data-fiddy-action="test-brain"]').click();
  const offered = await appears(page, '[data-fiddy="brain-models"]');
  const notice = await textOf(page, '[data-fiddy="brain-notice"]');
  check('a working key says so, and how many models it found', /that key works/i.test(notice), notice || '(no notice appeared)');
  check('the models the service listed are offered as picks', offered);
  if (offered) {
    await page.locator('[data-fiddy-model="model-two"]').click();
  }
  const picked = await page.locator('[data-fiddy-field="brain-model"]').inputValue();
  check('picking a model from the list fills the field', picked === 'model-two', picked);
  await page.screenshot({ path: `${OUT}/fiddy-brains-tested.png`, fullPage: true });

  // 7. Saving keeps the choice, and keeps no key. This is the whole promise.
  await page.locator('[data-fiddy-action="use-brain"]').click();
  await appears(page, '[data-fiddy="brain-notice"]');
  const stored = await page.evaluate(() => {
    const raw = window.localStorage.getItem('fiddy.setup') ?? '';
    return { raw, parsed: JSON.parse(raw || '{}') };
  });
  check(
    'the choice is kept: the service address and the model name',
    stored.parsed.brain === 'custom' && stored.parsed.brainModel === 'model-two' && stored.parsed.brainServiceUrl === 'https://192.168.1.5/v1',
    JSON.stringify({ brain: stored.parsed.brain, brainModel: stored.parsed.brainModel, brainServiceUrl: stored.parsed.brainServiceUrl }),
  );
  check(
    'no key is kept anywhere on this device',
    !stored.raw.includes('sk-owner-secret-9f3a1c') && !stored.raw.toLowerCase().includes('key'),
    stored.raw.slice(0, 120),
  );

  // 8. No infrastructure words reach the screen.
  const body = (await page.locator('body').innerText()).toLowerCase();
  const jargon = ['snapchain', 'scope', 'ttl', 'signer', 'gasless', 'api key', 'mcp', 'protocol', 'endpoint', 'bearer'];
  const found = jargon.filter((word) => body.includes(word));
  check('no infrastructure words on the sheet', found.length === 0, found.join(','));

  check('the page logged no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();
};

await run();

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(`${entry.ok ? 'ok  ' : 'RED '} ${entry.name}${entry.detail ? `  — ${entry.detail}` : ''}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${OUT}.`);
process.exit(failed.length ? 1 : 0);