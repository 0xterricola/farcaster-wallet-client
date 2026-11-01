/**
 * "Sign in on a copy of Fiddy you run yourself, with a QR and no seed phrase" —
 * the whole flow, driven through the real client, with only the third parties
 * scripted.
 *
 *   node scripts/verify-instance-connect.mjs
 *
 * WHAT IS REAL AND WHAT IS SCRIPTED
 *
 * Real, and the reason this probe exists:
 *   - the app the person uses: this build, served by its own vite server, with
 *     the instance's connect service mounted at `/api/fiddy/connect` (the whole
 *     point — a copy of Fiddy answers its own approval calls);
 *   - the signature the service puts on the request it sends (`SignedKeyRequest`
 *     by the instance's own account) and the key it mints;
 *   - the write: the cast a person pressed is signed with the key that came back
 *     from the approval and submitted as a protobuf message to a node, which is
 *     then read back before anything is called posted.
 *
 * Scripted, because no worker may hold a phone or post to mainnet:
 *   - the FARCaster app on the phone (the stub Farcaster client API flips its
 *     request to `completed` when the probe decides the person approved it);
 *   - the node: an in-process HTTP stub that answers the node's own `/v1/*`
 *     JSON, keeps the key list the approval produced, and records every message
 *     submitted to it.
 *
 * This is the scripted equivalent the card asked for: QR renders, the round trip
 * completes, the client ends up with a working key, and a cast lands on the node
 * — with the bytes of that cast checked, not assumed.
 *
 * Env:
 *   INSTANCE_CONNECT_SERVER   reuse a dev server instead of spawning one (must
 *                             have been started with the env this file sets)
 *   INSTANCE_CONNECT_OUT      screenshot directory (default the system temp dir)
 *   INSTANCE_CONNECT_API_PORT / INSTANCE_CONNECT_NODE_PORT  fixed stub ports
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const OUT = process.env.INSTANCE_CONNECT_OUT ?? os.tmpdir();
const API_PORT = Number(process.env.INSTANCE_CONNECT_API_PORT ?? 5711);
const NODE_PORT = Number(process.env.INSTANCE_CONNECT_NODE_PORT ?? 5712);
const DEV_PORT = Number(process.env.INSTANCE_CONNECT_DEV_PORT ?? 5241);
const SERVER = process.env.INSTANCE_CONNECT_SERVER ?? `https://localhost:${DEV_PORT}`;

/** The instance's own Farcaster account: a throwaway, as its key must never be real here. */
const APP_FID = 3356372;
const APP_KEY = generatePrivateKey();

/** The person: a real SIWE message over a throwaway key, signed for this host. */
const NONCE = 'c'.repeat(128);
const CHANNEL_TOKEN = 'INSTANCECONNECT';
const PERSON_FID = 42137;
const PERSON_HANDLE = 'tester';
const CAST_TEXT = 'the first cast from my own box';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS,DELETE',
  'content-type': 'application/json',
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- the phone
/**
 * Farcaster's client API, as far as the instance service is concerned: it is
 * handed a request it never validates (a real `SignedKeyRequest` signature is
 * asserted in `src/__tests__/instanceConnect.test.ts`, with EIP-712 recovery)
 * and answers the polling until the probe says the person approved.
 */
const startClientApiStub = async () => {
  const state = { created: [], completed: false };
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const answer = (body, status = 200) => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };

    if (request.method === 'POST' && url.startsWith('/v2/signed-key-requests')) {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        state.created.push(body);
        answer({
          result: {
            signedKeyRequest: {
              token: '0xprobetoken',
              deeplinkUrl: 'farcaster://signed-key-request?token=0xprobetoken',
              key: body.key,
              state: 'pending',
            },
          },
        });
      });
      return;
    }

    if (url.startsWith('/v2/signed-key-request')) {
      answer({
        result: {
          signedKeyRequest: {
            token: '0xprobetoken',
            key: state.created[0]?.key ?? null,
            state: state.completed ? 'completed' : 'pending',
            ...(state.completed ? { userFid: PERSON_FID } : {}),
          },
        },
      });
      return;
    }

    answer({ message: 'not found' }, 404);
  });
  await new Promise((resolve) => server.listen(API_PORT, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${API_PORT}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

// ------------------------------------------------------------------ the node
/**
 * The node this copy of Fiddy reads and writes through, scripted.
 *
 * It answers the JSON the client asks for (and nothing invented beyond that),
 * and — the part that matters — it is where the flow is *confirmed*: the sign-in
 * asks it which FID the signing address owns, and the approval is only complete
 * once this node lists the key the phone approved.
 */
const startNodeStub = async () => {
  const state = {
    signers: [],
    submitted: [],
    reads: [],
    signInConfirmationAsked: false,
    approvedKey: null,
  };
  const signerAddress = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  ).address;

  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const [pathname] = url.split('?');
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const answer = (body, status = 200) => {
      response.statusCode = status;
      for (const [key, value] of Object.entries(CORS)) {
        response.setHeader(key, value);
      }
      response.end(JSON.stringify(body));
    };

    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      for (const [key, value] of Object.entries(CORS)) {
        response.setHeader(key, value);
      }
      response.end();
      return;
    }

    state.reads.push(`${request.method} ${pathname}`);

    if (pathname === '/v1/onChainIdRegistryEventByAddress') {
      const asked = (query.get('address') ?? '').toLowerCase();
      state.signInConfirmationAsked = state.signInConfirmationAsked || asked.length > 0;
      if (asked !== signerAddress.toLowerCase()) {
        answer({});
        return;
      }
      answer({
        fid: PERSON_FID,
        idRegisterEventBody: { to: signerAddress, type: 'ID_REGISTER_EVENT_TYPE_REGISTER' },
      });
      return;
    }

    if (pathname === '/v1/signersByFid') {
      // The node lists the key only once the approval produced it — which is
      // exactly what the service waits for before it says "connected".
      answer({
        signers: state.signers,
        gaslessSignerCount: 0,
        gaslessSignerLimit: 1000,
        currentUserNonce: 1,
      });
      return;
    }

    if (pathname === '/v1/userDataByFid') {
      answer({
        messages: [
          {
            data: {
              fid: PERSON_FID,
              type: 'MESSAGE_TYPE_USER_DATA_ADD',
              userDataBody: { type: 6, value: PERSON_HANDLE },
            },
          },
        ],
      });
      return;
    }

    if (pathname === '/v1/info') {
      // The provider ladder measures a server before it will use it, and a
      // watermark that never moves reads as a stale index (providers/health.ts).
      // So this stub reports a height that follows the clock, like a live node.
      answer({
        version: 'probe-node-1.0.0',
        numShards: 1,
        dbStats: { numMessages: 914322172, numFidRegistrations: 1, approxSize: 1 },
        shardInfos: [
          {
            shardId: 0,
            numMessages: 1,
            maxHeight: 48_000_000 + Math.floor(Date.now() / 1000),
          },
        ],
      });
      return;
    }

    if (pathname === '/v1/submitMessage') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const bytes = Buffer.concat(chunks);
        state.submitted.push(bytes);
        // The client reads its write back before calling it posted.
        state.lastHash = `0x${bytes.subarray(0, 20).toString('hex')}`;
        answer(storedCast(state.lastHash));
      });
      return;
    }

    if (pathname === '/v1/castById' || pathname === '/v1/castsByFid') {
      const hash = query.get('hash') ?? state.lastHash;
      answer(hash ? storedCast(hash) : { messages: [] });
      return;
    }

    if (pathname === '/v1/reactionsByCast' || pathname === '/v1/linksByFid') {
      answer({ messages: [] });
      return;
    }

    if (pathname === '/v1/onChainSignersByFid') {
      answer({
        events: [
          { signerEventBody: { key: '0x0', fid: PERSON_FID, eventType: 'SIGNER_EVENT_TYPE_ADD' } },
        ],
      });
      return;
    }

    // Every other node read the shell makes: an honest empty page, not an error.
    answer({ messages: [], events: [], signers: [] });
  });

  await new Promise((resolve) => server.listen(NODE_PORT, '127.0.0.1', resolve));

  const storedCast = (hash) => ({
    hash,
    signer: `0x${'11'.repeat(32)}`,
    signature: `0x${'22'.repeat(64)}`,
    signatureScheme: 'SIGNATURE_SCHEME_ED25519',
    hashScheme: 'HASH_SCHEME_BLAKE3',
    data: {
      fid: PERSON_FID,
      timestamp: 1,
      network: 'FARCASTER_NETWORK_MAINNET',
      type: 'MESSAGE_TYPE_CAST_ADD',
      castAddBody: { text: CAST_TEXT, embeds: [], mentions: [], mentionsPositions: [] },
    },
  });

  return {
    state,
    url: `http://127.0.0.1:${NODE_PORT}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

// ----------------------------------------------------------- the dev server
const startDevServer = async (env) => {
  const child = spawn(
    'node',
    [
      path.join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--config',
      path.join(here, 'probe.vite.config.mjs'),
      '--port',
      String(DEV_PORT),
      '--strictPort',
    ],
    {
      cwd: appRoot,
      env: { ...process.env, ...env, HTTPS: 'true', PROBE_VITE_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), 'probe-vite-')) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const log = [];
  child.stdout.on('data', (chunk) => log.push(String(chunk)));
  child.stderr.on('data', (chunk) => log.push(String(chunk)));

  for (let i = 0; i < 120; i += 1) {
    await sleep(1000);
    if (/ready in|Local:/.test(log.join(''))) {
      return { child, log };
    }
    if (child.exitCode !== null) {
      throw new Error(`the dev server exited: ${log.join('').slice(-400)}`);
    }
  }
  throw new Error(`the dev server never came up: ${log.join('').slice(-400)}`);
};

// ------------------------------------------------------------------- driving
const safe = async (page, fn, arg) => {
  let lastError;
  for (let i = 0; i < 20; i += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      lastError = error;
      if (
        !/Execution context was destroyed|Cannot find context|Target closed|navigating/i.test(
          String(error),
        )
      ) {
        throw error;
      }
      await sleep(250);
    }
  }
  throw lastError;
};

const surface = (page) =>
  safe(page, () => {
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
    const qr = document.querySelector('[data-fiddy="connect-qr"]');
    const link = document.querySelector('[data-fiddy="connect-approval-link"]');
    return {
      path: window.location.pathname,
      shell: Boolean(document.querySelector('.fiddy-shell-frame')),
      gate: Boolean(document.querySelector('[data-fiddy="signer-approval-gate"]')),
      // The whole page, not the first 600 characters: the sentence a check
      // looks for ("Cast stored on the node") sits at the BOTTOM of the settings
      // screen, under a nav rail and two cards, so a truncated read sees a page
      // that looks like it never posted (measured: the screenshot showed the
      // line while this read did not).
      text: text.slice(0, 8_000),
      qr: Boolean(qr),
      approvalUrl: link?.getAttribute('href') ?? null,
      sheetText: (document.querySelector('#modal-root')?.innerText ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 300),
      connected:
        /Connected as @/.test(text) || /Fiddy can post for you/.test(text),
      connectedAs: (text.match(/Connected as @[\w.-]+/) ?? [])[0] ?? null,
      posted: /cast is live|Cast posted|Your cast/i.test(text),
    };
  });

const main = async () => {
  const api = await startClientApiStub();
  const node = await startNodeStub();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'fiddy-instance-'));

  const env = {
    FIDDY_INSTANCE_APP_FID: String(APP_FID),
    FIDDY_INSTANCE_APP_KEY: APP_KEY,
    FIDDY_FC_CLIENT_API: api.url,
    FIDDY_INSTANCE_STATE_DIR: stateDir,
    FIDDY_NODE_HTTP: node.url,
    SNAPCHAIN_HTTP_URL: node.url,
    VITE_SNAPCHAIN_HTTP_URL: node.url,
    VITE_SNAPCHAIN_DEBUG: 'true',
  };

  let server;
  if (process.env.INSTANCE_CONNECT_SERVER === undefined) {
    server = await startDevServer(env);
    console.log(`dev server up on ${SERVER}`);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleLog = [];
  const connectTraffic = [];
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 240)));
  page.on('console', (message) => {
    consoleLog.push(`${message.type()}: ${message.text().replace(/\s+/g, ' ').slice(0, 160)}`);
  });
  page.on('response', (response) => {
    if (/\/api\/fiddy\/connect/.test(response.url())) {
      const entry = `${response.request().method()} ${response.status()}`;
      connectTraffic.push(entry);
      void response
        .text()
        .then((body) => {
          const index = connectTraffic.indexOf(entry);
          if (index >= 0) {
            connectTraffic[index] = `${entry} ${body.replace(/\s+/g, ' ').slice(0, 220)}`;
          }
        })
        .catch(() => undefined);
    }
  });

  // The person's signature: a real SIWE message, over a throwaway key, for this
  // host. The relay is scripted (it only carries), the node is asked to confirm.
  const account = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
  const message = createSiweMessage({
    address: account.address,
    chainId: 10,
    domain: new URL(SERVER).host,
    nonce: NONCE,
    uri: `${SERVER}/login`,
    version: '1',
    resources: [`farcaster://fid/${PERSON_FID}`],
  });
  const signature = await account.signMessage({ message });

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
        fid: PERSON_FID,
        username: PERSON_HANDLE,
        displayName: PERSON_HANDLE,
      }),
    });
  });

  try {
    // ── 1. sign in by scanning (the relay carries, this instance confirms) ──
    await page.goto(`${SERVER}/welcome/ready`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('button, a, [role=button]')].some((el) =>
          /go social/i.test(el.innerText || ''),
        ),
      { timeout: 120_000 },
    );
    for (const el of await page.$$('button, a, [role=button]')) {
      const label = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
      if (/go social/i.test(label)) {
        await el.click();
        break;
      }
    }

    let signedIn = false;
    for (let i = 0; i < 45; i += 1) {
      await sleep(1000);
      const state = await safe(page, () => ({
        path: window.location.pathname,
        shell: Boolean(document.querySelector('.fiddy-shell-frame')),
      }));
      if (state.path === '/' && state.shell) {
        signedIn = true;
        break;
      }
    }
    check('the QR sign-in lands in the client shell', signedIn);
    check(
      'the sign-in asked THIS instance’s node which FID that signature owns',
      node.state.signInConfirmationAsked,
      `node reads: ${node.state.reads.slice(0, 6).join(', ')}`,
    );

    // ── 2. press Cast with no key: the approval sheet, with a real QR ───────
    let composerOpened = false;
    for (let i = 0; i < 30 && !composerOpened; i += 1) {
      for (const button of await page.locator('button:has-text("Cast"):visible').all()) {
        if (((await button.innerText()) || '').trim() === 'Cast') {
          await button.click();
          try {
            await page.waitForSelector('#modal-root [contenteditable="true"]', {
              timeout: 8000,
            });
            composerOpened = true;
          } catch {
            /* the shell may still be painting */
          }
          break;
        }
      }
      if (!composerOpened) {
        await page.keyboard.press('n');
        composerOpened = Boolean(
          await page
            .waitForSelector('#modal-root [contenteditable="true"]', { timeout: 4000 })
            .then(() => true)
            .catch(() => false),
        );
      }
      if (!composerOpened) {
        await sleep(1000);
      }
    }
    check('the composer opens for a signed-in reader', composerOpened);

    if (composerOpened) {
      await page.locator('#modal-root [contenteditable="true"]').first().click();
      await page.keyboard.type(CAST_TEXT);
      await sleep(900);
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('#modal-root button')].find(
          (b) => ((b.innerText || '').trim() === 'Cast' && !b.disabled),
        );
        button?.click();
      });
    }

    let waiting = await surface(page);
    for (let i = 0; i < 30 && !waiting.qr; i += 1) {
      await sleep(1000);
      waiting = await surface(page);
    }
    await page.screenshot({ path: path.join(OUT, 'instance-connect-1-waiting.png') });

    check(
      'pressing Cast with no key opens the QR sheet on a copy of Fiddy run here',
      waiting.qr,
      `path=${waiting.path} text=${waiting.text.slice(0, 160)}`,
    );
    check(
      'the QR is the request THIS instance created (https, so a camera resolves it)',
      typeof waiting.approvalUrl === 'string' &&
        waiting.approvalUrl.startsWith('https://client.farcaster.xyz/deeplinks/signed-key-request?token=') &&
        typeof api.state.created[0]?.key === 'string',
      `approvalUrl=${waiting.approvalUrl}`,
    );
    check(
      'the request was signed by the instance’s own Farcaster account',
      api.state.created[0]?.requestFid === APP_FID &&
        typeof api.state.created[0]?.signature === 'string' &&
        api.state.created[0]?.signature.startsWith('0x'),
      `requestFid=${api.state.created[0]?.requestFid}`,
    );

    // ── 3. the phone approves: the waiting write must finish by itself ──────
    const approvedKey = String(api.state.created[0]?.key ?? '');
    node.state.approvedKey = approvedKey;
    node.state.signers = [
      { key: approvedKey, keyType: 1, fid: PERSON_FID, source: 'PROBE' },
    ];
    api.state.completed = true;

    // No second press: the sheet hands the carried write back to the writer the
    // moment the service says the key exists, and THAT is what proves the whole
    // flow. (With a write waiting, this screen does not show a "Connected"
    // panel at all — the caller owns what happens next — which is why the
    // assertion is the message arriving at the node, not a panel.)
    let submittedBytes = node.state.submitted[0] ?? null;
    for (let i = 0; i < 40 && submittedBytes === null; i += 1) {
      await sleep(1000);
      submittedBytes = node.state.submitted[0] ?? null;
    }
    await sleep(3000);
    await page.screenshot({ path: path.join(OUT, 'instance-connect-2-posted.png') });
    const settled = await surface(page);

    console.log('--- connect traffic ---');
    for (const line of connectTraffic.slice(-14)) {
      console.log(`    ${line}`);
    }
    console.log('--- console (last 12) ---');
    for (const line of consoleLog.slice(-12)) {
      console.log(`    ${line}`);
    }
    console.log(`--- sheet text ---\n    ${settled.sheetText}`);

    check(
      'the approval is seen by the sheet itself, with no second press',
      connectTraffic.some((line) => /GET 200 .*"state":"connected"/.test(line)),
      connectTraffic.slice(-3).join(' | '),
    );
    check(
      'the key that was approved is handed to this browser, once',
      connectTraffic.some((line) =>
        /"postingKey":"0x[0-9a-f]{64}"/.test(line),
      ),
    );
    check(
      'the approval sheet is gone, with nothing left open',
      !settled.gate,
      `sheet: ${settled.sheetText}`,
    );

    // ── 4. a cast written through YOUR OWN node, signed by that key ─────────
    //
    // The home composer goes out over whichever server the client's provider
    // ladder says is live (scripted here as Farcaster's public relay, which
    // refuses a key it has never seen — the honest answer). The surface that
    // writes through YOUR node is your own setup, and that is where the cast is
    // driven: same app, same stored key, one node fewer in the middle.
    await page.goto(`${SERVER}/~/settings/node`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    let composerReady = false;
    for (let i = 0; i < 40 && !composerReady; i += 1) {
      await sleep(1000);
      composerReady = await page
        .locator('textarea[placeholder="Say something through your own setup…"]')
        .count()
        .then((count) => count > 0)
        .catch(() => false);
    }
    check('the reader’s own setup offers its composer', composerReady);

    if (composerReady) {
      await page
        .locator('textarea[placeholder="Say something through your own setup…"]')
        .fill(CAST_TEXT);
      await sleep(400);
      await page.locator('button:has-text("Post")').first().click();
    }

    let ownNodeBytes = node.state.submitted[0] ?? null;
    for (let i = 0; i < 40 && ownNodeBytes === null; i += 1) {
      await sleep(1000);
      ownNodeBytes = node.state.submitted[0] ?? null;
    }
    await sleep(1500);
    await page.screenshot({ path: path.join(OUT, 'instance-connect-3-own-node.png') });
    const ownNode = await surface(page);

    check(
      'a cast written through the reader’s own node arrives there',
      ownNodeBytes !== null,
      `messages: ${node.state.submitted.length}, page says: ${ownNode.text.slice(0, 120)}`,
    );
    check(
      'that message carries the key the approval produced, in its signer field',
      ownNodeBytes !== null &&
        ownNodeBytes.includes(Buffer.from(approvedKey.slice(2), 'hex')),
      `key=${approvedKey.slice(0, 12)}…, bytes=${ownNodeBytes?.length ?? 0}`,
    );
    check(
      'that message is the cast the person typed',
      ownNodeBytes !== null &&
        ownNodeBytes.includes(Buffer.from(CAST_TEXT, 'utf8')),
    );
    check(
      'the client read the cast back out of that node before calling it stored',
      /Cast stored on the node/.test(ownNode.text),
      `page says: ${ownNode.text.slice(0, 200)}`,
    );

    check(
      'no uncaught page error',
      pageErrors.filter((error) => !/HandledFetchError/.test(error)).length === 0,
      pageErrors.slice(0, 2).join(' | '),
    );
  } finally {
    await context.close();
    await browser.close();
    await api.close();
    await node.close();
    if (server) {
      server.child.kill('SIGTERM');
    }
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log(`failed:\n${failed.map((entry) => `  - ${entry.name}`).join('\n')}`);
    process.exitCode = 1;
  }
};

await main();