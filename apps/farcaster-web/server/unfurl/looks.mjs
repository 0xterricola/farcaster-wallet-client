/**
 * Shared looks: what this service stores, and how it checks what it is given.
 *
 *   POST /look        store a look once, under a hash of its own checked body,
 *                     and answer { id } — the id in `fiddy.fun/look/<id>`
 *   GET  /look/<id>.json   the stored look, or a 404 (the app reads this)
 *
 * ADAPTED FROM QUILCAST (github.com/backmeupplz/quilcast, MIT), commit
 * `bc818ee6ab11` (#14): a theme is checked data, the share id is a hash of the
 * checked body, and the file is written once (`{ flag: 'wx' }`).
 *
 * THE SHAPE IS THE SAFETY STORY, so it is short: a look may hold ELEVEN named
 * colours (each `#rrggbb` and nothing else), a name, a base, two whole numbers
 * in range and one of three bundled faces. Everything else is dropped before
 * anything is stored or hashed, so a stored look cannot hold CSS, a URL, a
 * filename or a picture — and since the id IS the hash of that checked body, a
 * look that is already stored is immutable by construction: there is nothing to
 * migrate and nothing to garbage-collect.
 *
 * NO MEDIA, YET. Upstream accepts pictures and a font as inline `data:` URIs,
 * checked by magic bytes, stored under a content hash and served same-origin.
 * This client ships no media in a look at all (see the card: backgrounds,
 * stickers and effects are a later slice), so a body that CARRIES one of those
 * fields is refused rather than quietly stripped — a person who hands over a
 * look should not have to wonder what happened to half of it.
 *
 * THE MODEL IS MIRRORED, NOT IMPORTED. `src/utils/lookTheme.ts` owns the same
 * model for the browser, and `public/shell-bootstrap.js` reads it in a third
 * place. Three copies of a whitelist is two too many, so
 * `src/__tests__/lookService.test.ts` holds all three to the same token list,
 * limits and colour rule: a rule that drifts is a failing test, not a silent
 * difference between what the app wears and what the host stores.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Kept in step with `LOOK_TOKENS` in `src/utils/lookTheme.ts`. */
export const LOOK_TOKENS = [
  'bg',
  'card',
  'ink',
  'muted',
  'line',
  'soft',
  'accent',
  'onAccent',
  'like',
  'recast',
  'border',
];

/** Fields a look could carry bytes or a URL in. Refused, never stripped. */
export const LOOK_MEDIA_KEYS = [
  'bgImg',
  'barImg',
  'btnImg',
  'fontUrl',
  'stickers',
  'fx',
];

/** Kept in step with `LOOK_LIMITS` in `src/utils/lookTheme.ts`. */
export const LOOK_LIMITS = {
  bytes: 4096,
  name: 40,
  round: 24,
  borderWidth: 4,
};

export const LOOK_FONTS = ['rounded', 'inter', 'mono'];

/** The brand's own palette, for anything a look leaves out. */
export const LOOK_DEFAULTS = {
  bg: '#161715',
  card: '#1d1e1c',
  ink: '#eef0e8',
  muted: '#9ba193',
  line: '#2b2c29',
  soft: '#1d1e1c',
  accent: '#d4ff3f',
  onAccent: '#1a1c10',
  like: '#ff6f9c',
  recast: '#7cb518',
  border: '#2b2c29',
};

/** A share id: the first ten hex characters of the checked body's sha256. */
export const LOOK_ID = /^[0-9a-f]{10}$/;
export const LOOK_ID_LENGTH = 10;

/** A colour this client can wear, or nothing (`rgb()`, `red`, `javascript:`). */
export const lookColour = (value) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;

const whole = (value, min, max) => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    return undefined;
  }
  return Math.min(Math.max(Math.round(number), min), max);
};

const name = (value) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, LOOK_LIMITS.name) : undefined;
};

/** The valid part of a look; anything unknown or out of range is dropped. */
export function cleanLook(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const look = { name: name(value.name) };
  for (const token of LOOK_TOKENS) {
    look[token] = lookColour(value[token]);
  }
  if (value.base === 'light' || value.base === 'dark') {
    look.base = value.base === 'light' ? 'light' : undefined;
  }
  look.round = whole(value.round, 0, LOOK_LIMITS.round);
  look.borderWidth = whole(value.borderWidth, 0, LOOK_LIMITS.borderWidth);
  look.font =
    typeof value.font === 'string' && LOOK_FONTS.includes(value.font)
      ? value.font
      : undefined;

  // A look that says the brand's own value is a look that says nothing: it keeps
  // the id of the same look without it, so one look is one id.
  if (look.round === 18) {
    delete look.round;
  }
  if (look.borderWidth === 1) {
    delete look.borderWidth;
  }
  if (look.font === 'rounded') {
    delete look.font;
  }

  for (const key of Object.keys(look)) {
    if (look[key] === undefined) {
      delete look[key];
    }
  }

  return look;
}

export const lookCarriesMedia = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  LOOK_MEDIA_KEYS.some((key) => key in value);

/**
 * A share body, as a checked look or as the one sentence that refuses it.
 *
 * Every refusal is a status and a sentence a person can read: this is the only
 * thing standing between a stranger's browser and what this host stores, so it
 * never throws, never guesses, and never stores a body it has not checked.
 */
export function shareableLook(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim()) {
    return { ok: false, status: 400, error: 'That look came through empty.' };
  }
  if (Buffer.byteLength(bodyText, 'utf8') > LOOK_LIMITS.bytes) {
    return {
      ok: false,
      status: 413,
      error: 'That look is too big to share.',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, status: 400, error: "That look couldn't be read." };
  }

  if (lookCarriesMedia(parsed)) {
    return {
      ok: false,
      status: 400,
      error: "A look can't carry a picture or a font yet.",
    };
  }

  const look = cleanLook(parsed);
  if (!Object.keys(look).length) {
    return { ok: false, status: 400, error: 'That look is empty.' };
  }

  // The stored body is this string and nothing else: the id is a hash of it, so
  // what the host hands back is what it checked.
  const body = JSON.stringify(look);
  return { ok: true, look, body };
}

export const lookIdOf = (body) =>
  createHash('sha256').update(body).digest('hex').slice(0, LOOK_ID_LENGTH);

/** The stored body for an id, or nothing: a look's id is its contents. */
export const isLookId = (value) =>
  typeof value === 'string' && LOOK_ID.test(value);

/**
 * The looks this host keeps, in a directory the service may write to.
 *
 * `put` is idempotent by content and by construction: the same body is the same
 * id, the file is created with `wx` (so an existing look is never rewritten) and
 * an id that is not ten hex characters never reaches the filesystem.
 */
export const createLookStore = ({ dir }) => ({
  async put(body) {
    const id = lookIdOf(body);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.json`), body, { flag: 'wx' }).catch(
      (error) => {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      },
    );
    return { id };
  },

  async get(id) {
    if (!isLookId(id)) {
      return undefined;
    }
    try {
      const stored = await readFile(join(dir, `${id}.json`), 'utf8');
      const look = cleanLook(JSON.parse(stored));
      return Object.keys(look).length ? look : undefined;
    } catch {
      return undefined;
    }
  },
});

/** What a crawler is told about a shared look, and what its card draws. */
export const lookFacts = ({ id, look }) => ({
  id,
  name: look.name,
  palette: LOOK_TOKENS.reduce(
    (palette, token) => ({
      ...palette,
      [token]: look[token] ?? LOOK_DEFAULTS[token],
    }),
    {},
  ),
  round: look.round ?? 18,
  borderWidth: look.borderWidth ?? 1,
  font: look.font ?? 'rounded',
});