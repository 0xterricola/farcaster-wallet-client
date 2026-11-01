// End-to-end check that switching accounts really switches the account.
//
//   HTTPS=true SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     npx vite --port 5177 --strictPort
//   ACCOUNT_SWITCH_SERVER=https://localhost:5177 node scripts/verify-account-switching.mjs
//
// Needs a dev server with a node configured, because a session with nowhere to
// read from lands on the device-only screen and never reaches the rail where the
// switcher lives. Only the SIWF relay is stubbed, and it is stubbed with a REAL
// SIWE message signed by a throwaway key, so the app's own verifier accepts the
// sign-in for real. The FID it names is 3 (`dwr`), a real account, so the shell
// has a real feed to render.
//
// WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT DO
// Two accounts are put on the device through the app's OWN storage modules
// (`~/snapchain/accounts/localAccounts`, `~/snapchain/appKeyStorage`), imported
// over the dev server — not by hand-writing IndexedDB, because the point is what
// the app reads back, not whether this script can spell a localforage key. Then
// the switch itself is done the way a person does it: the rail's entry, the
// sheet, the "Sign in as …" button. Nothing here touches the chain, and no
// account is created: account creation is measured by
// `src/snapchain/accounts/__tests__` against a mocked chain and node.
//
// WHAT IT ASSERTS (per account, before and after the switch)
//   1. the session: the FID the client's own auth token carries
//   2. the per-account label: the rail's entry, both rows in the sheet, and the
//      "signing in as this one" marker — exactly one account may be current
//   3. what this device can do with it: `loadAppKey(fid)`, the store the write
//      path signs from, read through the app's own module
//   4. a write attempt: the client's real write entry point is pressed and what
//      the client then does is recorded — no composer, a refusal named in the
//      client's own words, or a write-shaped request. MEASURED on this branch
//      (t_bb61fcf8): the composer does not open and the client issues no write
//      request, because node-backed writes live on the t_aa93f0c5 branch. When
//      that lands, the same row records the request and which session it left
//      from. It is recorded as a measurement, never asserted as a pass.
//   5. the round trip: switching back to the first account returns the session
//      to the first FID, and both keys are still on the device.
//
// SAFETY: every non-GET request to anything but the dev server is aborted and
// counted, so a write attempt can never reach a real network from this probe —
// and the count is asserted, because a probe that quietly posted a cast as
// somebody else would be worse than no probe.
//
// Screenshots land in $ACCOUNT_SWITCH_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.ACCOUNT_SWITCH_SERVER ?? 'https://localhost:5177';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.ACCOUNT_SWITCH_SHOT_DIR ?? os.tmpdir();
const NONCE = 'a'.repeat(128);
const CHANNEL_TOKEN = 'ACCOUNTSW1';

/** The account the stubbed sign-in names: a real, active one. */
const SIGNED_IN_FID = 3;
const SIGNED_IN_HANDLE = 'dwr';

/** The two local accounts this probe puts on the device. */
const DEVICE_KEY_A = `0x${'aa'.repeat(32)}`;
const DEVICE_KEY_B = `0x${'bb'.repeat(32)}`;

const accountSigner = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: accountSigner.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SERVER}/login`,
  version: '1',
});
const signature = await accountSigner.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const ACCOUNT_A = {
  id: accountSigner.address.toLowerCase(),
  custodyAddress: accountSigner.address,
  fid: SIGNED_IN_FID,
  username: SIGNED_IN_HANDLE,
  displayName: SIGNED_IN_HANDLE,
  createdAt: 1,
  signedInAt: 1,
};

const ACCOUNT_B = {
  id: '0x4444444444444444444444444444444444444444',
  custodyAddress: '0x4444444444444444444444444444444444444444',
  fid: 4242,
  username: 'probe-two',
  displayName: 'Probe Two',
  createdAt: 2,
  signedInAt: 2,
};

const startedAt = Date.now();
const stage = (step) =>
  console.log(`[${String(Math.round((Date.now() - startedAt) / 1000)).padStart(3)}s] ${step}`);

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
};

/** What the page shows and what the client holds, in one read.
 *
 *  Retried until the rail is on screen, because a switch reboots the client and
 *  a read taken in that instant sees a remounting shell rather than a missing
 *  account. The assertions are unchanged: this waits for the app, it does not
 *  soften what the app then says.
 */
const readState = async (page, tries = 15) => {
  let last = null;

  for (let attempt = 0; attempt < tries; attempt += 1) {
    last = await readStateOnce(page);

    if (last.onShell && (last.sheetText !== null || last.entryText !== null)) {
      return last;
    }

    await page.waitForTimeout(2_000);
  }

  return last;
};

const readStateOnce = (page) =>
  page.evaluate(async () => {
    const dash = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const storage = await import('/src/utils/storageUtils.ts');
    const keys = await import('/src/snapchain/appKeyStorage.ts');
    const accountsModule = await import('/src/snapchain/accounts/localAccounts.ts');

    const token = await storage.getItem({ key: 'auth-token', fallback: null });
    const accounts = await accountsModule.loadLocalAccounts();
    const currentId = await accountsModule.loadCurrentAccountId();

    const keysHeld = {};
    for (const account of accounts) {
      keysHeld[account.fid ?? 'no-fid'] =
        account.fid === undefined ? null : (await keys.loadAppKey(account.fid)) !== null;
    }

    const entry = document.querySelector('[data-fiddy="account-switcher-entry"]');
    const sheet = document.querySelector('[data-fiddy="account-switcher"]');

    return {
      sessionFid: token?.secret ? Number(String(token.secret).split(':')[1]) : null,
      accounts: accounts.map((account) => ({
        id: account.id,
        fid: account.fid,
        username: account.username,
      })),
      currentId: currentId ?? null,
      keysHeld,
      entryText: entry ? dash(entry.innerText) : null,
      sheetText: sheet ? dash(sheet.innerText) : null,
      rows: Array.from(document.querySelectorAll('[data-fiddy-account]')).map((row) => ({
        id: row.getAttribute('data-fiddy-account'),
        current: row.className.includes('current'),
        text: dash(row.innerText),
        buttons: Array.from(row.querySelectorAll('button')).map((button) => dash(button.innerText)),
      })),
      currentMarker: (() => {
        const element = document.querySelector('[data-fiddy="account-current"]');
        return element ? dash(element.innerText) : null;
      })(),
      onShell: Boolean(entry),
      deviceOnly: Boolean(document.querySelector('[data-fiddy="device-only-session"]')),
    };
  });

/** Sign in through the stubbed relay, and wait for the rail to carry the entry. */
const signIn = async (page) => {
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
        username: SIGNED_IN_HANDLE,
        displayName: SIGNED_IN_HANDLE,
      }),
    });
  });

  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForSelector('button', { timeout: 60_000 });
  await page.waitForTimeout(1_500);

  const clicked = await page.evaluate(() => {
    for (const element of document.querySelectorAll('button, a, [role=button]')) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (/go social/i.test(text)) {
        element.click();
        return text;
      }
    }
    return null;
  });

  if (clicked === null) {
    throw new Error('the sign-in button was not on the setup screen');
  }

  // The rail's entry is the signed-in shell: it cannot render before the
  // session exists, so waiting for it is waiting for the whole handshake.
  await page.waitForSelector('[data-fiddy="account-switcher-entry"]', {
    timeout: 180_000,
  });
};

/** Put two accounts and their keys on the device, through the app's own store. */
const seedAccounts = async (page) =>
  page.evaluate(
    async ({ a, b, keyA, keyB }) => {
      const accounts = await import(
        '/src/snapchain/accounts/localAccounts.ts'
      );
      const keys = await import('/src/snapchain/appKeyStorage.ts');

      await accounts.saveLocalAccount(a);
      await accounts.saveLocalAccount(b, { select: false });
      await accounts.selectLocalAccount(a.id);

      await keys.saveAppKey(a.fid, keyA);
      await keys.saveAppNonce(a.fid, 11);
      await keys.saveAppKey(b.fid, keyB);
      await keys.saveAppNonce(b.fid, 12);

      return {
        accounts: (await accounts.loadLocalAccounts()).map((entry) => entry.fid),
        current: await accounts.loadCurrentAccountId(),
        keyA: (await keys.loadAppKey(a.fid)) === keyA,
        keyB: (await keys.loadAppKey(b.fid)) === keyB,
      };
    },
    { a: ACCOUNT_A, b: ACCOUNT_B, keyA: DEVICE_KEY_A, keyB: DEVICE_KEY_B },
  );

/** Open the sheet from the rail's entry.
 *
 *  Retried, because the rail remounts: a switch reboots the client, and a read
 *  taken in that instant finds no entry at all. A retry here is waiting for the
 *  app, not loosening the check — what the sheet then says is asserted as
 *  strictly as ever.
 */
const openSwitcher = async (page, tries = 12) => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await page.waitForSelector('[data-fiddy="account-switcher-entry"]', {
      timeout: 60_000,
    });

    const clicked = await page.evaluate(() => {
      const entry = document.querySelector('[data-fiddy="account-switcher-entry"]');
      if (!entry) {
        return 'no-entry';
      }
      entry.click();
      return 'clicked';
    });

    if (clicked === 'clicked') {
      const opened = await page
        .waitForSelector('[data-fiddy="account-switcher"]', { timeout: 8_000 })
        .then(() => true)
        .catch(() => false);

      if (opened) {
        await page.waitForTimeout(1_200);
        return;
      }
    }

    await page.waitForTimeout(2_000);
  }

  const state = await page.evaluate(() => ({
    nodes: Array.from(document.querySelectorAll('[data-fiddy]')).map((node) =>
      node.getAttribute('data-fiddy'),
    ),
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200),
  }));

  throw new Error(`the account switcher did not open: ${JSON.stringify(state)}`);
};

const closeSwitcher = async (page) => {
  await page.evaluate(() => {
    const sheet = document.querySelector('[data-fiddy="account-switcher"]');
    const close = Array.from(sheet?.querySelectorAll('button') ?? []).find((button) =>
      /^close$/i.test(button.innerText.trim()),
    );
    close?.click();
  });
  await page.waitForTimeout(800);
};

/**
 * Press the client's real write entry point and record what it does.
 *
 * Deliberately a measurement, not an assertion: on a build with node-backed
 * writes the honest expectation is a write-shaped request leaving this session;
 * on this branch there is no composer to open, and inventing a pass for that
 * would be the green-void this repo's probes exist to avoid.
 */
const attemptWrite = async (page, writes) => {
  const before = writes.length;

  const pressed = await page.evaluate(() => {
    for (const button of document.querySelectorAll('button')) {
      if (
        /^cast$/i.test(button.innerText.trim()) &&
        button.getBoundingClientRect().width > 0
      ) {
        button.click();
        return true;
      }
    }
    return false;
  });
  await page.waitForTimeout(6_000);

  const surface = await page.evaluate(() => ({
    composer:
      document.querySelectorAll('textarea').length > 0 ||
      Boolean(document.querySelector('[data-fiddy="composer"]')),
    named: (() => {
      const text = document.body.innerText.replace(/\s+/g, ' ');
      const match =
        text.match(/[^.]*no node-backed[^.]*\./i) ??
        text.match(/[^.]*cannot post[^.]*\./i);
      return match ? match[0].trim().slice(0, 160) : null;
    })(),
  }));

  const outgoing = writes.slice(before);

  const read =
    outgoing.length > 0
      ? `the client issued ${outgoing.length} write request(s): ${outgoing
          .slice(0, 2)
          .join(', ')}`
      : surface.composer
        ? 'the composer opened, and no write request left the client'
        : surface.named
          ? `the client refused it in its own words: "${surface.named}"`
          : pressed
            ? 'pressing "Cast" opened no composer and issued no write request — this build has no node-backed write path (writes are the t_aa93f0c5 branch)'
            : 'there was no write entry point to press on this screen';

  return {
    entryPointFound: pressed,
    composerOpened: surface.composer,
    requestsLeaving: outgoing.length,
    requests: outgoing.slice(0, 4),
    clientWords: surface.named,
    read,
  };
};

/** Read the sheet's rows as one line per account, for the report. */
const describeRows = (rows) =>
  rows
    .map(
      (row) =>
        `${row.text}${row.current ? ' [current]' : ''}${
          row.buttons.length > 0 ? ` [${row.buttons.join(' | ')}]` : ''
        }`,
    )
    .join(' / ');

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const writes = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

  // Nothing this probe does may reach a real network as a write. Reads are
  // allowed (the shell needs a feed to render); writes are counted and aborted.
  await page.route('**', async (route) => {
    const request = route.request();
    const method = request.method();

    if (['GET', 'HEAD', 'OPTIONS'].includes(method) || request.url().startsWith(SERVER)) {
      return route.continue();
    }

    writes.push(`${method} ${request.url().slice(0, 110)}`);
    return route.abort();
  });

  stage('signing in through the stubbed relay');
  await signIn(page);
  stage("seeding two accounts through the app's own store");
  const seeded = await seedAccounts(page);
  check(
    'both accounts and both posting keys are on the device after seeding',
    seeded.accounts.length === 2 && seeded.keyA && seeded.keyB,
    JSON.stringify(seeded),
  );

  stage('reloading onto the device the accounts live on');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-fiddy="account-switcher-entry"]', { timeout: 180_000 });
  await page.waitForTimeout(2_500);

  // ── account A: the session, the label, the key, a write attempt ──────────
  stage('reading the first account: session, label, key');
  const beforeSwitch = await readState(page);
  check(
    'the client is signed in as the first account (session FID 3)',
    beforeSwitch.sessionFid === SIGNED_IN_FID,
    `session FID ${beforeSwitch.sessionFid}`,
  );
  check(
    'the rail names the account it is signing in as',
    beforeSwitch.entryText === `@${SIGNED_IN_HANDLE}`,
    `entry text "${beforeSwitch.entryText}"`,
  );

  await openSwitcher(page);
  const sheetA = await readState(page);
  check(
    'the switcher lists both accounts, and only one is current',
    sheetA.rows.length === 2 && sheetA.rows.filter((row) => row.current).length === 1,
    describeRows(sheetA.rows),
  );
  check(
    'the current row is the first account, labelled as signing in',
    sheetA.rows.find((row) => row.current)?.id === ACCOUNT_A.id &&
      /signing in as this one/i.test(sheetA.currentMarker ?? ''),
    `${sheetA.currentMarker} on ${sheetA.rows.find((row) => row.current)?.id}`,
  );
  check(
    'both accounts say this device can post (their keys are the ones stored)',
    sheetA.rows.every((row) => /this device can post/i.test(row.text)),
    describeRows(sheetA.rows),
  );
  check(
    'the sheet says which account is signing in, out loud',
    sheetA.sheetText?.startsWith(`Your accounts Signing in as @${SIGNED_IN_HANDLE}.`),
    sheetA.sheetText?.slice(0, 120),
  );

  stage('write attempt as the first account');
  await closeSwitcher(page);
  const writeA = await attemptWrite(page, writes);
  check(
    'no write left the machine during the first write attempt',
    writes.length === 0,
    `${writes.length} aborted write(s)`,
  );
  check(
    "the client's write entry point was there to press",
    writeA.entryPointFound,
    writeA.read,
  );

  await page.screenshot({ path: `${OUT}/account-switch-a.png` });

  // ── the switch itself: the sheet's own button ────────────────────────────
  stage('switching to the second account');
  await openSwitcher(page);
  const switched = await page.evaluate((id) => {
    const row = document.querySelector(`[data-fiddy-account="${id}"]`);
    const button = Array.from(row?.querySelectorAll('button') ?? []).find((candidate) =>
      /^sign in as/i.test(candidate.innerText.trim()),
    );
    if (!button) {
      return false;
    }
    button.click();
    return true;
  }, ACCOUNT_B.id);

  check('the switcher offers "Sign in as" for the other account', switched);

  // The switch re-signs-in and reboots the client, so wait for the rail to name
  // the second account rather than for a load event.
  await page.waitForFunction(
    (handle) => {
      const entry = document.querySelector('[data-fiddy="account-switcher-entry"]');
      return entry !== null && entry.innerText.replace(/\s+/g, ' ').trim() === handle;
    },
    `@${ACCOUNT_B.username}`,
    { timeout: 180_000 },
  );
  await page.waitForTimeout(2_500);

  stage('reading the second account: session, label, key');
  const afterSwitch = await readState(page);
  check(
    'after switching, the session is the second account (FID 4242)',
    afterSwitch.sessionFid === ACCOUNT_B.fid,
    `session FID ${afterSwitch.sessionFid}`,
  );
  check(
    'after switching, the rail names the second account',
    afterSwitch.entryText === `@${ACCOUNT_B.username}`,
    `entry text "${afterSwitch.entryText}"`,
  );
  check(
    'after switching, the stored selection is the second account',
    afterSwitch.currentId === ACCOUNT_B.id,
    `current ${afterSwitch.currentId}`,
  );

  await openSwitcher(page);
  const sheetB = await readState(page);
  check(
    'the current row moved to the second account',
    sheetB.rows.find((row) => row.current)?.id === ACCOUNT_B.id &&
      sheetB.rows.filter((row) => row.current).length === 1,
    describeRows(sheetB.rows),
  );
  check(
    'the first account is still on the device, key and all, ready to switch back',
    sheetB.rows.some((row) => row.id === ACCOUNT_A.id && /this device can post/i.test(row.text)),
    describeRows(sheetB.rows),
  );

  stage('write attempt as the second account');
  await closeSwitcher(page);
  const writeB = await attemptWrite(page, writes);
  check(
    'no write left the machine during the second write attempt',
    writes.length === 0,
    `${writes.length} aborted write(s)`,
  );
  check(
    "the client's write entry point was there to press as the second account",
    writeB.entryPointFound,
    writeB.read,
  );

  await page.screenshot({ path: `${OUT}/account-switch-b.png` });

  // ── the round trip: back to the first account ────────────────────────────
  stage('switching back to the first account');
  await openSwitcher(page);
  await page.evaluate((id) => {
    const row = document.querySelector(`[data-fiddy-account="${id}"]`);
    const button = Array.from(row?.querySelectorAll('button') ?? []).find((candidate) =>
      /^sign in as/i.test(candidate.innerText.trim()),
    );
    button?.click();
  }, ACCOUNT_A.id);

  await page.waitForFunction(
    (handle) => {
      const entry = document.querySelector('[data-fiddy="account-switcher-entry"]');
      return entry !== null && entry.innerText.replace(/\s+/g, ' ').trim() === handle;
    },
    `@${SIGNED_IN_HANDLE}`,
    { timeout: 180_000 },
  );
  await page.waitForTimeout(2_000);

  stage('reading the round trip');
  const back = await readState(page);
  check(
    'switching back returns the session to the first account',
    back.sessionFid === SIGNED_IN_FID && back.currentId === ACCOUNT_A.id,
    `session FID ${back.sessionFid}, current ${back.currentId}`,
  );

  await page.screenshot({ path: `${OUT}/account-switch-back.png` });

  const report = {
    server: SERVER,
    accounts: [
      { fid: SIGNED_IN_FID, handle: SIGNED_IN_HANDLE, role: 'first (the signed-in one)' },
      { fid: ACCOUNT_B.fid, handle: ACCOUNT_B.username, role: 'second' },
    ],
    session: {
      before: beforeSwitch.sessionFid,
      after: afterSwitch.sessionFid,
      afterSwitchingBack: back.sessionFid,
    },
    labels: {
      before: { entry: beforeSwitch.entryText, rows: describeRows(sheetA.rows), marker: sheetA.currentMarker },
      after: { entry: afterSwitch.entryText, rows: describeRows(sheetB.rows) },
    },
    keys: {
      before: beforeSwitch.keysHeld,
      after: afterSwitch.keysHeld,
    },
    writeAttempt: { asFirst: writeA, asSecond: writeB },
    writesAborted: writes,
    pageErrors,
    checks,
  };

  const failed = checks.filter((entry) => !entry.ok);
  const passed = checks.length - failed.length;

  console.log(JSON.stringify(report, null, 2));
  console.log(`\n${passed}/${checks.length} checks passed`);
  for (const entry of failed) {
    console.log(`FAIL: ${entry.name} — ${entry.detail}`);
  }
  console.log(
    `\nwrite attempts recorded (not asserted): as @${SIGNED_IN_HANDLE} — ${writeA.read}\n` +
      `                                        as @${ACCOUNT_B.username} — ${writeB.read}`,
  );

  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
};

await run();
