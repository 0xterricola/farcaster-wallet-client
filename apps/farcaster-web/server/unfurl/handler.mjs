/**
 * The route table, as a function of the request — no sockets, no globals.
 *
 * Everything a request can do is decided here, which is what makes the service
 * testable without a network and without a browser: `server.mjs` is the thin
 * part that turns a socket into a call and the answer into bytes.
 *
 * The contract with the host, in one sentence: **this service answers a cast or
 * profile URL with the shell the release ships, or with the shell plus that
 * page's tags; it never answers with a document of its own invention.** A page
 * it cannot read is not an error page — it is the shell, unchanged, exactly
 * what the host served before this service existed. That is what makes the
 * nginx fallback and the honest-miss path the same thing.
 *
 * As of card t_bb7cca3b it also answers two JSON routes — `POST /api/translate`,
 * `POST /api/translations` and the `GET /api/translate` capability probe — for
 * cast translations (`../translate/translate.mjs`). They are the same kind of
 * promise: the cast's words are read from the node HERE, and a host that cannot
 * translate says `{on:false}` instead of answering a page with an invented one.
 */

import { cardUrl, pageTags, renderPageHtml } from './shellMeta.mjs';
import { castPage, lookPage, profilePage } from './pages.mjs';
import { lookFacts, shareableLook } from './looks.mjs';
import { CARD_HEIGHT, CARD_WIDTH } from './cards.mjs';
import {
  createRateLimiter,
  translationRefusal,
} from '../translate/translate.mjs';

const HTML_TTL_MS = 5 * 60 * 1000;
const MISS_TTL_MS = 30 * 1000;
const CARD_TTL_MS = 60 * 60 * 1000;
const AUTHOR_TTL_MS = 60 * 60 * 1000;

/**
 * How many times a card is drawn before the page is answered with the site card.
 *
 * Two, not one: the renderer is a python3 subprocess, and a machine under load
 * can fail the spawn, blow the deadline or lose its interpreter without
 * anything being wrong with the build. Measured 2026-10-23 (load average ~13,
 * card t_7413507e): a release refused twice on the CARDS alone — `card:site`
 * for both pages — while the same self-check by hand on the same stage passed
 * minutes later and a third run shipped. A single retry turns that class of
 * refusal into a pass, and it does NOT hide a real one: both attempts have to
 * fail before the site card is served, and the note says so.
 */
const CARD_ATTEMPTS = 2;
/** A yield, not a backoff: a spawn that failed instantly (EAGAIN under load) has a moment. */
const CARD_RETRY_PAUSE_MS = 250;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A value that can be written into a response header.
 *
 * The note carries a renderer's own words, and a message with a newline in it
 * (a spawn error, the tail of a python traceback) makes `writeHead` throw — a
 * card on the fallback path would then be a 500 instead of a picture. One line,
 * printable, bounded. The same string goes in the header, the health JSON, the
 * service log and the self-check's output, so the gate and the service cannot
 * disagree about why a card fell back.
 */
const headerNote = (value, max = 300) => {
  const line = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\r\n\t\v\f\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[^\x20-\x7e]+/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};

const text = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  body,
});

/** A JSON answer, with the same no-store discipline the health route uses. */
const json = (status, value, headers = {}) => ({
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  },
  body: `${JSON.stringify(value)}\n`,
});

export const createUnfurlHandler = ({
  origin = 'https://fiddy.fun',
  shellSource,
  siteCard,
  renderCard,
  reader,
  /**
   * Where shared looks live (`looks.mjs`), or nothing.
   *
   * A host that cannot store a look still renders one it has: this is the only
   * difference, and it is why the route table below can answer `GET` without
   * one. A missing store is `undefined` rather than an error, so a self-hosted
   * copy without the service's state directory serves the app and its look
   * links refuse in one sentence.
   */
  looks,
  /**
   * Cast translations (`../translate/translate.mjs`), or nothing.
   *
   * A host with no translator is a host whose `GET /api/translate` answers
   * `{on:false}` — which is what the browser asks before drawing any control,
   * so the app degrades honestly instead of offering a button that 404s.
   */
  translator,
  /**
   * How much translation traffic one caller may make: an ask is a model call on
   * somebody else's free tier, a lookup is a disk read of what is already kept.
   */
  translationLimits = {
    ask: { max: 30, windowMs: 10 * 60 * 1000 },
    lookup: { max: 300, windowMs: 10 * 60 * 1000 },
  },
  now = () => Date.now(),
  htmlTtlMs = HTML_TTL_MS,
  missTtlMs = MISS_TTL_MS,
  cardTtlMs = CARD_TTL_MS,
  authorTtlMs = AUTHOR_TTL_MS,
}) => {
  /** Two windows: a page that exists is worth caching, a miss is not. */
  const htmlCache = new Map();
  const cardCache = new Map();
  const authorCache = new Map();

  const cached = (map, key, ttlMs, load) => {
    const hit = map.get(key);
    if (hit && now() - hit.at < hit.ttlMs) {
      return Promise.resolve(hit);
    }
    return Promise.resolve(load()).then((value) => {
      if (map.size >= 500) {
        map.delete(map.keys().next().value);
      }
      const entry = {
        at: now(),
        ttlMs: value?.ok ? ttlMs : missTtlMs,
        ...value,
      };
      map.set(key, entry);
      return entry;
    });
  };

  /**
   * The last few cards that fell back to the site card, with the reason each
   * one did. Bounded, newest last, and reported by `/unfurl/health`: a person
   * looking at this service — or at a refused release that asked it — must be
   * able to tell a starved renderer from a broken card.
   */
  const cardFallbacks = [];
  const rememberCardFallback = (key, note) => {
    cardFallbacks.push({
      key,
      at: new Date(now()).toISOString(),
      note: headerNote(note),
    });
    if (cardFallbacks.length > 5) {
      cardFallbacks.shift();
    }
  };

  const png = (buffer, note, cause) => ({
    status: 200,
    headers: {
      'content-type': 'image/png',
      'cache-control': `public, max-age=${Math.floor(cardTtlMs / 1000)}`,
      'content-length': String(buffer.length),
      'x-unfurl': note,
      ...(cause ? { 'x-unfurl-note': headerNote(cause) } : {}),
    },
    body: buffer,
  });

  /**
   * A card, or the site card, or — if even that is missing — a 503.
   *
   * The site card is the fallback on purpose: it is 1200x630, it is this
   * product's art, and it is the picture this URL unfurled with yesterday. What
   * it is NOT is an answer that explains itself, so the reason travels with it:
   * `x-unfurl-note` on the response, the same line in the health JSON, in the
   * service's log, and printed by the release self-check. A release that
   * refuses on the cards now says whether the reader, the renderer or neither
   * was at fault.
   */
  const card = async (kind, id, buildPayload, aspect = 'og') => {
    const key = `${kind}:${id}${aspect === '3x2' ? ':3x2' : ''}`;
    const entry = await cached(cardCache, key, cardTtlMs, async () => {
      let payload;
      try {
        // `buildPayload` is a function returning a PROMISE of this page's card
        // description (`reader.cast(hash).then(…)`), so it is awaited here: the
        // renderer takes a payload, and handing it an unresolved promise is a
        // card the renderer cannot read a kind out of — every page then answers
        // the SITE card while sounding like it drew its own.
        payload = await buildPayload();
      } catch (error) {
        // A page that could not be READ is not a renderer that could not DRAW,
        // and the note says which: the first is a fact about this page (there is
        // no card for it), the second a fact about this machine.
        return {
          ok: false,
          note: `card failed, this page's own facts could not be read: ${error.message}`,
          png: undefined,
        };
      }
      const attempts = [];
      for (let attempt = 1; attempt <= CARD_ATTEMPTS; attempt += 1) {
        try {
          return {
            ok: true,
            png: await renderCard(
              aspect === '3x2' ? { ...payload, aspect: '3x2' } : payload,
            ),
            attempt,
          };
        } catch (error) {
          attempts.push(error.message);
          if (attempt < CARD_ATTEMPTS) {
            await pause(CARD_RETRY_PAUSE_MS);
          }
        }
      }
      return {
        ok: false,
        note:
          `card failed, the renderer did not draw it in ${CARD_ATTEMPTS} attempts: ` +
          attempts.join(' | '),
        png: undefined,
      };
    });
    if (entry.png) {
      return png(entry.png, `card:${kind}`);
    }
    const cause = entry.note ?? 'the card route recorded no reason';
    rememberCardFallback(key, cause);
    const fallback = typeof siteCard === 'function' ? siteCard() : siteCard;
    if (fallback?.length) {
      return png(fallback, 'card:site', cause);
    }
    return text(503, `no card for ${key}\n`, {
      'x-unfurl': 'card:unavailable',
      'x-unfurl-note': headerNote(cause),
    });
  };

  /** The shell, with this page's head when the page could be read. */
  const page = async (path, resolve) => {
    const entry = await cached(htmlCache, path, htmlTtlMs, async () => {
      try {
        const facts = await resolve();
        if (!facts) {
          return { ok: false };
        }
        const cardId =
          // One place, three kinds: a cast is its hash, a profile its fid, a
          // look the id of the checked body it was stored under.
          facts.kind === 'look'
            ? facts.card.id
            : facts.kind === 'cast'
              ? facts.card.hash
              : facts.card.fid;
        const tags = pageTags({
          ...facts,
          origin,
          imageUrl: cardUrl(origin, facts.kind, cardId),
          embedImageUrl: cardUrl(origin, facts.kind, cardId, true),
          buttonTitle: `Open this ${facts.kind} in fiddy`,
        });
        return {
          ok: true,
          html: renderPageHtml(shellSource(), tags),
          kind: facts.kind,
        };
      } catch {
        // A source that failed is not a page that does not exist; either way the
        // answer is the shell, because a reader is about to load the app.
        return { ok: false };
      }
    });
    if (entry.ok) {
      return {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300, no-transform',
          'x-unfurl': `page:${entry.kind ?? 'page'}`,
        },
        body: entry.html,
      };
    }
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300, no-transform',
        'x-unfurl': 'shell',
      },
      body: shellSource(),
    };
  };

  // One window per caller per kind (`../translate/translate.mjs`). The key is
  // the address nginx forwarded; a caller behind a shared address shares a
  // window, which is the honest reading of a limit that cannot know better.
  const spentOnAsking = createRateLimiter({ ...translationLimits.ask, now });
  const spentOnLooking = createRateLimiter({
    ...translationLimits.lookup,
    now,
  });

  /** A refused ask, in the app's own voice, whatever went wrong inside. */
  const translationAnswer = (error) => {
    if (error?.status) {
      return json(error.status, { error: error.message });
    }
    process.stderr.write(`translate: ${error?.stack ?? error}\n`);
    return json(500, { error: "Couldn't translate that right now." });
  };

  /** A body this service reads as JSON, or a refusal. Never a stack trace. */
  const askedFor = (raw) => {
    try {
      const parsed = JSON.parse(String(raw ?? ''));
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('not an object');
      }
      return parsed;
    } catch {
      throw translationRefusal(400, 'Bad request.');
    }
  };

  return {
    /**
     * @param {{method: string, path: string, body?: string, ip?: string}} request
     * @returns {Promise<{status: number, headers: Record<string,string>, body: string|Buffer}>}
     */
    async handle({ method, path, body, ip }) {
      const [, ...segments] = path.split('?')[0].split('/');

      // A shared look is the ONE thing anyone can send here, and it is a
      // checked body or a refusal (`looks.mjs`). `body` is read by the caller
      // (capped) so this stays testable without a socket.
      // (`segments` is the path's parts after the leading slash: `/look` is
      // one part, `/look/<id>` is two.)
      if (
        method === 'POST' &&
        segments[0] === 'look' &&
        segments.length === 1
      ) {
        if (!looks) {
          return json(503, {
            error: "Fiddy can't save looks on this host right now.",
          });
        }
        const shareable = shareableLook(body);
        if (!shareable.ok) {
          return json(shareable.status, { error: shareable.error });
        }
        try {
          const { id } = await looks.put(shareable.body);
          return json(200, { id });
        } catch (error) {
          // The store failed (a full disk, a read-only directory). Say so; a
          // stored look is immutable, so nothing half-written can be read back
          // as one — the id IS the contents.
          return json(503, {
            error: "Fiddy couldn't save that look just now.",
            why: headerNote(error?.message ?? String(error)),
          });
        }
      }

      // Cast translations (`../translate/translate.mjs`). The browser decides a
      // cast is in another language and asks here; the cast's words are read
      // FROM THE NODE by this service, translated once per language and kept,
      // so the answer is the same for every reader afterwards.
      if (
        segments[0] === 'api' &&
        segments.length === 2 &&
        (segments[1] === 'translate' || segments[1] === 'translations')
      ) {
        const one = segments[1] === 'translate';
        // Whether translating is set up on THIS host. The browser asks before
        // it draws anything: a host with no model key and a self-hosted copy
        // with no service at all both answer "no", and no control appears.
        if (one && (method === 'GET' || method === 'HEAD')) {
          return json(
            200,
            { on: Boolean(translator?.available()) },
            { 'cache-control': 'public, max-age=300' },
          );
        }
        if (method !== 'POST') {
          return json(405, { error: 'POST' });
        }
        if (!translator) {
          return json(503, {
            error: "Translation isn't set up on this host yet.",
          });
        }
        const over = one ? spentOnAsking(ip) : spentOnLooking(ip);
        if (over) {
          return json(429, {
            error: 'Too many translations at once, try again in a few minutes.',
          });
        }
        try {
          const asked = askedFor(body);
          return json(
            200,
            one
              ? await translator.translate(asked)
              : await translator.lookup(asked),
          );
        } catch (error) {
          return translationAnswer(error);
        }
      }

      if (method !== 'GET' && method !== 'HEAD') {
        return text(405, 'only GET\n');
      }

      // A shared look, as the data the app reads (`/look/<id>.json`) or as the
      // page a crawler reads (`/look/<id>`, below with the cast and profile
      // pages). Both come from the same checked body.
      if (segments[0] === 'look' && segments[1]) {
        let raw;
        try {
          raw = decodeURIComponent(segments[1]);
        } catch {
          // A segment that is not text is not a look id; the answer is the same
          // one an unknown id gets.
          raw = '';
        }
        const wantsJson = raw.toLowerCase().endsWith('.json');
        const id = wantsJson ? raw.slice(0, -'.json'.length) : raw;

        const look = looks ? await looks.get(id) : undefined;
        if (wantsJson) {
          return look
            ? json(200, { id, look })
            : json(404, {
                // One sentence, in the app's own voice: the same one the client
                // shows, so a link that cannot be read says the same thing
                // wherever it is read.
                error: "That look link doesn't work any more.",
              });
        }

        // `by` deliberately does NOT come from the query string. A page that
        // credited whoever the URL named would let anyone put anyone's handle on
        // a look; the app's card names the author of the CAST that carried the
        // link instead, which is a fact this host can be held to.
        return page(`/look/${id}`, async () =>
          look ? lookPage({ origin, id, look }) : undefined,
        );
      }

      if (segments[0] === 'unfurl' && segments[1] === 'health') {
        return {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
          body: `${JSON.stringify({
            ok: true,
            origin,
            shellBytes: shellSource().length,
            siteCard: Boolean(
              typeof siteCard === 'function' ? siteCard() : siteCard,
            ),
            reads: reader.size?.() ?? 0,
            html: htmlCache.size,
            cards: cardCache.size,
            // A page answered with the site card is a page whose card route
            // failed; the reason is here rather than only in a log nobody kept.
            cardFallbacks: cardFallbacks.length,
            lastCardFallback: cardFallbacks[cardFallbacks.length - 1] ?? null,
            // Whether cast translations are set up here, and what they hold: a
            // host with no model key says so in one field instead of looking
            // like a service whose translate route is broken.
            translations: translator
              ? { on: translator.available(), ...translator.sizes() }
              : 'off',
          })}\n`,
        };
      }

      // The client's own question: which account wrote this cast? The reader's
      // node cannot answer it (a Snapchain node shards by FID), so the origin
      // that already had to answer it for the crawler answers it here too.
      if (
        segments[0] === 'unfurl' &&
        segments[1] === 'cast-author' &&
        segments[2]
      ) {
        const hash = decodeURIComponent(segments[2]);
        const key = hash.toLowerCase();
        const entry = await cached(authorCache, key, authorTtlMs, async () => {
          try {
            const facts = await reader.cast(hash);
            return facts
              ? { ok: true, fid: facts.cast.fid }
              : { ok: false, fid: undefined };
          } catch {
            return { ok: false, fid: undefined };
          }
        });
        if (entry.fid === undefined) {
          return {
            status: 404,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-unfurl': 'author:miss',
            },
            body: `${JSON.stringify({ hash, fid: null, why: 'no index on this origin knows that cast hash' })}\n`,
          };
        }
        return {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-unfurl': 'author',
          },
          body: `${JSON.stringify({ hash, fid: entry.fid })}\n`,
        };
      }

      if (
        segments[0] === 'unfurl' &&
        segments[1] === 'cards' &&
        segments[2] &&
        segments[3]
      ) {
        const kind = segments[2];
        const match = /^(.*?)(\.3x2)?\.png$/i.exec(segments[3]);
        const id = decodeURIComponent(match?.[1] ?? segments[3]);
        const aspect = match?.[2] ? '3x2' : 'og';
        if (kind === 'cast') {
          return card(
            'cast',
            id.toLowerCase(),
            () =>
              reader.cast(id).then((facts) => {
                if (!facts) {
                  throw new Error('that cast could not be read');
                }
                return castPage({ origin, hash: id, ...facts }).card;
              }),
            aspect,
          );
        }
        if (kind === 'profile') {
          return card(
            'profile',
            id,
            () =>
              reader.profile(id).then((facts) => {
                if (!facts) {
                  throw new Error('that profile could not be read');
                }
                return profilePage({ origin, fid: id, ...facts }).card;
              }),
            aspect,
          );
        }
        if (kind === 'look') {
          return card(
            'look',
            id,
            async () => {
              const look = looks ? await looks.get(id) : undefined;
              if (!look) {
                throw new Error('that look is not stored here');
              }
              return { kind: 'look', ...lookFacts({ id, look }) };
            },
            aspect,
          );
        }
      }

      if (
        segments[0] === '~' &&
        segments[1] === 'conversations' &&
        segments[2]
      ) {
        const hash = decodeURIComponent(segments[2]);
        return page(`/~/conversations/${hash}`, async () => {
          const facts = await reader.cast(hash);
          return facts
            ? { ...castPage({ origin, hash, ...facts }) }
            : undefined;
        });
      }

      if (segments[0] === '~' && segments[1] === 'profiles' && segments[2]) {
        const fid = decodeURIComponent(segments[2]);
        return page(`/~/profiles/${fid}`, async () => {
          const facts = await reader.profile(fid);
          return facts
            ? { ...profilePage({ origin, fid, ...facts }) }
            : undefined;
        });
      }

      // Every OTHER route under the app's own prefix (`/~/conversations/<hash>/
      // reactions`, `/~/profiles/<fid>/followers`, `/~/settings`, …) is a route
      // the client serves itself. nginx routes the whole family here, so the
      // shell is the answer — with the site's own tags, which is what those
      // pages have today, and a page a reader can still use.
      if (segments[0] === '~') {
        return {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=300, no-transform',
            'x-unfurl': 'shell',
          },
          body: shellSource(),
        };
      }

      return text(404, 'not this service\n', { 'x-unfurl': 'not-found' });
    },
    /** What the host would need to know that this handler holds no state. */
    sizes: () => ({
      html: htmlCache.size,
      cards: cardCache.size,
      authors: authorCache.size,
      cardFallbacks: cardFallbacks.length,
    }),
    cardSize: { width: CARD_WIDTH, height: CARD_HEIGHT },
  };
};
