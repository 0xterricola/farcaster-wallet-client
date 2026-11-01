// End-to-end check for the Advanced screen: does the settings list actually
// carry a door to it, does that door open the CLI entry, is the copy the
// command's own, and does the page hold together at 390px and 1440px?
//
//   cd apps/farcaster-web
//   SNAPCHAIN_HTTP_URL=https://<a public read node> \
//   VITE_SNAPCHAIN_HTTP_URL=https://<the same> \
//   npx vite --config scripts/probe.vite.config.mjs --port 5311 --strictPort
//
//   NODE_BACKED_SERVER=https://localhost:5311 node scripts/verify-advanced-cli.mjs
//
// Only the SIWF relay is stubbed, and it is stubbed with a REAL SIWE message
// signed by a throwaway key, so the app's own verifier accepts the sign-in for
// real — the same scaffolding `scripts/verify-post-for-you.mjs` uses. The
// signed-in account is `fid 3` (`dwr`), a real account with a real follow graph.
//
// WHAT IT ASSERTS (each one an observation, not a shape guess)
//
//   1. a completed sign-in lands in the CLIENT, not on a setup or device-only
//      screen — without which nothing below it means anything
//   2. the settings list carries the entry at the phone width too: "Advanced"
//      is in the list a reader sees at 390px, not only in the desktop rail
//   3. that entry opens /~/settings/advanced and the CLI entry renders there
//   4. the entry shows the command's own four subcommands, each with the plain
//      words for what it does and a control to copy it
//   5. the copy control reports a copy it really made: the button says
//      "Copied" AND the clipboard holds that command (read back from the page)
//   6. the page is in plain words — no protocol vocabulary anywhere in the
//      column (the card's jargon ban), for the reader who has never configured
//      anything
//   7. the agentic rows are announced as not-here-yet: each carries its note,
//      and there is nothing to press under them
//   8. no horizontal overflow at 390px or 1440px, and the entry is inside the
//      viewport at both
//   9. nothing threw: zero uncaught page errors across the whole run
//
// Screenshots land in $NODE_BACKED_SHOT_DIR (default: the system temp dir).

import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.NODE_BACKED_SERVER ?? 'https://localhost:5311';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.NODE_BACKED_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'ADVANCED1';
const SIGNED_IN_FID = 3;

/**
 * The four subcommands the entry must show, as `bin/fiddy` documents them.
 * Held here rather than imported: the page's list lives in a `.ts` module this
 * Node program cannot import, and a probe that read the list from the page
 * would agree with whatever the page happened to render.
 */
const COMMANDS = [
  'fiddy provision',
  'fiddy node up',
  'fiddy client up',
  'fiddy doctor',
];

/** The vocabulary the page's copy is not allowed to use. */
const BANNED = /gasless|signer|scope|ttl\b|key_add|app key|nonce|eip-?712/i;

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
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const checks = [];
const failed = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  if (!ok) failed.push(name);
};

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `advanced-cli-${name}.png`) });
};

const findButton = async (page, pattern) => {
  for (const element of await page.$$('button, a, [role=button]')) {
    const text = ((await element.innerText()) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (new RegExp(pattern, 'i').test(text)) {
      return { element, text };
    }
  }
  return null;
};

/** The rail's own entry for this page, and where it points. */
const readEntryLink = async (page) =>
  page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const link = links.find(
      (candidate) =>
        (candidate.innerText || '').replace(/\s+/g, ' ').trim() === 'Advanced',
    );
    if (!link) {
      return {
        found: false,
        visible: false,
        href: null,
        box: null,
        anchorTexts: links
          .map((candidate) =>
            (candidate.innerText || '').replace(/\s+/g, ' ').trim(),
          )
          .filter((text) => text.length > 0)
          .slice(0, 14),
      };
    }
    const rect = link.getBoundingClientRect();
    return {
      found: true,
      visible: rect.width > 0 && rect.height > 0,
      href: link.getAttribute('href'),
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });

/** The CLI entry as the page itself renders it. */
const readCliEntry = async (page) =>
  page.evaluate(() => {
    const entry = document.querySelector('[data-fiddy="advanced-cli"]');
    const column = document.querySelector('main') ?? document.body;
    const rows = Array.from(
      document.querySelectorAll('[data-fiddy="cli-command"]'),
    ).map((row) => ({
      command: row.getAttribute('data-command'),
      text: (row.innerText || '').replace(/\s+/g, ' ').trim(),
      hasCopy:
        row.querySelector('[data-fiddy="cli-copy"]') !== null &&
        row.querySelector('[data-fiddy="cli-copy"]') !== undefined,
    }));
    const rect = entry?.getBoundingClientRect();
    const columnRect = column.getBoundingClientRect();
    return {
      present: entry !== null,
      heading: (entry?.querySelector('h3')?.innerText ?? '').trim(),
      rows,
      comingRows: Array.from(
        document.querySelectorAll('[data-fiddy="agent-cli-coming-row"]'),
      ).map((row) => (row.innerText || '').replace(/\s+/g, ' ').trim()),
      comingButtons: document.querySelectorAll(
        '[data-fiddy="agent-cli-coming"] button',
      ).length,
      columnText: (column.innerText || '').replace(/\s+/g, ' ').trim(),
      path: window.location.pathname,
      overflow: {
        document:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        column:
          columnRect.width -
          (column.scrollWidth > 0 ? columnRect.width : columnRect.width),
      },
      entryBox: rect
        ? { x: rect.x, width: rect.width, right: rect.right }
        : null,
      viewport: { width: window.innerWidth },
    };
  });

const readCopyButton = async (page) =>
  page.evaluate(() => {
    const button = document.querySelector('[data-fiddy="cli-copy"]');
    if (!button) {
      return null;
    }
    const rect = button.getBoundingClientRect();
    return {
      label: (button.innerText || '').trim(),
      ariaLabel: button.getAttribute('aria-label'),
      visible: rect.width > 0 && rect.height > 0,
    };
  });

const readClipboard = async (page) =>
  page
    .evaluate(() => window.navigator.clipboard.readText())
    .catch((error) => `unreadable: ${String(error).slice(0, 80)}`);

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  await context
    .grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: SERVER,
    })
    .catch(() => undefined);
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (error) => {
    pageErrors.push(String(error.message ?? error).slice(0, 200));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`  console: ${msg.text().slice(0, 160)}`);
    }
  });

  // ── the sign-in: real SIWE, stubbed relay ─────────────────────────────────
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
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        state: 'completed',
        nonce: NONCE,
        message,
        signature,
        fid: SIGNED_IN_FID,
        username: 'dwr',
        displayName: 'dwr',
      }),
    });
  });

  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('button, a, [role=button]')).some(
          (el) => /go social/i.test((el.innerText || '').replace(/\s+/g, ' ')),
        ),
      undefined,
      { timeout: 120_000 },
    )
    .catch(() => undefined);

  const goSocial = await findButton(page, 'go social');
  let clicked = null;
  if (goSocial) {
    await goSocial.element.click();
    clicked = goSocial.text;
  }
  await page
    .waitForFunction(
      () =>
        window.location.pathname === '/' &&
        document.querySelector('main') !== null &&
        !document.body.innerText.includes('Farcaster signed this device in'),
      undefined,
      { timeout: 60_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(1500);

  const afterSignIn = await page.evaluate(() => ({
    path: window.location.pathname,
    hasMain: document.querySelector('main') !== null,
    deviceOnlyLanding: document.body.innerText.includes(
      'Farcaster signed this device in',
    ),
    setupSheet: /go social/i.test(document.body.innerText),
  }));
  await shot(page, '390-after-signin');

  check(
    'a completed sign-in lands in the client, not on a setup or device-only screen',
    clicked !== null &&
      afterSignIn.path === '/' &&
      afterSignIn.hasMain &&
      !afterSignIn.deviceOnlyLanding &&
      !afterSignIn.setupSheet,
    `clicked="${clicked}" path=${afterSignIn.path} main=${afterSignIn.hasMain} deviceOnly=${afterSignIn.deviceOnlyLanding}`,
  );

  // ── 2. the entry, in the list a phone reader sees ─────────────────────────
  await page.goto(`${SERVER}/~/settings`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  // The authed shell paints late on a loaded machine, so this waits for the
  // list itself rather than for a fixed number of milliseconds — a fixed wait
  // measured the loading state once already (2.5s was not enough under load).
  // Wait for this list's own entry, not for "some nav" — the shell's left rail
  // is up long before the settings list is, and matching it measured the wrong
  // list once already.
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('a')).some(
          (candidate) =>
            (candidate.innerText || '').replace(/\s+/g, ' ').trim() ===
            'Advanced',
        ),
      undefined,
      { timeout: 90_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(500);
  const phoneEntry = await readEntryLink(page);
  await shot(page, '390-settings-list');

  check(
    'the settings list carries the Advanced entry at 390px, visible and pointing here',
    phoneEntry.found &&
      phoneEntry.visible &&
      typeof phoneEntry.href === 'string' &&
      phoneEntry.href.includes('/settings/advanced'),
    `found=${phoneEntry.found} visible=${phoneEntry.visible} href=${phoneEntry.href}${
      phoneEntry.found
        ? ''
        : ` | the list showed: ${JSON.stringify(phoneEntry.anchorTexts ?? [])}`
    }`,
  );

  // ── 3. the entry opens the page ───────────────────────────────────────────
  const entryLinkText = 'Advanced';
  let opened = { path: '/', present: false };
  if (phoneEntry.found) {
    await page.evaluate((label) => {
      const link = Array.from(document.querySelectorAll('a')).find(
        (candidate) =>
          (candidate.innerText || '').replace(/\s+/g, ' ').trim() === label,
      );
      link?.click();
    }, entryLinkText);
    await page
      .waitForFunction(
        () => window.location.pathname.endsWith('/settings/advanced'),
        undefined,
        { timeout: 30_000 },
      )
      .catch(() => undefined);
    // Wait for the card itself, again rather than for a clock.
    await page
      .waitForSelector('[data-fiddy="advanced-cli"]', { timeout: 60_000 })
      .catch(() => undefined);
    await page.waitForTimeout(600);
  }
  const entryAtPhone = await readCliEntry(page);
  opened = { path: entryAtPhone.path, present: entryAtPhone.present };
  await shot(page, '390-advanced');

  check(
    'the entry opens the CLI screen, and the CLI card renders there',
    opened.path.endsWith('/settings/advanced') && opened.present,
    `path=${opened.path} card=${opened.present} heading="${entryAtPhone.heading}"`,
  );

  // ── 4. the command's own four lines ──────────────────────────────────────
  const shown = entryAtPhone.rows.map((row) => row.command);
  const missing = COMMANDS.filter((command) => !shown.includes(command));
  const withoutCopy = entryAtPhone.rows.filter((row) => !row.hasCopy).length;
  const withoutWords = entryAtPhone.rows.filter(
    (row) => row.text.replace(row.command, '').trim().length < 20,
  ).length;

  check(
    'the entry shows the command’s own four subcommands',
    missing.length === 0 && shown.length === COMMANDS.length,
    `shown=${JSON.stringify(shown)}${missing.length ? ` missing=${JSON.stringify(missing)}` : ''}`,
  );

  check(
    'each command carries what it does in plain words, and a control to copy it',
    withoutCopy === 0 && withoutWords === 0,
    `rows=${entryAtPhone.rows.length} without-copy=${withoutCopy} without-words=${withoutWords}`,
  );

  // ── 5. the copy control tells the truth ──────────────────────────────────
  const before = await readCopyButton(page);
  await page.click('[data-fiddy="cli-copy"]').catch(() => undefined);
  await page.waitForTimeout(600);
  const after = await readCopyButton(page);
  const clipboard = await readClipboard(page);

  check(
    'the copy control reports a copy it really made, and the clipboard holds that command',
    before !== null &&
      before.visible &&
      after !== null &&
      after.label === 'Copied' &&
      clipboard === COMMANDS[0],
    `label before="${before?.label}" after="${after?.label}" clipboard="${String(clipboard).slice(0, 60)}" aria="${before?.ariaLabel}"`,
  );

  // ── 6. plain words ───────────────────────────────────────────────────────
  const bannedHit = entryAtPhone.columnText.match(BANNED);

  check(
    'the screen is in plain words — no protocol vocabulary in the column',
    bannedHit === null,
    bannedHit
      ? `the page says "${bannedHit[0]}"`
      : `column is ${entryAtPhone.columnText.length} chars, no protocol words`,
  );

  // ── 7. what is not built is not offered ──────────────────────────────────
  const comingOk =
    entryAtPhone.comingRows.length === 2 &&
    entryAtPhone.comingRows.every((row) => /soon/i.test(row)) &&
    entryAtPhone.comingButtons === 0;

  check(
    'the agentic rows say not-here-yet, with nothing to press under them',
    comingOk,
    `rows=${JSON.stringify(entryAtPhone.comingRows)} buttons=${entryAtPhone.comingButtons}`,
  );

  // ── 8. the phone width holds ─────────────────────────────────────────────
  const phoneOverflow = entryAtPhone.overflow.document;
  const phoneInside =
    entryAtPhone.entryBox !== null &&
    entryAtPhone.entryBox.right <= entryAtPhone.viewport.width + 1 &&
    entryAtPhone.entryBox.x >= -1;

  check(
    'no horizontal overflow at 390px, and the entry is inside the viewport',
    phoneOverflow <= 1 && phoneInside,
    `document overflow=${phoneOverflow}px entry right=${entryAtPhone.entryBox?.right} viewport=${entryAtPhone.viewport.width}px`,
  );

  // ── 9. the desktop width holds, with the rail's own entry ────────────────
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1200);
  const desktopEntry = await readEntryLink(page);
  const entryAtDesktop = await readCliEntry(page);
  await shot(page, '1440-advanced');

  check(
    'at 1440px the entry is in the rail, the card renders, and nothing overflows',
    desktopEntry.found &&
      desktopEntry.visible &&
      entryAtDesktop.present &&
      entryAtDesktop.overflow.document <= 1 &&
      entryAtDesktop.entryBox !== null &&
      entryAtDesktop.entryBox.right <= 1441,
    `rail found=${desktopEntry.found} visible=${desktopEntry.visible} card=${entryAtDesktop.present} overflow=${entryAtDesktop.overflow.document}px entry right=${entryAtDesktop.entryBox?.right}`,
  );

  check(
    'nothing threw: zero uncaught page errors across the run',
    pageErrors.length === 0,
    pageErrors.length ? pageErrors.join(' | ') : 'none',
  );

  await browser.close();

  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks`);
  if (failed.length) {
    console.log(`failed: ${failed.join(' | ')}`);
  }
  return failed.length === 0 ? 0 : 1;
};

const code = await run();
console.log(`EXIT=${code}`);
process.exit(code);
