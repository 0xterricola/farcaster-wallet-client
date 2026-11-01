/**
 * Looks — the palette a person makes, wears, and hands to someone else.
 *
 * ADAPTED FROM QUILCAST (github.com/backmeupplz/quilcast, MIT):
 *   * `bc818ee6ab11` (#14) — cleanTheme()'s whitelist/ranges/`#rrggbb`-only shape,
 *     the CSS-variable application before first paint, and the share-by-hash of
 *     the checked body;
 *   * `81b71cbb94f4` (#16) — a preview of a look drawn as the product itself in
 *     that look's own colours.
 * Reimplemented for this client: no CSS text, no media, no remote fetch of any
 * kind, and a fixed token list rather than a theme language.
 *
 * WHAT A LOOK IS. Plain, checked settings — never CSS. Every token is a
 * whitelisted name; every colour is `#rrggbb` and nothing else; numbers are
 * whole and clamped; strings a person types are bounded and stripped of control
 * characters; an unknown key is dropped. `lookVars()` turns the checked result
 * into the variables this client already reads (`--fiddy-*`, plus the fork's
 * app aliases), which is why wearing a look restyles every surface that reads
 * them and cannot restyle anything else.
 *
 * WHAT IT IS NOT. It does not carry a picture, a font file, a URL or a
 * stylesheet. `LOOK_MEDIA_KEYS` is the list of fields a look could carry one in
 * (upstream accepts inline `data:` URIs there, checked by magic bytes); this
 * client refuses them outright until a slice ships media, so nothing here can
 * ever fetch or apply bytes from a look.
 *
 * WHERE IT IS APPLIED. `public/shell-bootstrap.js` writes the worn look's
 * variables in `<head>`, before the document paints (a same-origin classic
 * script, so `script-src 'self'` still holds); `applyLook()` does the same at
 * runtime. Both use the same variable names — `__tests__/lookTheme.test.ts`
 * holds the bootstrap to that list, because a second, drifting copy of it is
 * exactly how a flash of the previous palette comes back.
 */

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
] as const;

export type LookToken = (typeof LOOK_TOKENS)[number];

/** The fonts this client already has. Nothing a look names is ever fetched. */
export const LOOK_FONTS = {
  rounded: "'SF Pro Rounded', ui-rounded, system-ui, sans-serif",
  inter: "'Inter', sans-serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

export type LookFont = keyof typeof LOOK_FONTS;

export type Look = Partial<Record<LookToken, string>> & {
  /** What the maker called it. Words, printed as words. */
  name?: string;
  /** Whether the look reads dark or light, for `color-scheme` and the shell. */
  base?: 'light' | 'dark';
  /** Corners, in px, for the shell's panels. */
  round?: number;
  /** Border width, in px, for the shell's borders. */
  borderWidth?: number;
  font?: LookFont;
};

/** Fields a look could carry bytes or a URL in. Refused, not ignored. */
export const LOOK_MEDIA_KEYS = [
  'bgImg',
  'barImg',
  'btnImg',
  'fontUrl',
  'stickers',
  'fx',
] as const;

export const LOOK_LIMITS = {
  /** The largest share body the endpoint will look at, in bytes. */
  bytes: 4096,
  /** A name is a name, not a paragraph. */
  name: 40,
  /** Corners and borders, in px: what a panel can be drawn at. */
  round: 24,
  borderWidth: 4,
  /** How many looks this browser keeps to hand back later. */
  saved: 12,
  /** A share id is a hash of the checked body, cut to this many characters. */
  id: 10,
} as const;

export const LOOK_STORAGE_KEY = 'fiddy-look';
export const LOOK_LIBRARY_KEY = 'fiddy-looks';

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9]{6,32}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The look Fiddy ships and wears once someone asks for it: the brand — chartreuse
 * on #161715 — named so it can be picked, edited and handed on like any other.
 */
export const FIDDY_LOOK: Look = {
  name: 'Fiddy',
  base: 'dark',
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
  round: 18,
  borderWidth: 1,
  font: 'rounded',
};

/** What a fresh browser wears when it has asked for nothing. */
export const DEFAULT_LOOK: Look = {
  base: 'dark',
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
  round: 18,
  borderWidth: 1,
  font: 'rounded',
};

/** The looks this client ships, in the order the picker shows them. */
export const SHIPPED_LOOKS: Look[] = [
  FIDDY_LOOK,
  {
    name: 'Paper',
    base: 'light',
    bg: '#f4f3ec',
    card: '#ffffff',
    ink: '#1b1c17',
    muted: '#66685d',
    line: '#e0ded2',
    soft: '#eceae0',
    accent: '#3f6cff',
    onAccent: '#ffffff',
    like: '#d6295c',
    recast: '#1a8f6a',
    border: '#e0ded2',
    round: 12,
    borderWidth: 1,
    font: 'inter',
  },
  {
    name: 'Dusk',
    base: 'dark',
    bg: '#101220',
    card: '#191c2e',
    ink: '#e7e9f5',
    muted: '#8b90a8',
    line: '#262a40',
    soft: '#191c2e',
    accent: '#8f7bff',
    onAccent: '#12121c',
    like: '#f9518e',
    recast: '#2fd08c',
    border: '#262a40',
    round: 24,
    borderWidth: 2,
    font: 'rounded',
  },
];

/** `#d4ff3f`, or undefined for everything else (`red`, `rgb()`, `javascript:`). */
export const cleanLookColor = (value: unknown): string | undefined =>
  typeof value === 'string' && HEX.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;

const cleanWhole = (
  value: unknown,
  min: number,
  max: number,
): number | undefined => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    return undefined;
  }
  return Math.min(Math.max(Math.round(number), min), max);
};

/** The words a maker typed, as words: one line, bounded, no control characters. */
export const cleanLookName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, LOOK_LIMITS.name) : undefined;
};

/**
 * The valid part of a look; anything unknown or out of range is dropped.
 *
 * Dropping is the whole safety story: this function's return value is the only
 * thing that is ever stored, hashed or applied, and it can hold nothing but the
 * names below.
 */
export function cleanLook(value: unknown): Look {
  if (!isObj(value)) {
    return {};
  }

  const look: Look = {
    name: cleanLookName(value.name),
    base:
      value.base === 'light' || value.base === 'dark' ? value.base : undefined,
    ...Object.fromEntries(
      LOOK_TOKENS.map((token) => [token, cleanLookColor(value[token])]),
    ),
    round: cleanWhole(value.round, 0, LOOK_LIMITS.round),
    borderWidth: cleanWhole(value.borderWidth, 0, LOOK_LIMITS.borderWidth),
    font:
      typeof value.font === 'string' && value.font in LOOK_FONTS
        ? (value.font as LookFont)
        : undefined,
  };

  // A look that says the default is a look that says nothing: it keeps the
  // share id of the same look without it, so one look is one look.
  if (look.round === FIDDY_LOOK.round) {
    delete look.round;
  }
  if (look.borderWidth === FIDDY_LOOK.borderWidth) {
    delete look.borderWidth;
  }
  if (look.font === FIDDY_LOOK.font) {
    delete look.font;
  }
  if (look.base === DEFAULT_LOOK.base) {
    delete look.base;
  }

  for (const key of Object.keys(look) as (keyof Look)[]) {
    if (look[key] === undefined) {
      delete look[key];
    }
  }

  return look;
}

/** Whether a body carried something a look may not carry (a picture, a URL). */
export const lookCarriesMedia = (value: unknown): boolean =>
  isObj(value) && LOOK_MEDIA_KEYS.some((key) => key in value);

/** Whether two looks are the same look, by their checked contents. */
export const lookFingerprint = (look: Look): string =>
  JSON.stringify(cleanLook(look));

export const sameLook = (a: Look, b: Look): boolean =>
  lookFingerprint(a) === lookFingerprint(b);

/**
 * The variables a worn look writes. Every token is written, always: a look is a
 * whole palette, so nothing is left reading the previous one.
 *
 * The names are this client's own (`--fiddy-*`, the ones the Fiddy shell and
 * the brand surfaces already read) plus the fork's app aliases, which exist for
 * exactly this kind of override and are otherwise unset.
 */
export function lookVars(look: Look): Record<string, string> {
  const merged = { ...DEFAULT_LOOK, ...cleanLook(look) };
  const font = LOOK_FONTS[merged.font ?? 'rounded'] ?? LOOK_FONTS.rounded;

  return {
    // The Fiddy shell's own tokens.
    '--fiddy-bg': merged.bg as string,
    '--fiddy-bg-raise': merged.card as string,
    '--fiddy-ink': merged.ink as string,
    '--fiddy-ink-dim': merged.muted as string,
    '--fiddy-accent': merged.accent as string,
    '--fiddy-on-accent': merged.onAccent as string,
    '--fiddy-line': merged.line as string,
    '--fiddy-soft': merged.soft as string,
    '--fiddy-like': merged.like as string,
    '--fiddy-recast': merged.recast as string,
    '--fiddy-radius': `${merged.round ?? 18}px`,
    '--fiddy-look-border': `${merged.borderWidth ?? 1}px`,
    '--fiddy-look-line': merged.border as string,
    '--fiddy-font': font,
    // The fork's app aliases, so the surfaces that read them follow too.
    '--bg-app': merged.bg as string,
    '--text-default': merged.ink as string,
    '--bg-muted': merged.soft as string,
    '--text-muted': merged.muted as string,
    '--border-default': merged.line as string,
    '--bg-elevated': merged.card as string,
    '--bg-action-primary': merged.accent as string,
    '--bg-action-secondary': merged.soft as string,
  };
}

/** Every variable a look owns, so removing one removes all of them. */
export const LOOK_VARS = Object.keys(lookVars(DEFAULT_LOOK));

/**
 * Write a worn look on the document (or take it off again).
 *
 * Called at runtime; `public/shell-bootstrap.js` does the same thing in `<head>`
 * before the first paint, which is where the no-flash guarantee actually comes
 * from.
 */
export function applyLook(
  look: Look | undefined,
  root: HTMLElement | undefined = typeof document === 'undefined'
    ? undefined
    : document.documentElement,
): void {
  if (!root) {
    return;
  }

  if (!look) {
    for (const name of LOOK_VARS) {
      root.style.removeProperty(name);
    }
    root.removeAttribute('data-look');
    root.removeAttribute('data-look-base');
    return;
  }

  const cleaned = cleanLook(look);
  const vars = lookVars(cleaned);
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
  root.setAttribute('data-look', cleaned.name ?? 'yours');
  root.setAttribute('data-look-base', cleaned.base ?? 'dark');
}

/** A stored look, or undefined: anything malformed is simply not a look. */
export const parseLook = (value: string | null): Look | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    const cleaned = cleanLook(JSON.parse(value) as unknown);
    return Object.keys(cleaned).length ? cleaned : undefined;
  } catch {
    return undefined;
  }
};

/** The look this browser is wearing, read the way the bootstrap script reads it. */
export function readWornLook(
  storage: Storage | undefined = typeof localStorage === 'undefined'
    ? undefined
    : localStorage,
): Look | undefined {
  if (!storage) {
    return undefined;
  }
  try {
    return parseLook(storage.getItem(LOOK_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

/** Looks this browser has tried, newest first. */
export function readSavedLooks(
  storage: Storage | undefined = typeof localStorage === 'undefined'
    ? undefined
    : localStorage,
): Look[] {
  if (!storage) {
    return [];
  }
  try {
    const raw: unknown = JSON.parse(storage.getItem(LOOK_LIBRARY_KEY) ?? '[]');
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((entry) => cleanLook(entry))
      .filter((look) => Object.keys(look).length > 0)
      .slice(0, LOOK_LIMITS.saved);
  } catch {
    return [];
  }
}

/** Keep a look to hand back later; the same look twice is one entry. */
export function rememberLook(
  look: Look,
  storage: Storage | undefined = typeof localStorage === 'undefined'
    ? undefined
    : localStorage,
): Look[] {
  const cleaned = cleanLook(look);
  if (!storage || !Object.keys(cleaned).length) {
    return [];
  }
  const kept = readSavedLooks(storage).filter(
    (saved) => !sameLook(saved, cleaned),
  );
  const next = [cleaned, ...kept].slice(0, LOOK_LIMITS.saved);
  try {
    storage.setItem(LOOK_LIBRARY_KEY, JSON.stringify(next));
  } catch {
    return next;
  }
  return next;
}

/**
 * Wear a look (or take it off) and tell the rest of the app, the same way the
 * saved light/dark choice already travels.
 */
export function wearLook(
  look: Look | undefined,
  storage: Storage | undefined = typeof localStorage === 'undefined'
    ? undefined
    : localStorage,
): void {
  const cleaned = look ? cleanLook(look) : undefined;
  const worn = cleaned && Object.keys(cleaned).length ? cleaned : undefined;
  try {
    if (worn) {
      storage?.setItem(LOOK_STORAGE_KEY, JSON.stringify(worn));
    } else {
      storage?.removeItem(LOOK_STORAGE_KEY);
    }
  } catch {
    // A browser with storage switched off still wears the look this session.
  }

  applyLook(worn);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: LOOK_STORAGE_KEY,
        newValue: worn ? JSON.stringify(worn) : null,
        oldValue: null,
        storageArea: storage ?? null,
        url: window.location.href,
      }),
    );
  }
}

/** What to call a look in a list: the maker's words, or none. */
export const lookLabel = (look: Look, fallback = 'Your look'): string =>
  look.name?.trim() || fallback;

/**
 * The public address of a shared look, on the origin this client is served from.
 *
 * The link carries the look's id and nothing else. In particular it does NOT
 * carry who made it: a share id is a hash of the checked look, the same look
 * shared twice is one id, and a URL that named its maker could name anybody.
 * The name a person sees on a card in a feed is the author of the CAST that
 * carried the link, which is a fact rather than a claim.
 */
export function lookUrl(id: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/look/${id}`;
}

/**
 * Our own look links, and nothing else: `{ id }` for a link this host serves.
 *
 * The host matters. A look's id means nothing anywhere but the origin that
 * stored it, so a `/look/<id>` on somebody else's site is NOT ours to draw —
 * treating it as ours would fetch our own id space and answer about a different
 * look. Accepted hosts: the one this client is served from (which is what makes
 * a self-hosted Fiddy work) and fiddy.fun itself.
 */
export const LOOK_HOSTS = ['fiddy.fun', 'www.fiddy.fun'];

export function matchLookUrl(url: string): { id: string } | undefined {
  if (typeof url !== 'string') {
    return undefined;
  }
  const match = /^https?:\/\/([^/?#]+)\/look\/([^/?#]+)(?:\?[^#]*)?$/i.exec(
    url,
  );
  if (!match) {
    return undefined;
  }
  const host = match[1].toLowerCase();
  const own = typeof window === 'undefined' ? undefined : window.location.host;
  if (!LOOK_HOSTS.includes(host) && host !== own?.toLowerCase()) {
    return undefined;
  }
  try {
    const id = decodeURIComponent(match[2]);
    return ID.test(id) ? { id } : undefined;
  } catch {
    return undefined;
  }
}

/** A look's promise, in one line, for a card or a preview. */
export const describeLook = (look: Look): string => {
  const parts: string[] = [];
  if (look.base === 'light') {
    parts.push('light');
  } else if (look.base === 'dark') {
    parts.push('dark');
  }
  if (typeof look.round === 'number') {
    parts.push(look.round >= 20 ? 'round corners' : 'soft corners');
  }
  if (look.font === 'mono') {
    parts.push('mono type');
  } else if (look.font === 'inter') {
    parts.push('plain type');
  } else if (look.font === 'rounded') {
    parts.push('rounded type');
  }
  return parts.join(' · ');
};
