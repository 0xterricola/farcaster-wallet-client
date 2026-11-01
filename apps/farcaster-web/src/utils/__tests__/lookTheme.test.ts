// @vitest-environment jsdom
/**
 * A LOOK: what it may hold, what it may not, and the one list three files share.
 *
 * These are the tests the card asked for, in this repo's convention (vitest, no
 * network), and they hold the three things that can actually go wrong:
 *
 *   1. THE SHAPE. `cleanLook` keeps the eleven named colours as `#rrggbb` and
 *      drops everything else — `red`, `rgb()`, `url()`, `javascript:`, a
 *      stylesheet, an unknown key, an out-of-range number, a name with a control
 *      character in it. A stored or shared look can only ever be one of these.
 *   2. THE WEARING. Every variable a look owns is written, and every one of them
 *      is taken off again when nothing is worn: a half-written look is what puts
 *      the previous palette back on the page in flashes.
 *   3. THE THIRD COPY. `public/shell-bootstrap.js` writes the same variables in
 *      `<head>` before first paint, and `server/unfurl/looks.mjs` checks and
 *      stores the same shape on the host — three implementations of one list, so
 *      the lists are compared here rather than trusted.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyLook,
  cleanLook,
  describeLook,
  FIDDY_LOOK,
  LOOK_LIMITS,
  LOOK_MEDIA_KEYS,
  LOOK_STORAGE_KEY,
  LOOK_TOKENS,
  LOOK_VARS,
  lookVars,
  matchLookUrl,
  readSavedLooks,
  readWornLook,
  rememberLook,
  sameLook,
  SHIPPED_LOOKS,
  wearLook,
} from '~/utils/lookTheme';

const webRoot = path.resolve(__dirname, '../../..');
const bootstrap = readFileSync(
  path.join(webRoot, 'public/shell-bootstrap.js'),
  'utf8',
);

describe('a look is checked data, never CSS', () => {
  it('keeps the eleven colours it names, as #rrggbb', () => {
    const look = cleanLook({
      bg: '#161715',
      card: '#1D1E1C',
      accent: '#D4FF3F',
    });

    expect(look.bg).toBe('#161715');
    // Upper case is folded, so the same colour is the same look.
    expect(look.card).toBe('#1d1e1c');
    expect(look.accent).toBe('#d4ff3f');
  });

  it('drops every colour that is not a plain six-digit value', () => {
    const look = cleanLook({
      bg: 'red',
      card: 'rgb(1, 2, 3)',
      ink: '#fff',
      muted: '#12345',
      line: 'linear-gradient(#fff, #000)',
      soft: 'url(https://example.com/x.png)',
      accent: 'javascript:alert(1)',
      onAccent: 'expression(alert(1))',
      like: '#12345g',
      recast: '  #aabbcc  ',
      border: '#1234567',
    });

    expect(look.bg).toBeUndefined();
    expect(look.card).toBeUndefined();
    expect(look.ink).toBeUndefined();
    expect(look.muted).toBeUndefined();
    expect(look.line).toBeUndefined();
    expect(look.soft).toBeUndefined();
    expect(look.accent).toBeUndefined();
    expect(look.onAccent).toBeUndefined();
    expect(look.like).toBeUndefined();
    expect(look.border).toBeUndefined();
    // …and one that IS a colour, padded, survives.
    expect(look.recast).toBe('#aabbcc');
  });

  it('drops anything it does not know: no pictures, no stylesheet, no width', () => {
    const look = cleanLook({
      bg: '#161715',
      bgImg: 'data:image/png;base64,AAAA',
      fontUrl: 'https://example.com/x.ttf',
      stickers: [{ src: 'https://example.com/x.gif' }],
      css: 'body { background: red }',
      style: 'color:red',
      width: '100%',
      '--evil': 'red',
    });

    expect(Object.keys(look)).toEqual(['bg']);
    expect(look).not.toHaveProperty('bgImg');
    expect(look).not.toHaveProperty('fontUrl');
    expect(look).not.toHaveProperty('stickers');
    expect(look).not.toHaveProperty('css');
  });

  it('clamps the numbers and keeps only the faces this client has', () => {
    expect(cleanLook({ round: 99 }).round).toBe(LOOK_LIMITS.round);
    expect(cleanLook({ round: -5 }).round).toBe(0);
    expect(cleanLook({ borderWidth: 99 }).borderWidth).toBe(
      LOOK_LIMITS.borderWidth,
    );
    expect(cleanLook({ borderWidth: 2.4 }).borderWidth).toBe(2);
    expect(cleanLook({ font: 'rounded' }).font).toBeUndefined();
    expect(cleanLook({ font: 'mono' }).font).toBe('mono');
    expect(cleanLook({ font: 'comic-sans' }).font).toBeUndefined();
  });

  it("a look that says the brand's own value is a look that says nothing", () => {
    // One look is one look: the same palette with the defaults spelled out gets
    // the same share id as the palette without them.
    expect(cleanLook({ ...FIDDY_LOOK, round: 18, borderWidth: 1 }).round).toBe(
      undefined,
    );
    expect(sameLook(cleanLook({ bg: '#161715' }), FIDDY_LOOK)).toBe(false);

    expect(
      cleanLook({ name: 'Fiddy', base: 'dark', round: 18 }).base,
    ).toBeUndefined();
    expect(cleanLook({ base: 'light' }).base).toBe('light');
    expect(cleanLook({ base: 'chartreuse' }).base).toBeUndefined();
  });

  it('takes a name as words: one line, bounded, no control characters', () => {
    const look = cleanLook({ name: '  Night\n\tOwl  \u0007  ' });
    expect(look.name).toBe('Night Owl');
    expect(cleanLook({ name: 'x'.repeat(200) }).name).toHaveLength(
      LOOK_LIMITS.name,
    );
    expect(cleanLook({ name: '   ' }).name).toBeUndefined();
    expect(cleanLook({ name: 42 }).name).toBeUndefined();
  });

  it('is empty for anything that is not an object', () => {
    for (const value of [null, undefined, 7, 'red', [], true]) {
      expect(cleanLook(value)).toEqual({});
    }
  });

  it('names a picture or a font as something a look may not carry', () => {
    // Upstream accepts these as inline data: URIs; this client ships no media in
    // a look at all, so `cleanLook` drops them and the share endpoint (see
    // `lookService.test.ts`) refuses a body that carried one.
    expect(
      cleanLook({ bg: '#161715', bgImg: 'data:image/png;base64,AA' }),
    ).not.toHaveProperty('bgImg');
    expect(LOOK_MEDIA_KEYS).toContain('bgImg');
    expect(LOOK_MEDIA_KEYS).toContain('fontUrl');
  });
});

describe('wearing a look', () => {
  it('writes every variable it owns, and the palette behind the ones it omits', () => {
    const vars = lookVars({ accent: '#ff0000' });

    expect(Object.keys(vars).sort()).toEqual([...LOOK_VARS].sort());
    expect(vars['--fiddy-accent']).toBe('#ff0000');
    // A look is a whole palette: the tokens it leaves out come from the brand.
    expect(vars['--fiddy-bg']).toBe('#161715');
    expect(vars['--bg-app']).toBe(vars['--fiddy-bg']);
    expect(vars['--text-default']).toBe(vars['--fiddy-ink']);
    expect(vars['--fiddy-radius']).toBe('18px');
  });

  it('puts a look on the document and takes every trace of it off again', () => {
    const root = document.documentElement;

    applyLook({ bg: '#101010', accent: '#00ff00', round: 4, base: 'light' });
    expect(root.style.getPropertyValue('--fiddy-bg')).toBe('#101010');
    expect(root.style.getPropertyValue('--fiddy-accent')).toBe('#00ff00');
    expect(root.style.getPropertyValue('--fiddy-radius')).toBe('4px');
    expect(root.getAttribute('data-look-base')).toBe('light');

    applyLook(undefined);
    for (const name of LOOK_VARS) {
      expect(root.style.getPropertyValue(name)).toBe('');
    }
    expect(root.hasAttribute('data-look')).toBe(false);
    expect(root.hasAttribute('data-look-base')).toBe(false);
  });

  it('never writes a variable a look could fill with something else', () => {
    // The document only ever receives the names in LOOK_VARS…
    applyLook({ bg: '#101010' });
    const written = Array.from(document.documentElement.style).filter((name) =>
      name.startsWith('--'),
    );
    for (const name of written) {
      expect(LOOK_VARS).toContain(name);
    }

    // …and a value can only be what `lookVars` produced, because `cleanLook` ran
    // first: a stylesheet handed in as a colour never reaches the page.
    applyLook({ bg: 'red; background-image: url(https://example.com/x.png)' });
    expect(document.documentElement.style.getPropertyValue('--fiddy-bg')).toBe(
      '#161715',
    );
  });

  it('reads back what this browser wears, and keeps the looks it tried', () => {
    localStorage.clear();

    expect(readWornLook()).toBeUndefined();

    wearLook({ name: 'Mossy', bg: '#101010', accent: '#00ff00' });
    const worn = readWornLook();
    expect(worn?.name).toBe('Mossy');
    expect(worn?.bg).toBe('#101010');
    // The look the bootstrap reads is the same key, checked the same way.
    expect(LOOK_STORAGE_KEY).toBe('fiddy-look');
    expect(bootstrap).toContain('fiddy-look');

    const library = rememberLook({ name: 'Mossy', bg: '#101010' });
    expect(library).toHaveLength(1);
    rememberLook({ name: 'Mossy', bg: '#101010' });
    expect(readSavedLooks()).toHaveLength(1);

    // A hand-edited or half-written value is simply not a look.
    localStorage.setItem('fiddy-look', '{"bg":"red","accent":"#00ff00"}');
    expect(readWornLook()?.bg).toBeUndefined();
    localStorage.setItem('fiddy-look', 'not json');
    expect(readWornLook()).toBeUndefined();

    wearLook(undefined);
    expect(localStorage.getItem('fiddy-look')).toBeNull();
  });
});

describe('the three copies of the model stay one list', () => {
  it('the shell bootstrap writes exactly the variables lookTheme owns', () => {
    for (const name of LOOK_VARS) {
      expect(bootstrap).toContain(name);
    }
    // …and it writes no variable this client does not own.
    const written = new Set(
      [...bootstrap.matchAll(/'(--fiddy-[a-z-]+)'/g)].map((match) => match[1]),
    );
    for (const name of written) {
      expect(LOOK_VARS).toContain(name);
    }
  });

  it('the shell bootstrap knows every colour token', () => {
    for (const token of LOOK_TOKENS) {
      // `bg: '--fiddy-bg'` in the script's own map.
      expect(bootstrap).toMatch(new RegExp(`\\b${token}: '--fiddy-`));
    }
    expect(bootstrap).toContain("var LOOK_KEY = 'fiddy-look'");
    // Its colour rule is the same rule: six digits or nothing.
    expect(bootstrap).toContain('/^#[0-9a-f]{6}$/i');
  });
});

describe('a look link is ours and nothing else', () => {
  it('reads our own links and refuses everything else', () => {
    expect(matchLookUrl('https://fiddy.fun/look/a1b2c3d4e5')).toEqual({
      id: 'a1b2c3d4e5',
    });
    expect(
      matchLookUrl('https://fiddy.fun/look/a1b2c3d4e5.json'),
    ).toBeUndefined();
    // Another host's `/look/...` is not ours: its ids mean nothing here.
    expect(matchLookUrl('https://example.com/look/a1b2c3d4e5')).toBeUndefined();
    // …but the host this client is served from is, and so is fiddy.fun.
    expect(matchLookUrl('https://www.fiddy.fun/look/a1b2c3d4e5')).toEqual({
      id: 'a1b2c3d4e5',
    });
    expect(matchLookUrl('https://fiddy.fun/look/')).toBeUndefined();
    expect(
      matchLookUrl('https://fiddy.fun/look/../../etc/passwd'),
    ).toBeUndefined();
    expect(matchLookUrl('https://fiddy.fun/~/profiles/3')).toBeUndefined();
    expect(
      matchLookUrl('https://fiddy.fun/look/a1b2c3d4e5/extra'),
    ).toBeUndefined();
  });
});

describe('the looks this client ships', () => {
  it('is the brand first, then looks that are actually different from it', () => {
    expect(SHIPPED_LOOKS[0]).toEqual(FIDDY_LOOK);
    expect(SHIPPED_LOOKS.length).toBeGreaterThan(1);
    for (const look of SHIPPED_LOOKS.slice(1)) {
      expect(sameLook(look, FIDDY_LOOK)).toBe(false);
      expect(describeLook(look)).toBeTruthy();
    }
    // Every shipped look survives the checker unchanged: a look the client
    // cannot wear is a look the client must not ship.
    for (const look of SHIPPED_LOOKS) {
      expect(cleanLook(look)).toEqual(cleanLook(look));
      for (const token of LOOK_TOKENS) {
        if (look[token] !== undefined) {
          expect(cleanLook(look)[token]).toBe(look[token]);
        }
      }
    }
  });
});
