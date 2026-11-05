import { PROFILE_CAST_LIMIT } from './reader.mjs';
import { escapeHtml } from './shellMeta.mjs';

/**
 * A profile a crawler can read without running Fiddy. The plain body and
 * ProfilePage JSON-LD are adapted from backmeupplz/quilcast (MIT), commit
 * d9c32487396e11ab44c0b1c901c62fd1ffe696a6, narrowed to facts Fiddy's node
 * reader actually holds: no avatars, counts, takedown policy, or new routes.
 */
export const profileCrawler = ({ origin, fid, author, casts }) => {
  const url = `${origin}/~/profiles/${fid}`;
  const handle = author?.username ? `@${author.username}` : `fid ${fid}`;
  const name = author?.displayName?.trim() || handle;
  const bio = typeof author?.bio === 'string' ? author.bio : '';
  const person = {
    '@type': 'Person',
    name,
    ...(author?.username ? { alternateName: `@${author.username}` } : {}),
    identifier: String(fid),
    ...(bio.trim() ? { description: bio } : {}),
    url,
  };
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url,
    mainEntity: person,
  };

  const posts = (Array.isArray(casts) ? casts : [])
    .filter(
      (cast) =>
        typeof cast?.text === 'string' && /^0x[0-9a-f]{40}$/i.test(cast?.hash),
    )
    .slice(0, PROFILE_CAST_LIMIT)
    .map(
      (
        cast,
      ) => `<article class="fiddy-crawler-post" data-fiddy-crawler-post="${escapeHtml(cast.hash)}">
  <p>${escapeHtml(cast.text)}</p>
  <a href="${escapeHtml(`${origin}/~/conversations/${cast.hash}`)}">Read this post on Fiddy</a>
</article>`,
    )
    .join('\n');
  const latest = !Array.isArray(casts)
    ? "<p>Latest posts aren't available right now.</p>"
    : posts
      ? posts
      : '<p>No posts here yet.</p>';
  const crawlerHtml = `<section class="fiddy-crawler-profile" data-fiddy-crawler aria-labelledby="fiddy-crawler-name">
  <main>
    <h1 id="fiddy-crawler-name">${escapeHtml(name)}</h1>
    <p class="fiddy-crawler-handle">${escapeHtml(handle)}</p>
    ${bio ? `<p class="fiddy-crawler-bio">${escapeHtml(bio)}</p>` : ''}
    <p class="fiddy-crawler-feed">Every profile here has a feed. Copy <a href="${escapeHtml(`${url}/rss`)}">this link</a> into any feed reader and you get the new casts without opening Fiddy, without signing in.</p>
    <h2>Latest posts</h2>
    ${latest}
  </main>
</section>`;
  const crawlerStyle = `<style>
body>noscript{display:none}
#shell-skeleton{display:none}
html{background:#161715}
.fiddy-crawler-profile{box-sizing:border-box;min-height:100vh;background:#161715;color:#eef0e8;font-family:Inter,ui-rounded,system-ui,sans-serif;line-height:1.55}
.fiddy-crawler-profile main{box-sizing:border-box;width:100%;max-width:680px;margin:0 auto;padding:32px 20px 56px}
.fiddy-crawler-profile h1{margin:0;font-size:28px;line-height:1.2;overflow-wrap:anywhere}
.fiddy-crawler-profile h2{margin:36px 0 12px;font-size:20px}
.fiddy-crawler-handle{margin:6px 0 0;color:#9ba193}
.fiddy-crawler-bio{margin:20px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.fiddy-crawler-post{margin:0 0 12px;padding:18px;border:1px solid rgba(255,255,255,.09);border-radius:18px;background:#1d1e1c}
.fiddy-crawler-post p{margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.fiddy-crawler-post a,.fiddy-crawler-feed a{color:#d4ff3f;text-underline-offset:3px}
.fiddy-crawler-feed{margin:20px 0 0}
@media(min-width:640px){.fiddy-crawler-profile main{padding:48px 28px 72px}.fiddy-crawler-profile h1{font-size:34px}}
</style>`;
  return { jsonLd, crawlerHtml, crawlerStyle };
};
