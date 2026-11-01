// Whose Farcaster account does this browser become? A probe, not a review.
//
//   cd apps/farcaster-web
//   VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com VITE_SNAPCHAIN_DEBUG=true \
//     VITE_FIDDY_MEDIA_URL=https://fiddy.fun HTTPS=true \
//     npx vite --config scripts/probe.vite.config.mjs --port 5203 --strictPort
//   PROBE_SERVER=https://localhost:5203 node scripts/probe-connect-identity.mjs
//
// The node-backed build is never optional here: without
// VITE_SNAPCHAIN_HTTP_URL a signed-in session is device-only, `AuthedLayout`
// hands it `DeviceOnlySessionLanding`, and the connect surface this probe
// measures is never rendered (measured 2026-10-22: every check from B down
// failed against the landing's own words instead of the sheet).
//
// Screenshots land in $CONNECT_SHOT_DIR (default: the system temp dir).
//
// THE BUG THIS EXISTS FOR (reported live, 2026-10-22): a person signed in as
// their own account, pressed "Connect Farcaster", and ended up bound to the
// project's OWN Farcaster account (@fiddy-one, fid 3356372) instead of theirs.
// Nothing in the flow said whose account the posting key was for, so anything
// that answered with that fid became the session's identity.
//
// WHAT IT ASSERTS (each one an observation of the running app, not a shape
// guess). The service is stubbed — a probe never mints a real sponsored signer,
// because that spends the owner's Neynar credits — but the SIGN-IN is real: the
// SIWF relay is stubbed with a SIWE message signed by a throwaway key, so the
// app's own verifier has to genuinely accept it.
//
//   A. the person signs in as fid A through the app's own handshake
//   B. pressing Connect hands Fiddy's service A's OWN sign-in proof: the fid it
//      is signed in as, the message naming this host, and the signature over it
//      (recovered here with viem, from the message the browser actually sent)
//   C. the waiting screen hands over the approval link
//   D. when the approval is for A, the session is A — and nothing anywhere on
//      the page or in this browser's storage mentions Fiddy's own account
//   E. when the service refuses Fiddy's own account (what a fixed service does),
//      the sheet says so, nothing is adopted, and the app account appears
//      NOWHERE — no number, no handle — because the service sends neither
//   F. when a service that has NOT been fixed reports Fiddy's own account as the
//      connection, the client still does not become it: no way to adopt it, and
//      the stored session is still A
//   G. from that screen, "Connect my account" asks again for A, with A's proof
//
// Both viewport sizes the product is judged at, because the copy that decides
// this is read on a phone.

import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { recoverMessageAddress } from 'viem';

const SERVER = process.env.PROBE_SERVER ?? 'https://localhost:5203';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.CONNECT_SHOT_DIR ?? os.tmpdir();
const NONCE = 'e'.repeat(64);
const CHANNEL_TOKEN = 'CONNECT1';

/** The person, and the account they are signed in as. */
const PERSON_FID = 4242;
const PERSON_USERNAME = 'account-a';

/** Fiddy's own Farcaster account — the one that must never become anybody. */
const APP_FID = 3356372;
const APP_USERNAME = 'fiddy-one';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `https://${DOMAIN}/login`,
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

/**
 * Everything the app keeps about who this browser is — read straight out of
 * IndexedDB, because that is where the session lives (`~/utils/storageUtils` is
 * localforage). The identity under test is what this holds, not what a screen
 * says: a screen can be wrong, and the point of the probe is the session.
 */
const readEverythingStored = (page) =>
  page.evaluate(async () => {
    const dump = {};
    const databases =
      typeof globalThis.indexedDB.databases === 'function'
        ? await globalThis.indexedDB.databases()
        : [];
    for (const info of databases) {
      if (!info.name) continue;
      const db = await new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(info.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const storeName of Array.from(db.objectStoreNames)) {
        const store = db
          .transaction(storeName, 'readonly')
          .objectStore(storeName);
        const keys = await new Promise((resolve) => {
          const request = store.getAllKeys();
          request.onsuccess = () => resolve(request.result);
        });
        for (const key of keys) {
          const value = await new Promise((resolve) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
          });
          dump[`${info.name}/${storeName}/${String(key)}`] = value;
        }
      }
      db.close();
    }
    return dump;
  });

/** The session's own account, as the app stores it: the onboarding state. */
const sessionFid = (dump) => {
  for (const [key, value] of Object.entries(dump)) {
    if (!key.includes('onboarding-state')) continue;
    const fid = value?.result?.state?.user?.fid;
    if (typeof fid === 'number') return fid;
  }
  return null;
};

/** Does anything this browser stores mention that account — by number or name? */
const storageMentions = (dump, needle) => {
  const text = JSON.stringify(dump);
  return text.includes(String(needle));
};

const bodyText = async (page) => {
  try {
    return ((await page.innerText('body')) ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
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

const shot = async (page, name) => {
  const file = path.join(OUT, `connect-identity-${name}.png`);
  await page.screenshot({ path: file }).catch(() => undefined);
  return file;
};

/**
 * One browser: the service stubbed, the sign-in real. `service` is mutated
 * between steps so the same page can be walked through every outcome a real
 * person could meet.
 */
const open = async ({ label, width }) => {
  const service = {
    /** What GET answers next. */
    status: { state: 'none', approvalUrl: null, fid: null, username: null },
    /** Every POST body the browser sent, in order. */
    starts: [],
    /** Every GET and its answer, for the record. */
    reads: [],
  };

  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: 900 },
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) =>
    consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`),
  );

  // The sign-in: the relay answers a REAL message signed by a throwaway key.
  let statusCalls = 0;
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
    statusCalls += 1;
    const pending = statusCalls <= 2;
    return route.fulfill({
      status: pending ? 202 : 200,
      headers: CORS,
      body: JSON.stringify(
        pending
          ? { state: 'pending', nonce: NONCE }
          : {
              state: 'completed',
              nonce: NONCE,
              message,
              signature,
              fid: PERSON_FID,
              username: PERSON_USERNAME,
              displayName: 'Account A',
            },
      ),
    });
  });

  // The connect service, stubbed: a probe must never mint a real sponsored
  // signer. So this answers a plausible link and nothing else.
  await page.route('**/api/fiddy/connect**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === 'POST' && !url.pathname.endsWith('/write')) {
      const body = JSON.parse(route.request().postData() ?? '{}');
      service.starts.push(body);
      return route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          state: 'waiting',
          approvalUrl:
            'https://client.farcaster.xyz/deeplinks/signed-key-request?token=0xPROBE',
          reused: false,
          forFid: body.forFid ?? null,
          attempt: body.attempt ?? null,
        }),
      });
    }
    if (method === 'DELETE') {
      return route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, state: 'revoked' }),
      });
    }
    const answer = { ok: true, ...service.status };
    service.reads.push(answer);
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify(answer),
    });
  });

  await page.goto(`${SERVER}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => (document.body?.innerText ?? '').trim().length > 60,
    { timeout: 60_000 },
  );

  // The front door paints before its sign-in button does (the shell and its
  // providers land first), so WAIT for the button instead of clicking whatever
  // is on screen at that instant. Measured 2026-10-22: a desktop context that
  // clicked one paint too early never signed in, and the run then failed five
  // checks later as "not signed in" — a harness race reported as a product bug.
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

  const social = await findButton(page, 'go social');
  if (social) {
    await social.element.click();
    await page
      .waitForFunction(
        () => /channelToken=/.test(document.body?.innerText ?? ''),
        {
          timeout: 30_000,
        },
      )
      .catch(() => undefined);
  }
  // The sign-in reboots the app onto the session it just made. Wait for the
  // session itself (the stored state), never a fixed sleep: what the probe then
  // asserts is that session's identity.
  await page
    .waitForFunction(
      async () => {
        const databases = await globalThis.indexedDB.databases();
        for (const info of databases) {
          if (!info.name) continue;
          const db = await new Promise((resolve) => {
            const request = globalThis.indexedDB.open(info.name);
            request.onsuccess = () => resolve(request.result);
          });
          for (const storeName of Array.from(db.objectStoreNames)) {
            const keys = await new Promise((resolve) => {
              const request = db
                .transaction(storeName, 'readonly')
                .objectStore(storeName)
                .getAllKeys();
              request.onsuccess = () => resolve(request.result);
            });
            if (keys.some((key) => String(key).includes('onboarding-state'))) {
              db.close();
              return true;
            }
          }
          db.close();
        }
        return false;
      },
      undefined,
      { timeout: 60_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(3000);

  return {
    browser,
    page,
    service,
    label,
    consoleErrors,
    shot: (name) => shot(page, `${label}-${name}`),
  };
};

const runSize = async ({ label, width }) => {
  console.log(`\n── ${label} (${width}px) ──`);
  const run = await open({ label, width });
  const { page, service, consoleErrors } = run;

  // A. the person is signed in as A, through the app's own handshake.
  let dump = await readEverythingStored(page);
  check(
    `${label}: the person is signed in as their own account before connecting`,
    sessionFid(dump) === PERSON_FID,
    `session fid=${sessionFid(dump)} (expected ${PERSON_FID})`,
  );

  await page.goto(`${SERVER}/~/connect-farcaster`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page
    .waitForSelector('[data-fiddy-step="connect-idle"]', { timeout: 30_000 })
    .catch(() => undefined);
  await run.shot('idle');

  const connectButton = await findButton(page, '^connect$');
  if (connectButton) {
    await connectButton.element.click();
  }
  await page
    .waitForSelector('[data-fiddy-step="connect-waiting"]', { timeout: 30_000 })
    .catch(() => undefined);

  // B. what the browser asked with: the person's own proof, or nothing.
  const start = service.starts[0] ?? {};
  const proof = start.proof ?? {};
  const recovered =
    proof.message && proof.signature
      ? await recoverMessageAddress({
          message: proof.message,
          signature: proof.signature,
        }).catch(() => null)
      : null;
  check(
    `${label}: the connect request carries the person's own sign-in proof`,
    start.forFid === PERSON_FID &&
      typeof proof.message === 'string' &&
      proof.message.includes(DOMAIN) &&
      proof.nonce === NONCE &&
      recovered !== null &&
      recovered.toLowerCase() === account.address.toLowerCase(),
    `forFid=${start.forFid} domain-in-message=${String(proof.message ?? '').includes(DOMAIN)} nonce=${proof.nonce === NONCE} recovered=${recovered}`,
  );

  // C. the link the person opens is handed over.
  const approvalLink = await page
    .$eval('[data-fiddy="connect-approval-link"]', (el) =>
      el.getAttribute('href'),
    )
    .catch(() => null);
  check(
    `${label}: the approval link is shown, and a code to scan with it`,
    typeof approvalLink === 'string' && approvalLink.startsWith('https://'),
    `href=${approvalLink} qr=${(await page.$('[data-fiddy="connect-qr"]')) !== null}`,
  );
  await run.shot('waiting');

  // D. the approval is for the person's own account.
  service.status = {
    state: 'connected',
    approvalUrl: null,
    fid: PERSON_FID,
    username: PERSON_USERNAME,
    forFid: PERSON_FID,
    refused: null,
    attempt: start.attempt ?? null,
  };
  await page
    .waitForFunction(
      () => /Connected as @account-a/.test(document.body?.innerText ?? ''),
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  dump = await readEverythingStored(page);
  const text = await bodyText(page);
  await run.shot('connected-own');
  check(
    `${label}: their own approval names their own account, and the session is still theirs`,
    /Connected as @account-a/.test(text) &&
      sessionFid(dump) === PERSON_FID &&
      !storageMentions(dump, APP_FID) &&
      !text.includes(APP_USERNAME),
    `session fid=${sessionFid(dump)} text="${text.slice(0, 120)}"`,
  );

  // E. the service refuses Fiddy's own account (what the fixed service does).
  service.status = {
    state: 'wrong_account',
    approvalUrl: null,
    fid: null,
    username: null,
    forFid: PERSON_FID,
    refused: 'app_account',
    attempt: start.attempt ?? null,
  };
  await page.goto(`${SERVER}/~/connect-farcaster`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page
    .waitForSelector('[data-fiddy-step="connect-refused"]', { timeout: 30_000 })
    .catch(() => undefined);
  const refusedText = await bodyText(page);
  dump = await readEverythingStored(page);
  const refusedFile = await run.shot('refused-app-account');
  check(
    `${label}: a refusal is reported, and the app account appears nowhere at all`,
    /not for your account/i.test(refusedText) &&
      !refusedText.includes(String(APP_FID)) &&
      !refusedText.includes(APP_USERNAME) &&
      !storageMentions(dump, APP_FID) &&
      !storageMentions(dump, APP_USERNAME) &&
      sessionFid(dump) === PERSON_FID,
    `screen="${refusedText.slice(0, 140)}" screenshot=${refusedFile}`,
  );

  // F. an UNFIXED service: it answers that the connection is Fiddy's own
  //    account. The client must still refuse to be signed in as it.
  service.status = {
    state: 'connected',
    approvalUrl: null,
    fid: APP_FID,
    username: APP_USERNAME,
    forFid: null,
    refused: null,
    attempt: start.attempt ?? null,
  };
  await page.goto(`${SERVER}/~/connect-farcaster`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);
  const elsewhereText = await bodyText(page);
  dump = await readEverythingStored(page);
  const elsewhereFile = await run.shot('elsewhere-app-account');
  const adoptionOffered = await findButton(page, '^(continue|done)$');
  check(
    `${label}: a service that reports Fiddy's own account cannot sign this browser in as it`,
    adoptionOffered === null &&
      sessionFid(dump) === PERSON_FID &&
      !storageMentions(dump, APP_FID) &&
      /different account|already has a connection/i.test(elsewhereText),
    `adoption button=${adoptionOffered?.text ?? 'none'} session fid=${sessionFid(dump)} screen="${elsewhereText.slice(0, 140)}" screenshot=${elsewhereFile}`,
  );

  // G. and the way forward from there asks again, for the person's own account.
  const before = service.starts.length;
  const reask = await findButton(page, '^(connect my account|that.s me)$');
  if (reask) {
    await reask.element.click();
    await page.waitForTimeout(2500);
  }
  const second = service.starts[before] ?? {};
  check(
    `${label}: asking again from that screen re-asks for the person's own account`,
    reask !== null && second.forFid === PERSON_FID,
    `button=${reask?.text ?? 'none'} forFid=${second.forFid}`,
  );

  if (consoleErrors.length > 0) {
    console.log(
      `        console errors: ${consoleErrors.slice(0, 3).join(' | ')}`,
    );
  }

  await run.browser.close();
};

await runSize({ label: 'phone', width: 390 });
await runSize({ label: 'desktop', width: 1440 });

console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`,
);
if (failed.length > 0) {
  console.log(`failed: ${failed.join(' | ')}`);
  process.exitCode = 1;
}
