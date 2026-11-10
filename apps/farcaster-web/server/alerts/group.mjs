/**
 * Turning "things that happened to you" into the fewest, warmest pushes.
 *
 * A reader who gets eleven separate buzzes for eleven likes turns the feature
 * off. So the loop below is the whole editorial policy, and it is pure — no
 * clock, no network, no disk — which is why it can be held to a unit test:
 *
 *   1. **dedupe first.** An id already in the store's `sent` window never comes
 *      back, so a node that answers the same page twice cannot buzz twice.
 *   2. **likes group per cast.** "Maya and 4 others liked your cast". Recasts
 *      are NOT derived by this client (`snapchain/nodeApi/reads.ts` does not
 *      read them), so no push ever claims one — upstream groups them because
 *      their server derives them; ours does not, and the copy does not lie.
 *   3. **follows group together.** "Maya and 3 others followed you".
 *   4. **a reply or a mention is its own push.** It carries words you want to
 *      read, and folding two people's sentences into one line makes both worse.
 *   5. **four, then one "N more".** At most CAP pushes reach one reader in one
 *      window; everything past the fourth becomes a single line that opens
 *      Notifications. A newer push with the same `tag` replaces the older one on
 *      the phone (`renotify`), so a burst is a moving count rather than a stack.
 *
 * THE IDS ARE DERIVED FROM THE PROTOCOL MESSAGE, not invented here: a like is
 * `reaction:<hash>:<actorFid>`, a reply is `cast:<hash>`, a follow is
 * `follow:<actorFid>`. They are stable across restarts, which is what makes the
 * dedupe window mean anything at all.
 */

/** At most this many pushes reach one reader per window. */
export const MAX_PUSHES_PER_WINDOW = 4;

/** The window the cap is counted in. */
export const PUSH_WINDOW_MS = 60 * 1000;

/** How many names a grouped line spells out before it counts the rest. */
const NAMES_SPELLED = 1;

/** The copy. English only, and the setting says so; a language tag is stored. */
const COPY = {
  en: {
    likeOne: (name) => `${name} liked your cast`,
    likeMany: (name, others) => `${name} and ${others} ${others === 1 ? 'other' : 'others'} liked your cast`,
    reply: (name) => `${name} replied to you`,
    mention: (name) => `${name} mentioned you`,
    followOne: (name) => `${name} followed you`,
    followMany: (name, others) => `${name} and ${others} ${others === 1 ? 'other' : 'others'} followed you`,
    more: (count) => `${count} more ${count === 1 ? 'notification' : 'notifications'}`,
    moreTitle: () => 'More waiting for you',
  },
};

const copyFor = (language) => COPY[language] ?? COPY.en;

/** "Maya", or "someone" when the name was never read. */
const nameOf = (actor) => actor?.name?.trim() || actor?.username?.trim() || 'Someone';

const pluralOthers = (count) => count;

/**
 * One line for a group of actors: the first name spelled out, the rest counted.
 * A group of one is the plain sentence.
 */
const together = (names, one, many) => {
  const unique = [...new Set(names)];
  if (unique.length === 0) {
    return many('Someone', 1);
  }
  if (unique.length === 1) {
    return one(unique[0]);
  }
  return many(unique[0], pluralOthers(unique.length - 1));
};

/**
 * @typedef {object} AlertItem
 * @property {string} id          stable across restarts; the dedupe key
 * @property {string} kind        mentions | replies | likes | follows (see `derive.mjs`)
 * @property {number} [at]        milliseconds since the epoch
 * @property {{fid:number, name?:string, username?:string}} actor
 * @property {string} [castHash]
 * @property {string} [castText]
 *
 * @typedef {object} Push
 * @property {string} title
 * @property {string} body
 * @property {string} url   where tapping it goes
 * @property {string} kind
 * @property {string} tag   a newer push with the same tag replaces the older
 */

/**
 * The pushes for one reader this tick.
 *
 * @param {object} input
 * @param {AlertItem[]} [input.items]
 *   Everything the node reported, newest first or not — order does not matter.
 * @param {Array<{id:string, at:number}>} [input.sent]   The dedupe window.
 * @param {number} [input.now]
 * @param {string} [input.language]
 * @returns {{pushes: Push[], delivered: string[]}}
 *   `delivered` is every id the caller should add to the sent window. It is
 *   what the caller actually sent PLUS what it folded away inside a group, so
 *   the next tick does not re-derive them as new.
 */
export const groupActivity = ({
  items = [],
  sent = [],
  now = Date.now(),
  language = 'en',
}) => {
  const copy = copyFor(language);
  const alreadySent = new Set(sent.map((entry) => entry.id));

  const fresh = items
    .filter((item) => item && typeof item.id === 'string' && !alreadySent.has(item.id))
    // Newest first: what a reader cares about most is what just happened.
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  /** @type {Array<{at:number, order:number, push:object, ids:string[]}>} */
  const candidates = [];
  let order = 0;
  const add = (at, push, ids) => {
    candidates.push({ at, order: (order += 1), push, ids });
  };

  const replies = fresh.filter((item) => item.kind === 'reply');
  const mentions = fresh.filter((item) => item.kind === 'mention');
  const follows = fresh.filter((item) => item.kind === 'follow');
  const likes = fresh.filter((item) => item.kind === 'like');

  // A reply and a mention are each their own push, newest first, and each
  // carries the words so the phone shows something worth opening.
  for (const item of [...replies, ...mentions]) {
    const name = nameOf(item.actor);
    const body =
      item.kind === 'reply' ? copy.reply(name) : copy.mention(name);
    add(
      item.at ?? now,
      {
        title: name,
        body: item.castText ? `${body}: ${trim(item.castText)}` : body,
        url: item.castHash ? `/c/${item.castHash}` : '/notifications',
        kind: item.kind,
        tag: `${item.kind}:${item.id}`,
      },
      [item.id],
    );
  }

  // Follows: one line for the lot.
  if (follows.length > 0) {
    const names = follows.map((item) => nameOf(item.actor));
    add(
      Math.max(...follows.map((item) => item.at ?? now)),
      {
        title: 'New follower',
        body: together(names, copy.followOne, copy.followMany),
        url: '/notifications',
        kind: 'follow',
        tag: 'follow',
      },
      follows.map((item) => item.id),
    );
  }

  // Likes: one line per cast, so two different casts are two different lines.
  const byCast = new Map();
  for (const item of likes) {
    const key = item.castHash ?? 'somewhere';
    const group = byCast.get(key) ?? [];
    group.push(item);
    byCast.set(key, group);
  }
  for (const [castHash, group] of byCast) {
    const names = group.map((item) => nameOf(item.actor));
    add(
      Math.max(...group.map((item) => item.at ?? now)),
      {
        title: 'New like',
        body: together(
          names.slice(0, NAMES_SPELLED).concat(names.slice(NAMES_SPELLED)),
          copy.likeOne,
          copy.likeMany,
        ),
        url: castHash.startsWith('0x') ? `/c/${castHash}` : '/notifications',
        kind: 'like',
        tag: `like:${castHash}`,
      },
      group.map((item) => item.id),
    );
  }

  const ranked = candidates.sort((a, b) => b.at - a.at || a.order - b.order);
  const kept = ranked.slice(0, MAX_PUSHES_PER_WINDOW);
  const folded = ranked.slice(MAX_PUSHES_PER_WINDOW);

  const pushes = kept.map((entry) => entry.push);
  const delivered = kept.flatMap((entry) => entry.ids);

  if (folded.length > 0) {
    const count = folded.reduce((total, entry) => total + entry.ids.length, 0);
    pushes.push({
      title: copy.moreTitle(),
      body: copy.more(count),
      url: '/notifications',
      kind: 'more',
      // One tag for the whole burst: a later "N more" replaces the earlier one.
      tag: 'more',
    });
    delivered.push(...folded.flatMap((entry) => entry.ids));
  }

  return { pushes, delivered };
};

/** A cast's words, cut where a phone would cut them anyway. */
const trim = (text) => {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= 90 ? clean : `${clean.slice(0, 89)}…`;
};