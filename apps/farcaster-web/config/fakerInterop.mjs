/**
 * `@faker-js/faker`, answered inside this app's bundle without its corpus.
 *
 * WHY THIS EXISTS (MEASURED, 2026-10-22)
 *
 * `@farcaster/core`'s ESM build is ONE file with a bare top-level
 * `import { faker } from "@faker-js/faker"`, and the only thing it uses faker
 * for is its message FACTORIES — `makeCastAdd`, `makeMessage` and friends, the
 * test-data builders nobody ships. Because that import is static and faker
 * declares no side effects, every consumer of `@farcaster/core` carries faker's
 * whole locale corpus: 3.6 MB of source, the single largest contributor to this
 * client's 8.0 MB entry chunk (see the `faker` guard in
 * `scripts/verify-mask-surfaces.mjs`, and the entry measurement in
 * `docs/evidence/`).
 *
 * `farcaster-node-client` — the only reason this app depends on
 * `@farcaster/core` at all — uses its message decoding, signing and key
 * derivation, and never one of its factories. Nothing in this app or in the
 * packages imports faker for its data.
 *
 * WHY IT ANSWERS THE CALLS CORE MAKES INSTEAD OF THROWING ON ALL OF THEM
 * (MEASURED, 2026-10-22 — this is what kept fiddy.fun off the air for cold
 * visitors)
 *
 * `@farcaster/core`'s dist does not only *define* its factories: it BUILDS some
 * at MODULE SCOPE, so merely evaluating that module runs faker —
 *
 *   VerificationRemoveDataFactory = MessageDataFactory.params({
 *     verificationRemoveBody: VerificationRemoveBodyFactory.build({ protocol: 0 }), type: 8 });
 *   MessageFactory.params({ data: VerificationRemoveDataFactory.build(), signatureScheme: 1 });
 *
 * — and the generators behind those builds call `faker.datatype.number`,
 * `faker.helpers.arrayElement`, `faker.internet.url`, `faker.random.alphaNumeric`,
 * `faker.lorem.sentence`, `faker.date.between`. A stub that throws from every
 * call therefore throws while `@farcaster/core` is being imported: the entry
 * chunk dies mid-evaluation, every route sits on the shell's "Loading Fiddy…"
 * fallback, and the only symptom is a single pageerror naming this file
 * (reproduced on the live origin 2026-10-22 16:59, stack inside
 * `/assets/index-rLVff1tk.js`). With the real faker those module-scope builds
 * are harmless: they make throwaway test data that nothing reads.
 *
 * SO: the small surface that module touches — enumerated from the dist with
 * `grep -o 'faker\.[A-Za-z0-9_.]*'` — is answered with throwaway, corpus-free
 * values (`CALLS` below). Anything else still throws, loudly and by name, so an
 * app call site that reaches for the real package is loud rather than silent,
 * and a factory that quietly returned `undefined` would still be caught.
 *
 * The alias lives in `vite.config.js` (build and dev server). `vitest.config.js`
 * is a separate config, so a test that ever wants the real faker still can.
 */

const why = (use) =>
  `@faker-js/faker is not bundled into this client (reached via ${use}). ` +
  `Only @farcaster/core's test-data factories use it, and this app never calls ` +
  `them; if something now does, import the real package in that module instead ` +
  `of relying on this stub (see apps/farcaster-web/config/fakerInterop.mjs).`;

/* Throwaway values, not corpus: a counter-driven generator, so the same call
   twice in one session does not answer the same thing, and nothing that looks
   like real locale data has to ship. */
let sequence = 0x2f6e2b1;

const next = () => (sequence = (sequence * 1664525 + 1013904223) >>> 0);

const between = (min, max) => {
  const low = Number.isFinite(Number(min)) ? Number(min) : 1;
  const high = Number.isFinite(Number(max)) ? Number(max) : 999_999;
  const span = Math.max(1, high - low + 1);
  return low + (next() % span);
};

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const alphaNumeric = (length) => {
  const size = Number.isFinite(Number(length)) && Number(length) > 0 ? Number(length) : 8;
  let out = '';
  for (let index = 0; index < size; index += 1) out += ALPHABET[next() % ALPHABET.length];
  return out;
};

const asDate = (value) => {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

/** The calls `@farcaster/core`'s module-scope factory builds make, by path. */
const CALLS = {
  'datatype.number': ({ min, max } = {}) => between(min ?? 1, max ?? 999_999),
  'datatype.int': ({ min, max } = {}) => between(min ?? 1, max ?? 999_999),
  'datatype.float': ({ min, max } = {}) => between(min ?? 0, max ?? 1000) / 10,
  'datatype.datetime': ({ min, max } = {}) => asDate(between(min ?? 0, max ?? Date.now())),
  'datatype.boolean': () => next() % 2 === 0,
  'random.alphaNumeric': (length) => alphaNumeric(length),
  'random.alpha': (length) => alphaNumeric(length),
  'random.word': () => 'throwaway',
  'random.words': (count) => Array.from({ length: Number(count) || 3 }, () => 'throwaway').join(' '),
  'helpers.arrayElement': (items = []) => items[between(0, Math.max(0, items.length - 1))],
  'lorem.sentence': () => 'throwaway test data',
  'lorem.words': () => 'throwaway test data',
  'internet.url': () => `https://example.invalid/${alphaNumeric(8)}`,
  'date.between': ({ from, to } = {}) =>
    asDate(between(asDate(from ?? 0).getTime(), asDate(to ?? Date.now()).getTime())),
};

/* Properties a Proxy must NOT invent a callable for: `then` would make this
   object look like a promise, and `toJSON`/`toString` must not throw. */
const PASS_THROUGH = new Set(['then', 'toString', 'valueOf', 'toJSON', 'inspect', 'constructor']);

const callableAt = (path) => {
  const answer = (...args) => {
    // `CALLS` is keyed without the root, so the message can name the call the
    // way a reader would write it (`faker.datatype.number`).
    const implementation = CALLS[path.startsWith('faker.') ? path.slice('faker.'.length) : path];
    if (implementation) return implementation(...args);
    throw new Error(why(path));
  };
  // `faker.datatype.number({...})` reaches a property of a property, so the
  // answer has to be walkable rather than a plain function.
  return new Proxy(answer, {
    get: (target, property) => {
      if (typeof property === 'symbol' || PASS_THROUGH.has(String(property))) {
        return target[property];
      }
      return callableAt(`${path}.${String(property)}`);
    },
    apply: (target, thisArg, args) => target(...args),
  });
};

export const faker = callableAt('faker');

export default faker;