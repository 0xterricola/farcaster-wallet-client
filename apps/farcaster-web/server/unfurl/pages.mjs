/**
 * What each kind of page SAYS — the words, for both the tags and the card.
 *
 * One function per surface, and both consumers read the same object: the head
 * the crawler gets and the picture drawn for it cannot disagree, because they
 * are made from one description of the page. Every field is either something
 * that was read (a handle, the words a cast actually has, a published bio) or
 * something this host can be held to (its own URL, the card it just drew).
 *
 * What is deliberately NOT here: follower counts, avatar pictures, engagement.
 * A card is a claim about a page, and a claim has to come from somewhere.
 */

import { oneLine } from './shellMeta.mjs';

/** `@dwr`, or `fid 3` when the account has no name to print. */
const handleOf = (author) =>
  author?.username ? `@${author.username}` : `fid ${author?.fid ?? ''}`.trim();

const displayOf = (author) => author?.displayName?.trim() || handleOf(author);

export const castPage = ({ origin, hash, cast, author }) => {
  const handle = handleOf(author);
  const words = oneLine(cast.text, 110);
  const title = words ? `${handle}: ${words}` : `A cast by ${handle}`;
  const description = `${displayOf(author)} on Farcaster.`;
  return {
    kind: 'cast',
    url: `${origin}/~/conversations/${hash}`,
    title: oneLine(title, 140),
    description,
    imageAlt: words
      ? `The Fiddy mascot on a dark card reading “${oneLine(words, 90)}”, by ${handle}.`
      : `The Fiddy mascot on a dark card, for a cast by ${handle}.`,
    type: 'article',
    card: {
      kind: 'cast',
      hash,
      text: cast.text,
      username: author?.username,
      displayName: author?.displayName,
      fid: author?.fid,
    },
  };
};

export const profilePage = ({ origin, fid, author }) => {
  const handle = handleOf(author);
  const name = displayOf(author);
  const bio = oneLine(author?.bio, 200);
  return {
    kind: 'profile',
    url: `${origin}/~/profiles/${fid}`,
    title: `${name} (${handle})`,
    description: bio || `${handle} on Farcaster.`,
    imageAlt: `The Fiddy mascot on a dark card, for ${name} (${handle}).`,
    type: 'profile',
    card: {
      kind: 'profile',
      fid,
      username: author?.username,
      displayName: author?.displayName,
      bio: author?.bio,
    },
  };
};

/**
 * A LOOK someone shared (`/look/<id>`): the page a look's link is.
 *
 * The words come from the look itself and from whoever carried it — never from
 * nothing. A look with no name is "A look for Fiddy" rather than an invented
 * one, and the description says what the thing is good for (put it on), in the
 * product's own voice: no "theme", no "hex", no "hash".
 *
 * `imageAlt` describes the card the host drew for this page, because the tag is
 * a promise about a picture: this one is drawn in the look's OWN colours, which
 * is the whole point of it.
 */
export const lookPage = ({ origin, id, look }) => {
  const name =
    typeof look?.name === 'string' && look.name.trim()
      ? look.name.trim()
      : undefined;
  const title = name ? `${name} — a look for Fiddy` : 'A look for Fiddy';
  const description =
    'Colours, corners and type someone chose for Fiddy. Put it on in one press.';
  return {
    kind: 'look',
    url: `${origin}/look/${id}`,
    title: oneLine(title, 140),
    description,
    imageAlt: name
      ? `A card in the look's own colours, reading \u201c${oneLine(name, 60)}\u201d.`
      : "A card in the look's own colours.",
    type: 'website',
    card: {
      kind: 'look',
      id,
      look,
    },
  };
};
