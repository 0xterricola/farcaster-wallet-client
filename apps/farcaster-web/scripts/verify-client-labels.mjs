/**
 * Does a live feed really say which app made each cast — and does it say the
 * TRUTH?
 *
 * Run it against the live site, signed out, with no configuration:
 *
 *   node apps/farcaster-web/scripts/verify-client-labels.mjs
 *
 * The label itself is one thing to check (`via <app>` on each cast card); that
 * it names the app the protocol really recorded is another, and it is the one
 * that matters — a label that is plausible but wrong is worse than no label.
 * So for every card it finds, this probe walks the protocol backwards from the
 * cast:
 *
 *   card → the cast's own link (author handle + hash)
 *        → `userNameProofByName`        the handle's FID
 *        → `castById`                   the message, and the signing key
 *        → `signer`                     that key's signed key request
 *        → `userDataByFid(requestFid)`  what that app calls itself
 *
 * and compares the app the protocol named with the app the page printed.
 *
 * WHY IT RUNS SIGNED OUT: the browse surfaces (`/feed`, `/explore`) are read
 * with no account (`publicFeedWindow`), through the same node-backed read path
 * the signed-in feed uses. A worker must not mint a session, so this is the
 * half of the feature that can be measured in production; the filter half is
 * covered by the repo's own tests (`feedClientAttribution.test.ts`, 390 and
 * 1440 in the browser) plus the settings screen.
 *
 *   LIVE_CLIENT_LABEL_ORIGIN   default https://fiddy.fun
 *   LIVE_CLIENT_LABEL_NODE     default https://haatz.quilibrium.com
 *   CLIENT_LABEL_SHOT_DIR      default the system temp dir
 *   CLIENT_LABEL_PATHS         default /explore,/feed
 *   CLIENT_LABEL_SAMPLE        casts traced back through the protocol (default 6)
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

const ORIGIN = process.env.LIVE_CLIENT_LABEL_ORIGIN ?? 'https://fiddy.fun';
const NODE =
  process.env.LIVE_CLIENT_LABEL_NODE ?? 'https://haatz.quilibrium.com';
const SHOT_DIR =
  process.env.CLIENT_LABEL_SHOT_DIR ?? join(tmpdir(), 'fiddy-client-labels');
const PATHS = (process.env.CLIENT_LABEL_PATHS ?? '/explore,/feed')
  .split(',')
  .map((path) => path.trim())
  .filter((path) => path.length > 0);

/** This client's own app FID: a cast it made says "Fiddy", its app account's own name. */
const THIS_CLIENT_APP_FID = 3356372;

const WIDTHS = [390, 1440];
const CASTS_TO_CHECK = Number(process.env.CLIENT_LABEL_SAMPLE ?? 6);

let failures = 0;
let checks = 0;

const check = (ok, what, detail = '') => {
  checks += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    failures += 1;
  }
  return ok;
};

// ── the protocol, read backwards ───────────────────────────────────────────

const nodeJson = async (path, params) => {
  const url = new URL(path, NODE);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}`);
  }
  return response.json();
};

const userNameProofByName = async (name) => {
  try {
    const proof = await nodeJson('/v1/userNameProofByName', { name });
    return typeof proof?.fid === 'number' ? proof.fid : undefined;
  } catch {
    return undefined;
  }
};

const castSignerOf = async (fid, hash) => {
  try {
    const answer = await nodeJson('/v1/castById', { fid, hash });
    // The node answers a cast at the TOP level (`{data, hash, signer}`); some
    // servers wrap it in `message`. Both are read.
    const signer = answer?.message?.signer ?? answer?.signer;
    return typeof signer === 'string' && signer.length > 0 ? signer : undefined;
  } catch {
    return undefined;
  }
};

/** The app FID a signed key request records, from either half of the protocol. */
const appFidOfSigner = async (fid, signerKey) => {
  try {
    const answer = await nodeJson('/v1/signer', { fid, signer: signerKey });
    const record = answer?.signer ?? answer;
    if (typeof record?.requestFid === 'number' && record.requestFid > 0) {
      return record.requestFid;
    }
    // An on-chain key carries it ABI-encoded instead, under the signer event
    // (measured against the live node: `onChainEvent.signerEventBody.metadata`,
    // `metadataType` 1 = signed key request). Some servers put it at the top
    // level; both are read.
    const metadata =
      record?.metadata ?? record?.onChainEvent?.signerEventBody?.metadata;
    return appFidFromMetadata(metadata);
  } catch {
    return undefined;
  }
};

/**
 * `abi.encode(SignedKeyRequestMetadata)` → requestFid.
 *
 * The on-chain half of the protocol carries the app FID here rather than as a
 * field, and the encoding is shape-unstable: word 0 is sometimes the tuple's
 * offset, sometimes the FID itself. Both are handled, and anything unreadable
 * answers `undefined` rather than a guess.
 */
const appFidFromMetadata = (metadata) => {
  if (typeof metadata !== 'string' || metadata.trim().length === 0) {
    return undefined;
  }
  const trimmed = metadata.trim();
  let bytes;
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    bytes = Buffer.from(trimmed.slice(2), 'hex');
  } else {
    bytes = Buffer.from(trimmed, 'base64');
  }
  if (bytes.length < 64) {
    return undefined;
  }
  /** A 32-byte word as a Number, or undefined when it cannot be a small value. */
  const wordAt = (index) => {
    const start = index * 32;
    if (start + 32 > bytes.length) {
      return undefined;
    }
    let value = 0n;
    for (const byte of bytes.subarray(start, start + 32)) {
      value = value * 256n + BigInt(byte);
    }
    // A FID fits in 32 bits; anything larger is an address or a signature.
    return value <= 0xffff_ffffn ? Number(value) : undefined;
  };

  const first = wordAt(0);
  const tupleStart =
    first !== undefined && first > 0 && first <= 4096 && first % 32 === 0
      ? first / 32
      : 0;
  const requestFid = wordAt(tupleStart);
  return requestFid !== undefined && requestFid > 0 ? requestFid : undefined;
};

const appNameOf = async (appFid) => {
  try {
    const page = await nodeJson('/v1/userDataByFid', {
      fid: appFid,
      pageSize: 32,
    });
    let username;
    let displayName;
    for (const message of page?.messages ?? []) {
      const body = message?.data?.userDataBody;
      if (body?.type === 'USER_DATA_TYPE_USERNAME' && body.value) {
        username = body.value;
      }
      if (body?.type === 'USER_DATA_TYPE_DISPLAY' && body.value) {
        displayName = body.value;
      }
    }
    return { username, displayName };
  } catch {
    return {};
  }
};

// ── the page ───────────────────────────────────────────────────────────────

/**
 * Every labelled cast card on the page, with the cast it belongs to.
 *
 * The label sits on the author line, next to the cast's own links, so the card
 * is the nearest ancestor that holds one of them. Walked up rather than matched
 * with a selector: the markup between the two is a component's business, and a
 * probe that hard-codes it breaks on a layout change rather than on a behaviour
 * change.
 *
 * The link shapes the live client draws (measured 2026-08 on fiddy.fun):
 *   author    `/<handle>?castHash=0x…`   (and `/u/<handle>` for a reserved name)
 *   thread    `/~/conversations/0x…`     (the hash, even when the author's own
 *                                         link is the vanity form)
 */
const labelsOnPage = () => {
  const CAST_LINK = /^\/([^/?#]+)\?castHash=(0x[0-9a-fA-F]{40})$/;
  const CAST_PATH = /^\/([^/?#]+)\/(0x[0-9a-fA-F]{40})$/;
  const THREAD_LINK = /^\/~\/(?:conversations|casts)\/(0x[0-9a-fA-F]{40})$/;
  const PROFILE_LINK = /^\/([^/?#]+)(?:\?|$)/;
  const NOT_A_HANDLE = new Set([
    'u',
    'feed',
    'explore',
    'settings',
    'welcome',
    'start',
    'client',
    'api',
    'unfurl',
    '~',
  ]);

  const handleFrom = (href) => {
    const match = PROFILE_LINK.exec(href);
    if (!match) {
      return '';
    }
    const name = match[1];
    return NOT_A_HANDLE.has(name) || name.startsWith('~') ? '' : name;
  };

  const cards = Array.from(
    document.querySelectorAll('[data-fiddy="cast-client-label"]'),
  ).map((label) => {
    let node = label;
    let handle = '';
    let hash = '';
    for (let level = 0; level < 12 && node; level += 1) {
      node = node.parentElement;
      if (!node) {
        break;
      }
      for (const link of node.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href') ?? '';
        const withHash = CAST_LINK.exec(href);
        const pathHash = CAST_PATH.exec(href);
        const thread = THREAD_LINK.exec(href);
        if (withHash && !hash) {
          hash = withHash[2];
          handle = handle || withHash[1];
        } else if (pathHash && !hash) {
          hash = pathHash[2];
          handle = handle || pathHash[1];
        } else if (thread && !hash) {
          hash = thread[1];
        } else if (!handle && handleFrom(href)) {
          handle = handleFrom(href);
        }
      }
      if (hash && handle) {
        break;
      }
    }
    return { label: (label.textContent ?? '').trim(), handle, hash };
  });

  return {
    labels: cards,
    castCards: document.querySelectorAll('a[href*="/~/conversations/"]').length,
  };
};

const run = async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`live client labels: ${ORIGIN} (node ${NODE})`);
  const browser = await chromium.launch({ headless: true });
  const collected = [];

  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    for (const path of PATHS) {
      const url = `${ORIGIN}${path}`;
      console.log(`\n${path} at ${width}px`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      } catch (error) {
        check(false, 'the page loads', `${url} — ${String(error).slice(0, 120)}`);
        continue;
      }

      // A public feed paints its casts as it reads them, so wait for a label
      // rather than for a fixed time: a slow read must not read as absence.
      try {
        await page.waitForSelector('[data-fiddy="cast-client-label"]', {
          timeout: 45_000,
        });
      } catch {
        // Reported below, with the count as the evidence.
      }

      const found = await page
        .locator('[data-fiddy="cast-client-label"]')
        .count();
      const shot = join(
        SHOT_DIR,
        `${path.replace(/\W+/g, '_') || 'root'}-${width}.png`,
      );
      await page.screenshot({ path: shot, fullPage: false });

      const shown = await page.evaluate(labelsOnPage);

      // A page with no casts at all cannot answer the question this probe asks,
      // so it is its own failing check rather than reading as "no labels yet".
      const castCards = check(
        shown.castCards > 0,
        'the page really shows casts',
        `${shown.castCards} cast card(s) at ${width}px`,
      );
      check(
        found > 0,
        'casts carry an app label',
        `${found} label(s) of ${shown.castCards} cast(s) at ${width}px`,
      );
      if (!castCards) {
        console.log(`  note screenshot ${shot}`);
        continue;
      }

      for (const entry of shown.labels) {
        check(
          /^via\s+\S/.test(entry.label),
          'a label reads "via <app>"',
          JSON.stringify(entry.label),
        );
      }
      collected.push(
        ...shown.labels.map((entry) => ({ ...entry, width, path })),
      );
      console.log(
        `  note labels: ${shown.labels.map((entry) => entry.label).join(', ') || '(none)'}; screenshot ${shot}`,
      );
    }

    await context.close();
  }

  await browser.close();

  // ── the truth half: does each label name the app the protocol recorded? ──

  console.log('\nthe protocol behind the labels');
  const sample = collected
    .filter((entry) => entry.handle.length > 0 && entry.hash.length > 0)
    .slice(0, CASTS_TO_CHECK);

  if (sample.length === 0) {
    check(
      false,
      'at least one labelled cast could be traced back through the protocol',
      `${collected.length} label(s) seen, none with a cast link`,
    );
  }

  for (const entry of sample) {
    const said = entry.label.replace(/^via\s+/, '').trim();
    const where = `@${entry.handle} ${entry.hash.slice(0, 10)}…`;

    const fid = await userNameProofByName(entry.handle);
    if (fid === undefined) {
      check(false, `${where} resolves on the node`, 'no name proof for that handle');
      continue;
    }
    const signerKey = await castSignerOf(fid, entry.hash);
    if (signerKey === undefined) {
      check(false, `${where} reads back from the node`, 'the node has no such cast');
      continue;
    }
    const appFid = await appFidOfSigner(fid, signerKey);
    if (appFid === undefined) {
      // An on-chain key whose metadata names no app: the page's honest answer is
      // not a vendor name. Only a placeholder is acceptable here.
      check(
        /^(app \d+|onchain|an on-chain key|their own key)$/i.test(said) ||
          said.length === 0,
        `${where} — the key names no app, so the page names none`,
        `page said ${JSON.stringify(said)}`,
      );
      continue;
    }

    if (appFid === fid) {
      // The account asked for the key itself. There is no app to name, and the
      // failure this catches is the one measured on live: the page naming the
      // AUTHOR's own profile (fid 7237's "Thomas") as if it were a client.
      check(
        /^(their own key|own)$/i.test(said),
        `${where} — the account asked for its own key, so no app is named`,
        `app fid ${appFid} is the author; page said ${JSON.stringify(said)}`,
      );
      continue;
    }

    if (appFid === THIS_CLIENT_APP_FID) {
      check(
        said === 'Fiddy',
        `${where} was posted through this client`,
        `app fid ${appFid}; page said ${JSON.stringify(said)}`,
      );
      continue;
    }

    const name = await appNameOf(appFid);
    const expected = name.displayName || name.username;
    if (expected === undefined) {
      check(
        said === `app ${appFid}`,
        `${where} — app fid ${appFid} has no profile of its own`,
        `page said ${JSON.stringify(said)}`,
      );
      continue;
    }
    check(
      said === expected || said === name.username,
      `${where} was posted through ${expected}`,
      `app fid ${appFid}; page said ${JSON.stringify(said)}`,
    );
  }

  console.log(`\nchecks: ${checks}, failures: ${failures}`);
  return failures === 0 ? 0 : 1;
};

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });