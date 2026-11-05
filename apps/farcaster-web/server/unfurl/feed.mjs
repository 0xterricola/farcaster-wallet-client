/**
 * RSS 2.0 feeds of an account's casts (`/~/profiles/<fid>/rss`) and a channel's
 * (`/~/channel/<id>/rss`), for feed readers. Each item is a cast: its link and
 * guid are its page here, its title a short cut of its text, its description
 * the text as this host draws it (line breaks kept, links absolute) with its
 * pictures, links and quoted casts below.
 *
 * Ported from backmeupplz/quilcast `server/feed.mjs`, MIT license, commit
 * cdc4ec655888 (0.69.0 — RSS feeds for every account and channel), adopted
 * 2026-11-06. Kept close to the original on purpose: the escaper below (which
 * first DROPS what XML 1.0 cannot hold even when escaped — most C0 controls,
 * U+FFFE/U+FFFF, half a surrogate pair — because that is the part everyone
 * gets wrong), the hash test on every cast, the takedown filter, and the
 * shape of the item and the document. What differs is the input: this host
 * reads casts from its own node (`reader.mjs`), not from an index, so the
 * cast arrives as a protocol message rather than quilcast's API shape, and
 * the text is drawn the way this host's crawler HTML draws it — plain words,
 * no markdown invented server-side.
 *
 * The casts themselves, the reads and the provider chain behind them, and the
 * routes that serve this document live in `reader.mjs` and `handler.mjs`.
 */

// What XML 1.0 can't hold at all, even escaped (most C0 controls, U+FFFE and
// U+FFFF, half a surrogate pair), is dropped — kept from the original, whose
// literal characters are spelled \ufffe\uffff here so the file itself stays
// clean to diff.
const BAD =
  // eslint-disable-next-line no-control-regex -- the control characters ARE the point: this regex names exactly what XML 1.0 cannot hold, so a feed never carries bytes that make a reader reject the document (quilcast's own escaper).
  /[\0-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const XML = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
/** Text (or HTML) as XML character data or an attribute value. */
export const xml = (s) =>
  String(s ?? '')
    .replace(BAD, '')
    .replace(/[&<>"']/g, (c) => XML[c]);
const html = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const HASH = /^(0x)?[0-9a-f]{40}$/;

/** A picture embed, by extension — the reader hands us the URL the author cast. */
const isImg = (url) =>
  /\.(?:png|jpe?g|gif|webp|avif)(?:[?#].*)?$/i.test(String(url ?? ''));

const oneLine = (value, limit) => {
  const collapsed = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= limit) {
    return collapsed;
  }
  return `${collapsed.slice(0, limit).trimEnd()}…`;
};

/** The page a cast is, on this host: the same URL the card and the crawler use. */
const castPageUrl = (origin, hash) => `${origin}/~/conversations/${hash}`;

/**
 * A cast as HTML for a reader: its text with line breaks kept (the app draws
 * it pre-wrap), then its pictures, links and quoted casts. Every URL a cast
 * carries is absolute already — the protocol stores absolute embeds — so the
 * original's relative-link rewriting has nothing to do here and is not kept.
 */
export function castHtml(cast, origin) {
  const text = html(String(cast.text ?? ''))
    .split(/(<pre[\s\S]*?<\/pre>)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\n/g, '<br>')))
    .join('');
  const media = (cast.embeds ?? [])
    .flatMap((embed) =>
      typeof embed?.url === 'string' && embed.url
        ? [
            isImg(embed.url)
              ? `<p><img src="${html(embed.url)}" alt="" referrerpolicy="no-referrer"></p>`
              : `<p><a href="${html(embed.url)}">${html(embed.url)}</a></p>`,
          ]
        : [],
    );
  const quotes = (cast.embeds ?? []).flatMap((embed) =>
    HASH.test(embed?.castId?.hash ?? '')
      ? [
          `<p><a href="${html(castPageUrl(origin, embed.castId.hash))}">Quoted cast</a></p>`,
        ]
      : [],
  );
  return (text ? `<div>${text}</div>` : '') + media.join('') + quotes.join('');
}

/**
 * The `<item>` for a cast. `who` is the author as this host can name them
 * (`@dwr`, `fid 3`, or a display name beside the handle) — resolved by the
 * caller, because only it knows which read answered.
 */
export function item(cast, origin, who = '') {
  const link = castPageUrl(origin, cast.hash);
  const title = oneLine(cast.text, 100) || (who ? `A cast by ${who}` : 'A cast');
  const d = new Date(cast.timestampMs ?? Number.NaN);
  return (
    '<item>' +
    `<title>${xml(title)}</title><link>${xml(link)}</link><guid isPermaLink="true">${xml(link)}</guid>` +
    (isNaN(d) ? '' : `<pubDate>${d.toUTCString()}</pubDate>`) +
    (who
      ? `<dc:creator>${xml(who)}</dc:creator>`
      : cast.fid != null
        ? `<dc:creator>fid ${xml(String(cast.fid))}</dc:creator>`
        : '') +
    `<description>${xml(castHtml(cast, origin))}</description></item>`
  );
}

/**
 * The casts a feed shows, newest first: real hashes only, nothing taken down
 * (`gone`: `{casts: [...hashes], fids: [...fids]}`, empty by default — this
 * host keeps no takedown list yet, and the filter is here so the day it has
 * one, the feed honours it), and replies only when asked for.
 */
export const shown = (
  casts,
  { replies = false, max = 25, gone = { casts: [], fids: [] } } = {},
) =>
  (casts || [])
    .filter(
      (cast) =>
        HASH.test(cast?.hash) &&
        !gone.casts.includes(cast.hash) &&
        !gone.fids.includes(cast?.fid) &&
        (replies || !cast?.parent),
    )
    .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
    .slice(0, max);

/**
 * A whole RSS 2.0 document. `ttl` asks readers to come back no sooner than
 * that many minutes, and `self` is the feed's own URL (the one a reader
 * subscribes with) — an address, so it is never cached longer than an hour
 * anywhere (the one-hour rule, docs/CLIENT-RSS-FEEDS.md).
 */
export function rss({ title, link, self, desc, image, casts, origin, ttl = 15 }) {
  const img =
    typeof image === 'string' && /^https:\/\//.test(image) && image.length < 1024;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>' +
    `<title>${xml(title)}</title><link>${xml(link)}</link><description>${xml(desc)}</description>` +
    `<atom:link href="${xml(self)}" rel="self" type="application/rss+xml" /><generator>fiddy (RSS writer from backmeupplz/quilcast, MIT)</generator><ttl>${ttl}</ttl>` +
    (img
      ? `<image><url>${xml(image)}</url><title>${xml(title)}</title><link>${xml(link)}</link></image>`
      : '') +
    casts.map((cast) => item(cast, origin, cast.who)).join('') +
    '</channel></rss>\n'
  );
}
