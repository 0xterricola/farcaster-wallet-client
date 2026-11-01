// End-to-end check for the one-time "let Fiddy post as you" offer: is it made,
// where it is made, in whose words, what stands in front of it — and do both
// ways of answering it (the phone approval, and saying not now) really end it?
//
//   cd apps/farcaster-web
//   SNAPCHAIN_HTTP_URL=https://<a public read node> \
//   VITE_SNAPCHAIN_HTTP_URL=https://<the same> \
//   npx vite --config scripts/probe.vite.config.mjs --port 5201 --strictPort
//
//   NODE_BACKED_SERVER=https://localhost:5201 node scripts/verify-post-for-you.mjs
//
// Only two things are stubbed: the SIWF relay, and `/api/fiddy/connect*`. The
// relay is stubbed with a REAL SIWE message signed by a throwaway key, so the
// app's own verifier accepts the sign-in for real — the same scaffolding
// `scripts/verify-node-backed-client.mjs` uses. The signed-in account is
// `fid 3` (`dwr`), which has a real follow graph, so the feed behind the offer
// is a real one.
//
// The connect service is stubbed, and NEVER called for real: a live POST to
// `https://fiddy.fun/api/fiddy/connect` mints a sponsored signer request and
// spends credits (measured — one was spent while building t_cd227393), and this
// probe runs against a local dev server anyway. The stub answers the way the
// service does: a first read with nothing asked for yet, a POST that hands back
// a link, and a poll that can be flipped to `connected` to stand in for a
// person tapping Approve in their own Farcaster app.
//
// WHAT IT ASSERTS (each one an observation, not a shape guess)
//
//   1. a completed sign-in lands in the CLIENT (not the setup sheet, not the
//      device-only landing that says nothing can load here)
//   2. the offer is on screen after it, in the shell, without the reader
//      navigating anywhere (`[data-fiddy="post-for-you"]`)
//   3. it is the one-time step the card asked for, in plain words: "Set it up"
//      and "Not now", the honest limit ("your account, its key and its recovery
//      phrase stay where they are"), and none of the protocol's own vocabulary
//   4. (the rewritten phrase-step check, both halves)
//      a. "Set it up" raises the PHONE APPROVAL asking by itself — one request,
//         the link, a code to scan, and no phrase field and no warning anywhere
//         on that path;
//      b. the phrase step is still reachable from the card's collapsed
//         "Advanced: test account recovery phrase (developers only)"
//         disclosure — invisible until it is opened — and still blocks until it
//         is acknowledged
//   5. nothing was signed and nothing was sent from this run — no
//      `/v1/submitMessage` left the page (the parent card's rule: a probe never
//      posts to mainnet, so the probe stops at the enabled button)
//   6. the same signed-in session is still reading the feed from a node — a
//      `200` on a cast route at a server that is not this app
//   7. "Not now" takes the offer away, and the device remembers: a reload keeps
//      it away (its own storage read, not a flag this probe set by hand)
//   8. (on a second, fresh device) approving in the reader's own Farcaster app
//      ends the offer, and the device remembers THAT too — the pass lives with
//      Fiddy's service, so the card would otherwise be offered again after a
//      reload
//
// Screenshots land in $NODE_BACKED_SHOT_DIR (default: the system temp dir).

import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.NODE_BACKED_SERVER ?? 'https://localhost:5201';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.NODE_BACKED_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'POSTFOR1';
const SIGNED_IN_FID = 3;
const APPROVAL = 'https://client.farcaster.xyz/deeplinks/signed-key-request?request=stub';

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

/**
 * Everything one signed-in device sees and does. A device is a browser context,
 * so its storage — the session, the pass, and the offer's own answer — is its
 * own: two of these are two different readers.
 *
 * `approval` is the one mutable knob: `connected: false` is a person who has not
 * approved yet, and flipping it makes the stub answer the way the service does
 * once they have.
 */
const openDevice = async (browser, approval = { connected: false }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  /** Every request the page made that would be a write to a Farcaster node. */
  const writes = [];
  /** Cast reads the network saw answered `200` by a server that is not this app. */
  const nodeCastReads = [];
  /** Every call the page made to the connect service, in order. */
  const connectCalls = [];

  page.on('request', (request) => {
    const url = request.url();
    if (/\/v1\/(submitMessage|validateMessage)/.test(url)) {
      writes.push(`${request.method()} ${url.slice(0, 120)}`);
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    const isCastRoute = /\/v1\/(castsByFid|castsByParent|castById)/.test(url);
    const onThisApp = url.startsWith(SERVER);
    if (isCastRoute && response.status() === 200 && !onThisApp) {
      nodeCastReads.push(`${response.status()} ${url.slice(0, 110)}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error')
      console.log(`  console: ${msg.text().slice(0, 160)}`);
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

  /**
   * ── the connect service, stubbed ─────────────────────────────────────────
   *
   * The shape is the real one: a read answers "nothing asked for yet" until a
   * POST has asked for something, the POST hands back the link (this is the
   * single request a person's press causes), and every read after that answers
   * "a request is waiting" until the stub is flipped to connected — which is
   * what an approval in the reader's own Farcaster app looks like from here.
   */
  let askedFor = false;
  await page.route('**/api/fiddy/connect*', async (route) => {
    const method = route.request().method();
    connectCalls.push(method);
    const status = (state, extra = {}) =>
      route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify({
          state,
          approvalUrl: null,
          fid: null,
          username: null,
          ...extra,
        }),
      });

    if (method === 'DELETE') {
      return status('revoked');
    }
    if (method === 'POST') {
      askedFor = true;
      return status('waiting', { approvalUrl: APPROVAL, reused: false });
    }
    if (approval.connected) {
      return status('connected', { fid: SIGNED_IN_FID, username: 'dwr' });
    }
    return askedFor
      ? status('waiting', { approvalUrl: APPROVAL })
      : status('none');
  });

  const signIn = async () => {
    await page.goto(`${SERVER}/welcome/ready`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('button, a, [role=button]')).some(
          (el) => /go social/i.test((el.innerText || '').replace(/\s+/g, ' ')),
        ),
      undefined,
      { timeout: 120_000 },
    );
    const button = await findButton(page, 'go social');
    let clicked = null;
    if (button) {
      await button.element.click();
      clicked = button.text;
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
    return clicked;
  };

  return {
    context,
    page,
    signIn,
    writes,
    nodeCastReads,
    connectCalls,
    // The stub's one knob, handed back so a caller can approve for the reader.
    approval,
  };
};

/** The offer card, and everything around it, as the page itself sees it. */
const readScreen = async (page) =>
  page.evaluate(() => {
    const card = document.querySelector('[data-fiddy="post-for-you"]');
    const main = document.querySelector('main');
    const link = document.querySelector('[data-fiddy="connect-approval-link"]');
    const disclosure = document.querySelector(
      '[data-fiddy="post-for-you-advanced"]',
    );
    const phraseButton = document.querySelector(
      '[data-fiddy="post-for-you-phrase"]',
    );
    const text = (document.body.innerText ?? '').replace(/\s+/g, ' ').trim();
    return {
      present: card !== null,
      text,
      cardText: (card?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      path: window.location.pathname,
      hasMain: main !== null,
      deviceOnlyLanding: text.includes('Farcaster signed this device in'),
      setupSheet: /go social/i.test(text),
      approvalSheet:
        document.querySelector('[data-fiddy="post-for-you-approval"]') !== null,
      waiting: document.querySelector('[data-fiddy-step="connect-waiting"]') !== null,
      qr: document.querySelector('[data-fiddy="connect-qr"]') !== null,
      approvalHref: link ? link.getAttribute('href') : null,
      phraseField: document.querySelector('#mnemonic') !== null,
      warning: /Security warning/.test(text),
      disclosure: disclosure
        ? {
            open: disclosure.open,
            summary: disclosure.querySelector('summary')?.textContent?.trim() ?? null,
          }
        : null,
      phraseButton: phraseButton !== null,
      phraseButtonVisible: phraseButton ? phraseButton.checkVisibility() : null,
      doneLine:
        document
          .querySelector('[data-fiddy="post-for-you-done"]')
          ?.textContent?.trim() ?? null,
    };
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

const checks = [];
const failed = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  if (!ok) failed.push(name);
};

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `post-for-you-${name}.png`) });
};

const banned = /gasless|signer|scope|ttl\b|key_add|app key|nonce|eip-?712/i;

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });

  // ── the device the offer is made to ───────────────────────────────────────
  const device = await openDevice(browser);
  const { page } = device;

  const clicked = await device.signIn();
  await page.waitForTimeout(2000);
  const afterSignIn = await readScreen(page);
  await shot(page, 'after-signin');

  check(
    'a completed sign-in lands in the client, not on a setup or device-only screen',
    clicked !== null &&
      afterSignIn.path === '/' &&
      afterSignIn.hasMain &&
      !afterSignIn.deviceOnlyLanding &&
      !afterSignIn.setupSheet,
    `clicked="${clicked}" path=${afterSignIn.path} main=${afterSignIn.hasMain} deviceOnly=${afterSignIn.deviceOnlyLanding}`,
  );

  // ── 2 + 3. the offer, in plain words ──────────────────────────────────────
  let offer = afterSignIn;
  if (!offer.present) {
    await page
      .waitForSelector('[data-fiddy="post-for-you"]', { timeout: 45_000 })
      .catch(() => undefined);
    offer = await readScreen(page);
  }
  await shot(page, 'offer');

  check(
    'the offer is made right after sign-in, in the shell, without navigating',
    offer.present,
    offer.present
      ? `path=${offer.path} card="${offer.cardText.slice(0, 140)}"`
      : `no [data-fiddy="post-for-you"] on screen; text="${offer.text.slice(0, 160)}"`,
  );

  const setItUp = await findButton(page, 'set it up');
  const notNow = await findButton(page, 'not now');
  check(
    'the offer is the two-button one-time step the card asked for, in plain words',
    setItUp !== null &&
      notNow !== null &&
      /stay where they are/i.test(offer.cardText) &&
      /one tap in your own farcaster app/i.test(offer.cardText) &&
      !banned.test(offer.cardText),
    `"Set it up"=${setItUp?.text ?? 'missing'} "Not now"=${notNow?.text ?? 'missing'} ${
      banned.test(offer.cardText)
        ? `| the card uses a protocol word: "${banned.exec(offer.cardText)?.[0]}"`
        : '| no protocol vocabulary on the card'
    }`,
  );

  // ── 4a. "Set it up" raises the phone approval, asking by itself ───────────
  let asked = null;
  if (setItUp) {
    await page
      .click('[data-fiddy="post-for-you-set-up"]')
      .catch(() => undefined);
    await page
      .waitForSelector('[data-fiddy-step="connect-waiting"]', {
        timeout: 30_000,
      })
      .catch(() => undefined);
    asked = await readScreen(page);
    await shot(page, 'approval-asking');
  }

  // ── 4b. and the phrase step is behind the card's collapsed disclosure ─────
  // Close the approval without approving: the offer stands, and the card comes
  // back — which is what makes the phrase step reachable at all.
  let backAtCard = null;
  if (asked?.approvalSheet) {
    await page
      .click('[data-fiddy-step="connect-waiting"] button.fiddy-quiet-btn')
      .catch(async () => {
        const quiet = await findButton(page, '^not now$');
        if (quiet) await quiet.element.click().catch(() => undefined);
      });
    await page.waitForTimeout(800);
    backAtCard = await readScreen(page);
  }

  const approvalPathClean =
    asked !== null &&
    asked.approvalSheet &&
    asked.waiting &&
    asked.qr &&
    asked.approvalHref === APPROVAL &&
    !asked.phraseField &&
    !asked.warning;

  // One request, made by the offer itself: no second press anywhere.
  const connectPosts = device.connectCalls.filter(
    (method) => method === 'POST',
  ).length;

  let phrase = {
    collapsed: false,
    visible: false,
    label: null,
    blocks: false,
    enabled: false,
  };
  if (backAtCard?.present) {
    const before = backAtCard;
    const card = page.locator('[data-fiddy="post-for-you-advanced"]');
    if ((await card.count()) > 0) {
      const summary = (
        await card.locator('summary').innerText()
      ).trim();
      const phraseDoor = page.locator('[data-fiddy="post-for-you-phrase"]');
      const hiddenBeforeOpening = !(await phraseDoor.isVisible().catch(() => false));

      await card.locator('summary').click();
      const visibleAfterOpening = await phraseDoor
        .isVisible()
        .catch(() => false);
      await phraseDoor.click();

      await page
        .waitForFunction(() => /Security warning/.test(document.body.innerText), undefined, {
          timeout: 30_000,
        })
        .catch(() => undefined);
      const first = await readScreen(page);
      const confirm = await findButton(
        page,
        'I understand, use a TEST account',
      );
      const disabledAtFirst = confirm ? await confirm.element.isDisabled() : null;

      // A phrase with no acknowledgement must still not be submittable.
      await page.fill(
        '#mnemonic',
        'test test test test test test test test test test test junk',
      );
      const withPhrase = await findButton(
        page,
        'I understand, use a TEST account',
      );
      const disabledWithPhrase = withPhrase
        ? await withPhrase.element.isDisabled()
        : null;

      // And the acknowledgement is what enables it — the gate is the warning,
      // not a dead end.
      await page.evaluate(() => {
        const box = document.querySelector('input[type=checkbox]');
        if (box) box.click();
      });
      const acknowledged = await findButton(
        page,
        'I understand, use a TEST account',
      );
      const enabledAfterAcknowledging = acknowledged
        ? !(await acknowledged.element.isDisabled())
        : null;
      await shot(page, 'advanced-phrase-warning');

      phrase = {
        collapsed: before.disclosure !== null && before.disclosure.open === false,
        label: summary,
        visible: hiddenBeforeOpening && visibleAfterOpening,
        blocks:
          first.warning &&
          disabledAtFirst === true &&
          disabledWithPhrase === true,
        enabled: enabledAfterAcknowledging === true,
      };

      // Never press the enabled confirm: that would ask a node to merge a real
      // KEY_ADD for a real account. The parent card's rule is that a probe does
      // not post to mainnet.
      const cancel = page.locator('button:has-text("Cancel")').first();
      if ((await cancel.count()) > 0) await cancel.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }

  check(
    'the offer asks for the phone approval by itself, and the phrase step is only behind its own disclosure',
    approvalPathClean &&
      connectPosts === 1 &&
      backAtCard?.present === true &&
      phrase.collapsed &&
      phrase.visible &&
      phrase.blocks &&
      phrase.enabled,
    `approval: sheet=${asked?.approvalSheet} waiting=${asked?.waiting} qr=${asked?.qr} link=${
      asked?.approvalHref === APPROVAL ? 'the stub' : asked?.approvalHref
    } requests=${connectPosts} phraseField=${asked?.phraseField} warning=${asked?.warning} | card back after closing: ${backAtCard?.present} | phrase step: disclosure="${phrase.label}" collapsed=${phrase.collapsed} hidden-then-visible=${phrase.visible} blocking=${phrase.blocks} enabled-on-acknowledgement=${phrase.enabled}`,
  );

  // ── 5 + 6. nothing signed, and the session still reads a node ─────────────
  await page.waitForTimeout(1500);
  check(
    'nothing was signed and nothing was sent from this run',
    device.writes.length === 0,
    device.writes.length === 0
      ? 'no /v1/submitMessage left the page'
      : device.writes.join(' | '),
  );
  check(
    'the same signed-in session is still reading the feed from a server that is not this app',
    device.nodeCastReads.length > 0,
    device.nodeCastReads.length > 0
      ? `${device.nodeCastReads.length} cast reads, first: ${device.nodeCastReads[0]}`
      : 'no cast read answered 200 at an absolute origin',
  );

  // ── 7. "Not now" ends it, and the device remembers ────────────────────────
  let afterNotNow = await readScreen(page);
  if (notNow && afterNotNow.present) {
    // Found again by its own attribute, not by a handle taken minutes ago: the
    // card re-renders whenever the pass or answer read resolves.
    await page
      .click('[data-fiddy="post-for-you-not-now"]')
      .catch(() => undefined);
    await page.waitForTimeout(1200);
    afterNotNow = await readScreen(page);
  }
  const goneAfterClick = !afterNotNow.present;

  await page.goto(`${SERVER}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);
  const afterReload = await readScreen(page);
  await shot(page, 'after-reload');

  check(
    '"Not now" takes the offer away, and the device remembers it across a reload',
    goneAfterClick && !afterReload.present,
    `after "Not now": present=${afterNotNow.present}; after reload at ${afterReload.path}: present=${afterReload.present}`,
  );

  // ── 8. approving in their own Farcaster app ends it, and is remembered ────
  // A second, fresh device: the first one has spent its one offer.
  const fresh = await openDevice(browser, { connected: false });
  const freshClicked = await fresh.signIn();
  await fresh.page
    .waitForSelector('[data-fiddy="post-for-you"]', { timeout: 45_000 })
    .catch(() => undefined);
  const freshOffer = await readScreen(fresh.page);
  const freshSetItUp = await findButton(fresh.page, 'set it up');
  if (freshSetItUp) {
    await fresh.page
      .click('[data-fiddy="post-for-you-set-up"]')
      .catch(() => undefined);
    await fresh.page
      .waitForSelector('[data-fiddy-step="connect-waiting"]', { timeout: 30_000 })
      .catch(() => undefined);
  }
  await shot(fresh.page, 'fresh-approval-asking');

  // The approval itself, which only happens in the reader's own Farcaster app:
  // this is the stub starting to answer the way the service does once it has.
  fresh.approval.connected = true;

  await fresh.page
    .waitForFunction(
      () =>
        document.querySelector('[data-fiddy="post-for-you-done"]') !== null ||
        document.querySelector('[data-fiddy="post-for-you"]') === null,
      undefined,
      { timeout: 45_000 },
    )
    .catch(() => undefined);
  const afterApproval = await readScreen(fresh.page);
  await shot(fresh.page, 'fresh-approved');

  await fresh.page.goto(`${SERVER}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await fresh.page.waitForTimeout(4000);
  const freshAfterReload = await readScreen(fresh.page);

  check(
    'approving in the reader’s own Farcaster app ends the offer, and the device remembers that',
    freshClicked !== null &&
      freshOffer.present &&
      freshSetItUp !== null &&
      /Fiddy can post for you now/.test(afterApproval.doneLine ?? '') &&
      !afterApproval.approvalSheet &&
      !freshAfterReload.present,
    `offer=${freshOffer.present} pressed=${freshSetItUp?.text ?? 'missing'} ended with="${
      afterApproval.doneLine ?? afterApproval.cardText.slice(0, 80)
    }" sheet still up=${afterApproval.approvalSheet} after reload: present=${freshAfterReload.present}`,
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