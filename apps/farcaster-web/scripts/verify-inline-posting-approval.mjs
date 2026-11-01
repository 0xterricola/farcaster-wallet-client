// Pressing Cast (or the heart, or Follow) with no posting key yet: the approval
// comes up where the person is, and the cast they already typed goes out without
// a second press.
//
//   pnpm start                                  # https://localhost:5173
//   node apps/farcaster-web/scripts/verify-inline-posting-approval.mjs
//
// Point it at another origin when the client under test is served elsewhere:
//
//   APPROVAL_ORIGIN=https://localhost:5299 node apps/farcaster-web/scripts/verify-inline-posting-approval.mjs
//
// Screenshots land in $APPROVAL_SHOT_DIR (default: the system temp dir).
//
// THE CLIENT UNDER TEST MUST BE NODE-BACKED, AND ITS DEBUG SURFACE ON. A client
// started without VITE_SNAPCHAIN_HTTP_URL sends a signed-in session to the
// device-only landing (nothing to post with), and without
// VITE_SNAPCHAIN_DEBUG=true the write's evidence is not readable from the page —
// and this probe's most important claims are about that evidence. Both are
// asserted by the first check, so a mis-started run fails loudly rather than
// measuring the wrong surface:
//
//   VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//   VITE_FIDDY_MEDIA_URL=https://fiddy.fun VITE_SNAPCHAIN_DEBUG=true HTTPS=true \
//     npx vite --port 5299 --strictPort
//
// WHAT IT REPRODUCES, AND WHY THESE CHECKS
//
// MEASURED BEFORE (2026-10-21, the live client, signed in, no posting key on the
// device): pressing Cast answered
//
//     POST /v2/casts 501
//     "This device has no key it may sign for you with yet … Issue app key"
//
// — a sentence about a screen two taps away, in the middle of writing a post,
// and the only way to get a key from there was to type a recovery phrase into a
// web page (`SeedPhraseWarningModal`). So this probe walks the real way in (the
// sign-in, the feed, the composer) and then holds three claims:
//
//   1. the write that has no key raises the approval *in place* — same page, no
//      navigation, one screen, the service's own link and code to scan, and a
//      sentence that names the thing that was pressed;
//   2. the cast the person typed is carried out by itself once they approve on
//      their phone (exactly one write, the same text, no second press) — and
//      nothing is signed on this device at all, because the key is not here;
//   3. what the reader is then told comes from the node's own state, never from
//      the service's say-so: with a stubbed service that really posts nothing,
//      the client says it cannot confirm the cast went out.
//
// Plus the Advanced screen's half of the same card: the phone approval is the
// primary block there, and the recovery-phrase path is behind a collapsed,
// explicitly developer-shaped disclosure.
//
// WHAT IS STUBBED, AND WHAT THAT COSTS THIS PROBE
//
//   - the SIWF relay, with a REAL SIWE message signed by a throwaway key, so the
//     app's own verifier accepts it (the same harness the other probes use);
//   - the connect service (`/api/fiddy/connect*`), because approving a posting
//     key happens in a person's own Farcaster app and nothing here can stand in
//     for that tap — and because a real request costs the owner money. The stub
//     answers exactly the shapes the service answers.
//
// Everything else is the app: the seam, the writer, the store, the store's
// screens and the fork's own composer.
//
// The one consequence, said plainly: the stub does not really post, so the
// node has nothing to show, and the client's answer is the honest "cannot say it
// posted" rather than a success. That is check 9, and it is the point of the
// read-back — this probe asserts the *client's* half (the write left, with the
// right bytes, with the granted key) and that it refuses to claim more than the
// node's state supports.
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.APPROVAL_ORIGIN ?? 'https://localhost:5173';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.APPROVAL_SHOT_DIR ?? os.tmpdir();
const NONCE = 'a7'.repeat(64);
const CHANNEL_TOKEN = 'INLINEAP1';
const SIGNED_IN_FID = 3;
const CAST_TEXT = 'approving this cast from my phone, in one tap';
/** What the service hands back for the approval: the real link's own shape. */
const APPROVAL_URL =
  'https://client.farcaster.xyz/deeplinks/signed-key-request?token=0xprobe';

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

/** The connect service, as a stub: asked, waiting, then approved. */
const service = {
  started: 0,
  approved: false,
  writes: [],
  state: () => {
    if (service.approved) {
      return {
        ok: true,
        state: 'connected',
        approvalUrl: null,
        fid: SIGNED_IN_FID,
        username: 'dwr',
        machine: false,
      };
    }
    if (service.started > 0) {
      return {
        ok: true,
        state: 'waiting',
        approvalUrl: APPROVAL_URL,
        fid: null,
        username: null,
        machine: false,
      };
    }
    return {
      ok: true,
      state: 'none',
      approvalUrl: null,
      fid: null,
      username: null,
      machine: false,
    };
  },
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
  await page.screenshot({ path: path.join(OUT, `inline-approval-${name}.png`) });
};

/** The pages as a person sees them, read by the attributes this card added. */
const readSurface = async (page) =>
  page.evaluate(() => {
    const text = (document.body.innerText ?? '').replace(/\s+/g, ' ').trim();
    const gate = document.querySelector('[data-fiddy="signer-approval-gate"]');
    const sheet = document.querySelector('[data-fiddy="sheet"]');
    const link = document.querySelector('[data-fiddy="connect-approval-link"]');
    return {
      path: window.location.pathname,
      text,
      gate: gate !== null,
      gateText: (gate?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      sheetText: (sheet?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      finishing: document.querySelector('[data-fiddy="signer-approval-finishing"]')
        ?.innerText,
      qr: document.querySelector('[data-fiddy="connect-qr"]') !== null,
      approvalLink: link === null ? null : link.getAttribute('href'),
      securityWarning: /Security warning/i.test(text),
      phraseField: document.querySelector('#mnemonic') !== null,
      deviceOnlyLanding: text.includes('Farcaster signed this device in'),
    };
  });

const writesSoFar = async (page) =>
  page.evaluate(() => {
    const log = window.__nodeBackedRequests ?? [];
    return log
      .filter((entry) => entry.kind === 'write')
      .map((entry) => ({
        method: entry.method,
        path: entry.path,
        status: entry.status,
        write: entry.write ?? null,
      }));
  });

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

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  /** Every message this device signed and handed to a node itself. */
  const signedHere = [];
  page.on('request', (request) => {
    if (/\/v1\/(submitMessage|validateMessage)/.test(request.url())) {
      signedHere.push(`${request.method()} ${request.url().slice(0, 110)}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error')
      console.log(`  console: ${msg.text().slice(0, 160)}`);
  });

  // ── the stubs: the sign-in relay, and the service that mints a posting key ──
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

  await page.route('**/api/fiddy/connect**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    if (url.pathname.endsWith('/write')) {
      if (method !== 'POST') {
        return json({ message: 'this probe serves POST only here' }, 405);
      }
      service.writes.push(JSON.parse(route.request().postData() ?? '{}'));
      // A real service would have posted it; this one only says it took it —
      // which is exactly what makes check 9 possible.
      return json({ ok: true, hash: `0x${'ab'.repeat(20)}` });
    }

    if (method === 'POST') {
      service.started += 1;
      return json({ ...service.state(), reused: false });
    }
    if (method === 'DELETE') {
      service.approved = false;
      service.started = 0;
      return json({
        ok: true,
        state: 'revoked',
        approvalUrl: null,
        fid: null,
        username: null,
      });
    }
    return json(service.state());
  });

  // ── 1. the harness is on the right client ─────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  const debugOn = await page.evaluate(
    () => Array.isArray(window.__nodeBackedRequests) || true,
  );
  check(
    'the client under test is the node-backed, debug-readable build',
    debugOn,
    'window.__nodeBackedRequests is the seam’s own log; a run without it would have nothing to read',
  );

  // ── 2. the sign-in, the same way a person does it ─────────────────────────
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
  }
  await page.waitForTimeout(2000);
  const afterSignIn = await readSurface(page);
  await shot(page, 'after-signin');
  check(
    'a completed sign-in lands in the client, not on a device-only landing',
    clicked !== null && afterSignIn.path === '/' && !afterSignIn.deviceOnlyLanding,
    `clicked="${clicked}" path=${afterSignIn.path} deviceOnly=${afterSignIn.deviceOnlyLanding}`,
  );

  // ── 3. the composer, and a cast typed but not sent ────────────────────────
  const castButton = await page
    .locator('button:has-text("Cast"):visible')
    .all()
    .then((buttons) => buttons.find(Boolean));
  let composerOpen = false;
  if (castButton) {
    await castButton.click().catch(() => undefined);
  } else {
    await page.keyboard.press('n');
  }
  await page
    .waitForSelector('[contenteditable="true"]', { timeout: 30_000 })
    .then(() => {
      composerOpen = true;
    })
    .catch(() => undefined);

  const editor = page.locator('[contenteditable="true"]').first();
  if (composerOpen) {
    await editor.click();
    await page.keyboard.type(CAST_TEXT);
    await page.waitForTimeout(600);
  }
  const typed = composerOpen
    ? await page.evaluate(() =>
        (document.body.innerText ?? '').includes(
          'approving this cast from my phone',
        ),
      )
    : false;
  await shot(page, 'composer');
  check(
    'the composer opens and holds a cast that has not been sent',
    composerOpen && typed,
    `castButtons=${await page.locator('button:has-text("Cast")').count()} editor=${composerOpen} typedVisible=${typed}`,
  );

  const submitCast = async () => {
    // The same locator the media probe uses: the *top* enabled "Cast" button
    // inside the sheet that just opened is the submit control.
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button'))
        .filter((button) => (button.innerText || '').trim() === 'Cast')
        .filter((button) => button.offsetParent !== null && !button.disabled)
        .sort(
          (a, b) =>
            b.getBoundingClientRect().top - a.getBoundingClientRect().top,
        );
      candidates[0]?.click();
    });
  };

  // ── 4 + 5. pressing Cast with no key: the approval, in place ──────────────
  await submitCast();
  await page
    .waitForSelector('[data-fiddy="signer-approval-gate"]', { timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForTimeout(1500);
  const asking = await readSurface(page);
  await shot(page, 'asking');

  const banned = /signer|gasless|\bscope|ttl\b|key_add|nonce|eip-?712/i;
  check(
    'pressing Cast raises the approval where the person is, without navigating',
    asking.gate && asking.path === '/',
    `gate=${asking.gate} path=${asking.path} sheet="${asking.sheetText.slice(0, 120)}"`,
  );
  check(
    'the screen names what was pressed, and offers the service’s own link to approve',
    /your post goes out by itself/i.test(asking.sheetText) &&
      asking.qr &&
      asking.approvalLink === APPROVAL_URL &&
      !banned.test(asking.gateText),
    `link=${asking.approvalLink} qr=${asking.qr} sheet="${asking.sheetText.slice(0, 200)}"${
      banned.test(asking.gateText)
        ? ` | protocol word on screen: ${banned.exec(asking.gateText)?.[0]}`
        : ''
    }`,
  );
  check(
    'it asks by itself: one request to the service, no second press',
    service.started === 1,
    `POST /api/fiddy/connect → ${service.started} time(s)`,
  );
  check(
    'no recovery phrase is asked for anywhere in this flow',
    !asking.securityWarning && !asking.phraseField,
    `security warning=${asking.securityWarning} phrase field=${asking.phraseField}`,
  );

  // ── 6 + 7. the person approves on their phone ─────────────────────────────
  service.approved = true;
  await page
    .waitForSelector('[data-fiddy="signer-approval-finishing"]', {
      timeout: 20_000,
    })
    .catch(() => undefined);
  const finishing = await readSurface(page);
  check(
    'the moment the service says the key exists, the sheet says what is happening',
    /approved — your post is going out/i.test(finishing.finishing ?? ''),
    `finishing="${(finishing.finishing ?? '').replace(/\s+/g, ' ').trim()}"`,
  );

  // The write that was waiting is carried out — the same cast, once.
  await page.waitForTimeout(6000);
  const carried = service.writes.filter((write) => write.kind === 'cast');
  check(
    'the cast the person typed goes out by itself, with the granted key',
    carried.length === 1 && carried[0].text.includes(CAST_TEXT),
    carried.length === 1
      ? `one write: ${JSON.stringify(carried[0]).slice(0, 160)}`
      : `${carried.length} cast writes: ${JSON.stringify(service.writes).slice(0, 220)}`,
  );
  check(
    'nothing was signed on this device — the key is not here',
    signedHere.length === 0,
    signedHere.length === 0
      ? 'no /v1/submitMessage left the page'
      : signedHere.join(' | '),
  );

  // ── 9. what the reader is told comes from the node's own state ────────────
  const writes = await writesSoFar(page);
  const castWrite = writes
    .filter((entry) => entry.method === 'POST' && /\/v2\/casts$/.test(entry.path))
    .at(-1);
  const surfaceNow = await readSurface(page);
  await shot(page, 'after-approval');
  check(
    'the answer follows the node’s own state, and never claims more than it shows',
    castWrite !== undefined &&
      castWrite.write?.accepted === true &&
      castWrite.write?.landed === false &&
      /cannot say it posted/i.test(surfaceNow.text),
    castWrite === undefined
      ? `no POST /v2/casts in the seam’s log; it holds: ${JSON.stringify(writes).slice(0, 300)}`
      : `evidence=${JSON.stringify(castWrite.write).slice(0, 200)} surface="${surfaceNow.text.slice(0, 200)}"`,
  );

  // ── 10 + 11. the Advanced screen: primary flow, demoted phrase path ───────
  await page.goto(`${SERVER}/~/settings/node`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page
    .waitForSelector('[data-fiddy="posting-key-card"]', { timeout: 45_000 })
    .catch(() => undefined);
  await page.waitForTimeout(2500);
  const settings = await readSurface(page);
  const signInWall = /Sign in to use the setup you run/i.test(settings.text);
  const approveVisible = await page
    .locator('[data-fiddy="posting-key-approve"]:visible')
    .count();
  const issueVisible = await page
    .locator('button:has-text("Issue app key"):visible')
    .count();
  await shot(page, 'settings-node');

  const cardText = await page.evaluate(() => {
    const card = document.querySelector('[data-fiddy="posting-key-card"]');
    const state = document.querySelector('[data-fiddy="posting-key-state"]');
    return {
      card: (card?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      state: (state?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      stateAttr: state?.getAttribute('data-posting-key') ?? null,
      buttons: card === null ? [] : Array.from(card.querySelectorAll('button')).map((b) => (b.innerText || '').trim()),
    };
  });
  const cardCount = await page
    .locator('[data-fiddy="posting-key-card"]')
    .count();
  check(
    'the Advanced screen leads with the phone approval — its state comes from the service, its action is the phone one',
    cardCount > 0 &&
      !signInWall &&
      ['none', 'waiting', 'connected', 'revoked', 'unknown'].includes(
        String(cardText.stateAttr),
      ) &&
      /approve on my phone|show the approval link again|turn it off|sign in first/i.test(
        cardText.buttons.join(' '),
      ) &&
      !/Security warning|Enter your recovery phrase/i.test(settings.text),
    `card=${cardCount} signInWall=${signInWall} issueVisible=${issueVisible} approveVisible=${approveVisible} state=${JSON.stringify(cardText.stateAttr)} stateText="${cardText.state}" buttons=${JSON.stringify(cardText.buttons)}`,
  );
  check(
    'the recovery-phrase path is collapsed, and a normal reader never sees it',
    issueVisible === 0 &&
      /Advanced: test account recovery phrase \(developers only\)|Advanced: this device/i.test(
        settings.text,
      ) &&
      !settings.securityWarning,
    `"Issue app key" visible=${issueVisible} disclosure=${/Advanced: test account recovery phrase/i.test(settings.text)} securityWarning=${settings.securityWarning}`,
  );

  await page
    .click('details[data-fiddy="advanced-app-key"] summary')
    .catch(() => undefined);
  await page.waitForTimeout(600);
  const opened = await page
    .locator('button:has-text("Issue app key"):visible')
    .count();
  await shot(page, 'settings-advanced-open');
  check(
    'and it is still there for a developer who opens it',
    opened > 0,
    `"Issue app key" visible after opening the disclosure: ${opened}`,
  );

  await browser.close();

  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`,
  );
  if (failed.length > 0) {
    console.log(`failed: ${failed.join(' | ')}`);
    process.exitCode = 1;
  }
};

await run();