#!/usr/bin/env node
/**
 * The bloat guard for the Mask-pattern work: what this card cost, and what it
 * must never cost.
 *
 * Run it from `apps/farcaster-web` after `pnpm build`:
 *
 *     node scripts/verify-mask-surfaces.mjs --report    # numbers + checks
 *     node scripts/verify-mask-surfaces.mjs --visual    # + a browser at 390/1440
 *
 * What it checks, and why each one is here:
 *
 * 1. **The on-demand rule.** The sealed-cast crypto (`lib/sealed/*`) and the
 *    price lookup (`lib/tokens/price`) must not be inside the main entry chunk.
 *    They are `import()`ed from surfaces, so a reader who never meets a sealed
 *    cast or a cashtag pays nothing — this asserts it from the built bytes rather
 *    than from the source.
 * 2. **The main bundle's growth.** The entry chunk may not grow more than the
 *    card's own ceiling (100 KB) against a recorded baseline, and the report
 *    prints both numbers.
 * 3. **Dead code.** Every export of the new modules must be referenced by
 *    production code (the knip-equivalent check this card asked for, scoped to
 *    the modules it added).
 * 4. **Plaintext never leaves the device.** No module on the sealing path
 *    contains `fetch(`, `XMLHttpRequest`, `sendBeacon` or a URL, so there is no
 *    code path that could transmit a message. The rendering path is allowed to
 *    fetch (a price), the sealing path is not.
 * 5. **The surfaces render.** With `--visual`, a browser opens `~/sealed` at
 *    390px and 1440px and drives it for real (make a key, seal a message for a
 *    key the page itself generates, read the preview back). The cashtag chip's
 *    *feed* rendering is deliberately not in that probe: a built client with no
 *    signed-in session and no node has no feed to render, so the chip is covered
 *    by its own tests and by the chunk guards above instead of by a claim.
 * 6. **The chip ships styled.** The rules for `.fiddy-cashtag` must be in a
 *    stylesheet the entry page actually loads — a chip whose stylesheet only
 *    arrives with a sealed cast is an unstyled chip in every other feed.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '../..');
const assetsDir = join(appRoot, 'dist', 'assets');
/* The pre-change measurement, committed once; the current run is written beside
   it. Keeping them apart is what makes "it grew by N bytes" a fact rather than a
   number that resets every time this script runs. */
const baselinePath = join(
  repoRoot,
  'docs',
  'evidence',
  'mask-bundle-baseline.json',
);
const reportPath = join(repoRoot, 'docs', 'evidence', 'mask-bundle-report.json');

const MAIN_BUNDLE_CEILING_BYTES = 100 * 1024;

const args = process.argv.slice(2);
const wantVisual = args.includes('--visual');
const wantReport = args.includes('--report') || !wantVisual;

const problems = [];
const notes = [];

const fail = (text) => problems.push(text);
const note = (text) => notes.push(text);

const jsFiles = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));

const sizes = new Map(
  jsFiles.map((name) => [name, statSync(join(assetsDir, name)).size]),
);

const totalBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);

/* The entry chunk is the one the HTML shell loads: find it rather than guess. */
const indexHtml = readFileSync(join(appRoot, 'dist', 'index.html'), 'utf8');
const entryName = [...indexHtml.matchAll(/assets\/([A-Za-z0-9._-]+\.js)/g)]
  .map((match) => match[1])
  .find((name) => (sizes.get(name) ?? 0) > 500_000);

if (entryName === undefined) {
  fail('could not find the entry chunk in dist/index.html');
}

const entryBytes = entryName === undefined ? 0 : (sizes.get(entryName) ?? 0);

/* ---------------------------------------------------------------- 1. on-demand */

const readModule = (relative) => readFileSync(join(appRoot, relative), 'utf8');

const chunkHolding = (needle) => {
  const found = [];

  for (const [name, size] of sizes) {
    const text = readFileSync(join(assetsDir, name), 'utf8');

    if (text.includes(needle)) {
      found.push({ name, size });
    }
  }

  return found;
};

/* Strings only the *crypto* has. The `fdy-seal-1:` prefix is deliberately NOT
   here: the cast renderer itself must recognise a sealed body, so the prefix and
   the detector live in the entry chunk on purpose (`lib/sealed/markers.ts`, a few
   hundred bytes). What must never be in the entry is the sealing code. */
const sealedMarkers = [
  'fiddy-sealed-cast-v1',
  'this sealed cast was written by version',
  'a sealed cast names between 1 and 8 people',
  'it was sealed to a different key with the same fingerprint',
];

const priceMarkers = ['api.dexscreener.com', 'no market was found for'];

/* livekit-client is the audio-room transport. It must be reachable only through
   the lazily-loaded Space provider — a static import from the right rail's
   "live now" card put the whole WebRTC client in the entry chunk once already
   (MEASURED 2026-10-22), which is exactly what this catches. */
const livekitMarkers = ['livekit-pc-transport', 'livekit-dummy-audio-el'];

/* ------------------------------------------------------------------ 1b. faker */

/* faker's locale corpus is the single largest thing that used to sit in this
   entry chunk (3.6 MB of source), dragged in by `@farcaster/core`'s top-level
   `import { faker }` for message factories this client never calls. The alias
   that answers it is `config/fakerInterop.mjs`, and these markers are strings
   only that corpus carries — an animal breed and a song title from its own
   locale data — so this fails the moment the corpus is bundled again. */
const fakerMarkers = ['Abyssinian Shorthorned Zebu', 'A Whole New World (Aladdin'];

const fakerInEntry = fakerMarkers.filter((marker) =>
  readFileSync(join(assetsDir, entryName), 'utf8').includes(marker),
);

if (fakerInEntry.length > 0) {
  fail(
    `faker's locale corpus is inside the main entry chunk (${entryName}) — "${fakerInEntry[0]}" was found there (see config/fakerInterop.mjs)`,
  );
} else {
  note(
    `faker's locale corpus is not in the entry chunk (${fakerMarkers.length} markers checked)`,
  );
}

for (const [label, markers] of [
  ['the sealed-cast crypto', sealedMarkers],
  ['the price lookup', priceMarkers],
  ['the audio-room transport', livekitMarkers],
]) {
  const holderNames = new Set();

  for (const marker of markers) {
    const holders = chunkHolding(marker);

    if (holders.length === 0) {
      note(
        `"${marker}" (${label}) is in no chunk at all — either the build did not run or the marker is stale`,
      );
      continue;
    }

    for (const holder of holders) {
      holderNames.add(`${holder.name} (${holder.size})`);
    }

    const inEntry = holders.find((holder) => holder.name === entryName);

    if (inEntry !== undefined) {
      fail(
        `${label} is inside the main entry chunk (${entryName}) — "${marker}" was found there`,
      );
    }
  }

  note(`${label} lives in: ${[...holderNames].join(', ') || 'nowhere'}`);
}

/* ------------------------------------------------------------------ 2. bundle size */

let baseline = null;

if (statSync(baselinePath, { throwIfNoEntry: false }) !== undefined) {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
}

if (baseline !== null && typeof baseline.entryBytes === 'number') {
  const growth = entryBytes - baseline.entryBytes;

  note(
    `main bundle: ${baseline.entryBytes} → ${entryBytes} bytes (${growth >= 0 ? '+' : ''}${growth}), ceiling ${MAIN_BUNDLE_CEILING_BYTES}`,
  );

  if (growth > MAIN_BUNDLE_CEILING_BYTES) {
    fail(
      `the main bundle grew ${growth} bytes, over the ${MAIN_BUNDLE_CEILING_BYTES}-byte ceiling`,
    );
  }
} else {
  note(`no baseline at ${baselinePath}: writing this run as the baseline`);
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        entryFile: entryName,
        entryBytes,
        totalBytes,
        chunks: sizes.size,
      },
      null,
      1,
    )}\n`,
  );
}

/* ---------------------------------------------------------------------- 3. dead code */

const sourceFiles = [];
const testFiles = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        continue;
      }

      if (entry.name === '__tests__') {
        walkTests(path);
        continue;
      }

      walk(path);
      continue;
    }

    if (/\.(ts|tsx)$/.test(entry.name)) {
      sourceFiles.push(path);
    }
  }
};

const walkTests = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      walkTests(path);
      continue;
    }

    if (/\.(ts|tsx)$/.test(entry.name)) {
      testFiles.push(path);
    }
  }
};

walk(join(appRoot, 'src'));

/* An export used only by the tests that pin it is not dead code — that is the
   same rule knip applies, where test files are entry points. */

const productionSources = sourceFiles.map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}));

const testSources = testFiles.map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}));

const newModules = [
  'src/lib/sealed/errors.ts',
  'src/lib/sealed/encoding.ts',
  'src/lib/sealed/p256.ts',
  'src/lib/sealed/markers.ts',
  'src/lib/sealed/envelope.ts',
  'src/lib/sealed/keys.ts',
  'src/lib/sealed/sealedCast.ts',
  'src/lib/tokens/price.ts',
  'src/components/casts/CashtagChip.tsx',
  'src/components/sealed/SealedCastView.tsx',
  'src/components/sealed/SealedKeyNotice.tsx',
  'src/components/sealed/sealedModules.ts',
  'src/pages/sealed/SealedCastsPage.tsx',
];

const unusedExports = [];

const declares = (text, name) =>
  new RegExp(`^export (?:const|class|type|interface|function) ${name}\\b`, 'm').test(
    text,
  );

for (const relative of newModules) {
  const text = readModule(relative);
  const names = [
    ...text.matchAll(/^export (?:const|class|type|interface|function) ([A-Za-z0-9_]+)/gm),
  ].map((match) => match[1]);

  for (const name of names) {
    if (name === undefined) {
      continue;
    }

    const used = [...productionSources, ...testSources].some((source) => {
      if (source.text === text) {
        return false;
      }

      if (declares(source.text, name)) {
        /* Another module declares the same name: not evidence of use. */
        return false;
      }

      return new RegExp(`\\b${name}\\b`).test(source.text);
    });

    /* An export that only its own module uses is fine; an export nothing at all
       uses is the dead code this check is for. */
    const usedInsideItself =
      text.split(new RegExp(`\\b${name}\\b`)).length > 2;

    if (!used && !usedInsideItself) {
      unusedExports.push(`${relative}: ${name}`);
    }
  }
}

if (unusedExports.length > 0) {
  for (const entry of unusedExports) {
    fail(`dead export — no production code and no test uses it: ${entry}`);
  }
} else {
  note('no dead exports: every export of the new modules is used by src/');
}

/* ------------------------------------------------- 4. plaintext never leaves the device */

const sealingPath = [
  'src/lib/sealed/encoding.ts',
  'src/lib/sealed/errors.ts',
  'src/lib/sealed/p256.ts',
  'src/lib/sealed/markers.ts',
  'src/lib/sealed/envelope.ts',
  'src/lib/sealed/keys.ts',
  'src/lib/sealed/sealedCast.ts',
];

const networkPatterns = [
  ['fetch(', /(?<![A-Za-z0-9_])fetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['sendBeacon', /sendBeacon/],
  ['a URL', /https?:\/\//],
  ['WebSocket', /new WebSocket/],
];

for (const relative of sealingPath) {
  const text = readModule(relative);

  for (const [label, pattern] of networkPatterns) {
    if (pattern.test(text)) {
      fail(`${relative} contains ${label} — nothing on the sealing path may send`);
    }
  }
}

note('the sealing path contains no fetch, no XHR, no beacon, no URL at all');

/* ------------------------------------- 5. the chip ships styled, not just rendered */

/* A chip's markup without its rules is plain text with an inline-flex promise.
   The stylesheet it needs must be one the entry page actually loads — not a chunk
   that only arrives when a sealed cast is on screen. */
const loadedStylesheets = [
  ...readFileSync(join(appRoot, 'dist', 'index.html'), 'utf8').matchAll(
    /assets\/([A-Za-z0-9._-]+\.css)/g,
  ),
].map((match) => match[1]);

const cssHoldingChipRules = loadedStylesheets
  .map((name) => ({
    name,
    text: readFileSync(join(assetsDir, name), 'utf8'),
  }))
  /* Minified CSS writes `.fiddy-cashtag{` with no space, so match the rule
     rather than literally formatting it the way the source file reads. */
  .filter((sheet) => /\.fiddy-cashtag\s*\{/.test(sheet.text));

if (cssHoldingChipRules.length === 0) {
  fail(
    `the cashtag chip's rules are in none of the stylesheets the entry page loads (${loadedStylesheets.join(', ') || 'none'}) — a chip in a feed would render unstyled`,
  );
} else {
  note(
    `the cashtag chip's rules are in ${cssHoldingChipRules.map((sheet) => sheet.name).join(', ')}, which the entry page loads`,
  );
}

/* ------------------------------------------------------------------------ report */

const report = {
  measuredAt: new Date().toISOString(),
  entryFile: entryName,
  entryBytes,
  baselineEntryBytes: baseline?.entryBytes ?? null,
  entryGrowthBytes:
    baseline?.entryBytes === undefined ? null : entryBytes - baseline.entryBytes,
  ceilingBytes: MAIN_BUNDLE_CEILING_BYTES,
  totalBytes,
  chunks: sizes.size,
  largestChunks: [...sizes.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([name, size]) => ({ name, size })),
};

if (wantReport) {
  console.log('\nMASK SURFACES — bundle and code guards');
  console.log('='.repeat(60));
  console.log(
    `main entry      ${entryName} — ${entryBytes} bytes (baseline ${baseline?.entryBytes ?? 'n/a'})`,
  );
  console.log(`all JS chunks   ${totalBytes} bytes across ${sizes.size} chunks`);
  console.log(
    `largest chunks  ${report.largestChunks.map((chunk) => `${chunk.name} ${chunk.size}`).join(', ')}`,
  );
  console.log('-'.repeat(60));

  for (const text of notes) {
    console.log(`note   ${text}`);
  }

  for (const text of problems) {
    console.log(`FAIL   ${text}`);
  }

  console.log('-'.repeat(60));
  console.log(
    problems.length === 0
      ? 'OK — every guard passed.'
      : `${problems.length} guard(s) failed.`,
  );
}

writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`);

/* ------------------------------------------------------------------------ visual */

if (wantVisual) {
  const { chromium } = await import('playwright');

  const { spawn } = await import('node:child_process');
  const port = 4179;
  /* `vite preview` serves the same self-signed certificate the dev server does
     (the repo runs with basicSsl), so the readiness check below has to accept it
     — the browser side does the same through `ignoreHTTPSErrors`. */
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const baseUrl = `https://127.0.0.1:${port}`;
  const server = spawn(
    'npx',
    ['vite', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: appRoot, stdio: 'ignore' },
  );

  const waitForServer = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/`);

        if (response.ok) {
          return true;
        }
      } catch {
        /* not up yet */
      }

      await delay(500);
    }

    return false;
  };

  try {
    if (!(await waitForServer())) {
      fail('the preview server never answered');
    } else {
      /* The repo's own probes drive the installed Chrome (`channel: 'chrome'`)
         with certificate errors ignored, because the preview serves a
         self-signed certificate — same launch options as
         `scripts/verify-node-backed-client.mjs`. */
      const browser = await chromium.launch({
        channel: 'chrome',
        ignoreHTTPSErrors: true,
        args: ['--ignore-certificate-errors'],
      });
      const results = [];

      for (const width of [390, 1440]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();

        /* The client's own paths are prefixed with `~` (`routePrefixes.ts`), so
           the route is `/~/sealed`; `/sealed` is a username route. */
        await page.goto(`${baseUrl}/~/sealed`, {
          waitUntil: 'domcontentloaded',
        });

        await page.waitForSelector('[data-sealed="page"]', { timeout: 30_000 });

        /* Drive the real surface: make a key, seal for a key the page itself
           generates, and check the preview a reader will see. */
        await page.click('[data-sealed="make-key"]');
        await page.waitForSelector('[data-sealed="share"]', { timeout: 20_000 });

        const recipientShare = await page.evaluate(async () => {
          const alphabet =
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
          const keyPair = await globalThis.crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            ['deriveBits'],
          );
          const raw = new Uint8Array(
            await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey),
          );
          let encoded = '';

          for (let index = 0; index < raw.length; index += 3) {
            const first = raw[index] ?? 0;
            const second = raw[index + 1];
            const third = raw[index + 2];

            encoded += alphabet[first >> 2];
            encoded += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];

            if (second === undefined) break;

            encoded += alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];

            if (third === undefined) break;

            encoded += alphabet[third & 63];
          }

          return `fdy-key-1:${encoded}`;
        });

        await page.fill('[data-sealed="recipient"]', recipientShare);
        await page.fill('[data-sealed="message"]', 'meet me at the pier at six');
        await page.click('[data-sealed="seal"]');
        await page.waitForSelector('[data-sealed="open"]', { timeout: 20_000 });

        const seen = await page.evaluate(() => {
          const text = (selector) =>
            document.querySelector(selector)?.textContent?.trim() ?? null;

          return {
            title: text('.fiddy-page-title'),
            share: text('[data-sealed="share"]'),
            budget: text('[data-sealed="room"]'),
            recipientField:
              document.querySelector('[data-sealed="recipient"]') !== null,
            sealButton: text('[data-sealed="seal"]'),
            previewState:
              document
                .querySelector('[data-sealed="open"]')
                ?.getAttribute('data-sealed') ?? null,
            previewPlaintext: text('[data-sealed="plaintext"]'),
            sealedBytes: text('[data-sealed="result"]'),
            overflow:
              document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });

        results.push({ width, ...seen });

        await page.screenshot({
          path: join(
            repoRoot,
            'docs',
            'evidence',
            `mask-surfaces-${width}.png`,
          ),
          fullPage: true,
        });

        await context.close();
      }

      await browser.close();

      for (const result of results) {
        console.log(
          `visual  ${result.width}px: title=${JSON.stringify(result.title)} budget=${JSON.stringify(result.budget)} recipient=${result.recipientField} preview=${JSON.stringify(result.previewState)} plaintext=${JSON.stringify(result.previewPlaintext)} overflow=${result.overflow}`,
        );

        if (result.title === null) {
          fail(`${result.width}px: the sealed-casts screen did not render`);
        }

        if (result.share === null || !result.share.startsWith('fdy-key-1:')) {
          fail(`${result.width}px: making a key did not produce a share string`);
        }

        if (result.budget === null || !/bytes of room left/.test(result.budget)) {
          fail(`${result.width}px: the byte budget is not shown`);
        }

        if (!result.recipientField) {
          fail(`${result.width}px: the recipient field is missing`);
        }

        if (result.previewState === null) {
          fail(`${result.width}px: sealing did not produce a preview card`);
        }

        if (
          result.previewPlaintext === null ||
          !result.previewPlaintext.includes('meet me at the pier')
        ) {
          fail(
            `${result.width}px: the preview does not show the sealed message`,
          );
        }

        if (result.overflow) {
          fail(`${result.width}px: the page scrolls sideways`);
        }
      }
    }
  } finally {
    server.kill('SIGTERM');
  }
}

process.exit(problems.length === 0 ? 0 : 1);