/**
 * The faker alias in `config/fakerInterop.mjs` must answer every call
 * `@farcaster/core`'s dist makes while it is being IMPORTED.
 *
 * Why this is a test and not a comment: core builds some of its test-data
 * factories at module scope, so those calls run on import. When the alias threw
 * from every call, importing core threw, the entry chunk died mid-evaluation and
 * every route stayed on the shell's "Loading Fiddy…" fallback — measured on the
 * live origin 2026-10-22 16:59 (`reached via faker.datatype.number`, stack
 * inside the entry chunk). The call list is enumerated from the installed
 * dist, so a core upgrade that reaches for a new faker method fails here
 * instead of taking the site down.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

// eslint-disable-next-line no-restricted-imports -- `~` names src/, and the alias target lives in config/
import fakerModule from '../../../config/fakerInterop.mjs';

type Walkable = { [key: string]: Walkable } & ((...args: unknown[]) => unknown);

const faker = fakerModule as unknown as Walkable;

const STUB_MESSAGE = 'is not bundled into this client (reached via';

/** Every `faker.<path>` reference inside the installed `@farcaster/core`. */
const fakerCallsInCore = (): string[] => {
  const require_ = createRequire(import.meta.url);
  // `@farcaster/core` is not this app's own dependency — it arrives through the
  // workspace package, so resolve it from there.
  const fromNodeClient = dirname(require_.resolve('farcaster-node-client'));
  const entry = require_.resolve('@farcaster/core', {
    paths: [fromNodeClient],
  });
  const source = readFileSync(entry, 'utf8');
  const paths = new Set<string>();
  for (const match of source.matchAll(/faker\.[A-Za-z0-9_.]+/g)) {
    // The CJS build spells these `import_faker.faker.datatype.number`, and the
    // character class runs across the dot, so the match starts one `faker.` too
    // early wherever the module object itself is called `faker`.
    paths.add(match[0].replace(/^(faker\.)+/, ''));
  }
  return [...paths].sort();
};

const walk = (path: string): Walkable =>
  path.split('.').reduce<Walkable>((node, key) => node[key], faker);

describe('the faker alias', () => {
  const paths = fakerCallsInCore();

  it('finds the calls core makes (the list this guard is built on)', () => {
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain('datatype.number');
  });

  it.each(fakerCallsInCore())('answers faker.%s without throwing', (path) => {
    const callable = walk(path);
    expect(typeof callable).toBe('function');
    expect(() => callable()).not.toThrow();
  });

  it('keeps the refusal message the release proof greps for', () => {
    const source = readFileSync(
      new URL('../../../config/fakerInterop.mjs', import.meta.url),
      'utf8',
    );
    expect(source).toContain(STUB_MESSAGE);
  });

  it('still throws, by name, for a call this client has no reason to make', () => {
    expect(() => walk('commerce.price')()).toThrow(STUB_MESSAGE);
  });

  it('is not a thenable and survives serialisation', () => {
    expect(faker.then).toBeUndefined();
    expect(() => JSON.stringify({ faker })).not.toThrow();
  });
});
