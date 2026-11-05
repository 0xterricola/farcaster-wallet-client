/**
 * What a crawler is told about ONE page on fiddy.fun.
 *
 * The client is a single-page app, so before this the same document answered
 * every route: `index.html` with the site-level tags t_1e01f488 added, and a
 * shared cast or profile link unfurled as the front door. The fix is not in the
 * client — a crawler never runs the bundle — it is a server that answers a
 * cast or profile URL with that page's OWN tags over the same shell the app
 * ships.
 *
 * For casts and looks the document's `<head>` is the ONLY thing changed. A
 * readable profile also gets static crawler HTML inside the empty app root and
 * ProfilePage JSON-LD. The theme bootstrap, skeleton markup, entry chunk and
 * normal client render stay intact, and nothing here adds inline executable
 * JavaScript because the host serves `script-src 'self'`. The client clears the
 * crawler root immediately before mounting.
 *
 * Site tags are REMOVED rather than added to, and that is deliberate: the shell
 * says `og:title: fiddy — a Farcaster client with an agent` for every URL, and
 * a document that declares both that and the cast's own title tells an unfurler
 * whichever one it happens to read first.
 */

/** Every `og:` / `twitter:` / `fc:` meta, the description, and the title. */
const SITE_TAGS = [
  /<meta\s+(?:property|name)="(?:og|twitter|fc):[^"]*"\s+content=(?:"[^"]*"|'[^']*')\s*\/?>\s*/gi,
  /<meta\s+name="description"\s+content=(?:"[^"]*"|'[^']*')\s*\/?>\s*/gi,
  /<title>[\s\S]*?<\/title>\s*/gi,
];

/** The characters that make an attribute value a different attribute value. */
export const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** One line, bounded: a title is a title, not the whole cast. */
export const oneLine = (value, limit) => {
  const collapsed = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= limit) {
    return collapsed;
  }
  // Cut on a word boundary when there is one near the limit, so the title does
  // not end mid-word (measured: `…technology and other st…` reads as a bug).
  const clipped = collapsed.slice(0, limit);
  const space = clipped.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? clipped.slice(0, space) : clipped).trimEnd()}…`;
};

const metaTag = (attribute, key, value) =>
  `<meta ${attribute}="${key}" content="${escapeHtml(value)}" />`;

/**
 * The `fc:miniapp` embed for a page, with that page's own URL as its action.
 *
 * The same app answers the cast page, so the card is launchable at the cast
 * rather than only at the front door: a mini app host that opens this URL lands
 * on the cast it named. The manifest at `/.well-known/farcaster.json` is what
 * names the app; nothing here claims anything the manifest does not.
 * Per-page 3:2 mini-app art adapted from backmeupplz/quilcast commit
 * d0a87cce7fd7 (MIT): https://github.com/backmeupplz/quilcast/commit/d0a87cce7fd7
 */
const miniAppTag = (origin, url, embedImageUrl, buttonTitle) =>
  `<meta name="fc:miniapp" content='${JSON.stringify({
    version: '1',
    imageUrl: embedImageUrl,
    button: {
      title: buttonTitle,
      action: {
        type: 'launch_miniapp',
        name: 'fiddy',
        url,
        splashImageUrl: `${origin}/fiddy-splash.png`,
        splashBackgroundColor: '#161715',
      },
    },
  })}' />`;

/** The head a cast or profile page declares about itself. */
export const pageTags = ({
  title,
  description,
  url,
  imageUrl,
  embedImageUrl,
  buttonTitle,
  imageAlt,
  type,
  origin,
  siteName = 'fiddy',
  /**
   * The page's feed, when it has one (`{title, path, self}`): a reader that
   * is handed this page's URL can find the feed without being told the
   * pattern, because the head advertises it where the `og:` tags already
   * speak. Cast and look pages carry none.
   */
  feed,
}) =>
  [
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    ...(feed
      ? [
          `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(feed.title)}" href="${escapeHtml(feed.self ?? `${origin}${feed.path}`)}" />`,
        ]
      : []),
    metaTag('name', 'description', description),
    metaTag('property', 'og:type', type),
    metaTag('property', 'og:site_name', siteName),
    metaTag('property', 'og:title', title),
    metaTag('property', 'og:description', description),
    metaTag('property', 'og:url', url),
    metaTag('property', 'og:image', imageUrl),
    metaTag('property', 'og:image:width', '1200'),
    metaTag('property', 'og:image:height', '630'),
    metaTag('property', 'og:image:alt', imageAlt),
    metaTag('name', 'twitter:card', 'summary_large_image'),
    metaTag('name', 'twitter:title', title),
    metaTag('name', 'twitter:description', description),
    metaTag('name', 'twitter:image', imageUrl),
    miniAppTag(origin, url, embedImageUrl, buttonTitle),
  ].join('\n    ');

/**
 * The shell with this page's head, plus a profile's static crawler root when
 * supplied. JSON-LD is data, not executable script; `<` is escaped so profile
 * text cannot close its tag.
 *
 * A shell with no `</head>` is not a shell (a truncated release, a wrong path):
 * that is raised rather than papered over, because the alternative is serving a
 * document nobody can parse.
 */
export const renderPageHtml = (
  shell,
  tags,
  { jsonLd, crawlerHtml, crawlerStyle, noindex = false } = {},
) => {
  if (!shell.includes('</head>')) {
    throw new Error('the shell has no </head>: refusing to serve it as a page');
  }
  let stripped = shell;
  for (const pattern of SITE_TAGS) {
    stripped = stripped.replace(pattern, '');
  }
  if (noindex) {
    stripped = stripped.replace(
      /\s*<link\s+rel="canonical"\s+href=(?:"[^"]*"|'[^']*')\s*\/?\s*>/gi,
      '',
    );
  }
  const headTags = [
    tags,
    noindex ? '<meta name="robots" content="noindex, follow" />' : '',
    crawlerStyle ?? '',
    jsonLd
      ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`
      : '',
  ]
    .filter(Boolean)
    .join('\n    ');
  // The index is taken AFTER stripping: the site's tags sat before </head>, so
  // an index from the original document would cut the body off its own head
  // (measured: the first version of this function shifted the whole body by the
  // length of the tags it had just removed).
  const head = stripped.indexOf('</head>');
  let html = `${stripped.slice(0, head)}    ${headTags}\n  ${stripped.slice(head)}`;
  if (crawlerHtml) {
    if (!html.includes('<div id="root"></div>')) {
      throw new Error('the shell has no empty app root for crawler HTML');
    }
    html = html.replace(
      '<div id="root"></div>',
      () => `<div id="root">${crawlerHtml}</div>`,
    );
  }
  return html;
};

/** The card assets the per-page tags describe, all served from this origin. */
export const cardUrl = (origin, kind, id, miniApp = false) =>
  `${origin}/unfurl/cards/${kind}/${encodeURIComponent(id)}${miniApp ? '.3x2' : ''}.png`;
