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
 * The rule this file exists to hold: the document's `<head>` is the ONLY thing
 * changed. The theme bootstrap, the inline skeleton, the entry chunk and the
 * body are handed back byte-for-byte, because the shell is the app — anything
 * this touches is a way to break a reader's first paint, and the host serves
 * `script-src 'self'`, so nothing here may introduce an inline script.
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
}) =>
  [
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
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
 * The shell with this page's head, and nothing else about it changed.
 *
 * A shell with no `</head>` is not a shell (a truncated release, a wrong path):
 * that is raised rather than papered over, because the alternative is serving a
 * document nobody can parse.
 */
export const renderPageHtml = (shell, tags) => {
  if (!shell.includes('</head>')) {
    throw new Error('the shell has no </head>: refusing to serve it as a page');
  }
  let stripped = shell;
  for (const pattern of SITE_TAGS) {
    stripped = stripped.replace(pattern, '');
  }
  // The index is taken AFTER stripping: the site's tags sat before </head>, so
  // an index from the original document would cut the body off its own head
  // (measured: the first version of this function shifted the whole body by the
  // length of the tags it had just removed).
  const head = stripped.indexOf('</head>');
  return `${stripped.slice(0, head)}    ${tags}\n  ${stripped.slice(head)}`;
};

/** The card assets the per-page tags describe, all served from this origin. */
export const cardUrl = (origin, kind, id, miniApp = false) =>
  `${origin}/unfurl/cards/${kind}/${encodeURIComponent(id)}${miniApp ? '.3x2' : ''}.png`;
