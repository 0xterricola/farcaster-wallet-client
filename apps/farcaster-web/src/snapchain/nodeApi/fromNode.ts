/**
 * Node messages → the shapes the fork's own components already read.
 *
 * `farcaster-client-data` types every response of the hosted client API. Those
 * types are what the pages, the hooks and the cast renderer were built against
 * — so a node-backed client has to hand back the same shapes, or every page
 * needs rewriting. This module is that translation, and it is deliberately the
 * only place that knows the node speaks `MESSAGE_TYPE_CAST_ADD` while the UI
 * speaks `ApiCast`.
 *
 * WHAT IS HONEST HERE, AND WHAT IS A FLOOR
 *
 * - Text, timestamps, embeds, the author's handle / display name / avatar / bio
 *   and the reply graph are protocol messages: exact.
 * - A cast's mentions are exact as FIDs and *read* as handles. The protocol
 *   stores a placeholder where each handle belongs and names the position in
 *   bytes (`mentions` + `mentionsPositions`); the handle itself is the mentioned
 *   account's own user data, so a mention is only rendered once that account has
 *   been read. With no profile the fid floor stands and the text keeps its
 *   placeholder — never an invented handle, and never one tagged person shown
 *   where the cast names five.
 * - Which bucket an embed lands in is *measured*, not exact: the protocol sends
 *   a bare URL, so the URL's own media type is asked for over the network
 *   (`embedKinds.ts`, one bounded probe per URL, cached). A URL nothing can
 *   answer for stays a link card — the floor here is "a link", never "an image
 *   we hoped for".
 * - Engagement counts (`reactions`, `recasts`) and link counts (followers,
 *   following) are counted by paging the node, capped (see `reads.ts`). A count
 *   is therefore exact while it is under the cap and a floor above it. The cap
 *   is high enough that the difference never shows on a normal account, and
 *   `countsAreFloors` travels with the value so a caller can say so.
 * - `watches` (view counts) and `viewerContext` beyond reactions come from the
 *   hosted indexer and are left absent rather than guessed at zero.
 * - A quote embed is a real read (`castById` on the quoting cast's target);
 *   if that read fails the embed degrades to `unknowns` with the target named,
 *   never to an empty box.
 */

import {
  ApiCast,
  ApiCastClient,
  ApiCastEmbeds,
  ApiCastFeedItem,
  ApiCastImageEmbed,
  ApiCastUnknownEmbed,
  ApiCastUrlEmbed,
  ApiCastVideoEmbed,
  ApiChannelMinimal,
  ApiQuoteCastEmbed,
  ApiUser,
  ApiUserMinimal,
} from 'farcaster-client-data';
import {
  type ClientIdentity,
  type NodeCastAddBody,
  type NodeMessage,
  type NodeUserDataBody,
  utf8ByteLength,
} from 'farcaster-node-client';

import { type EmbedCard, openGraphFromCard } from './embedCards';
import { type EmbedKindAnswer, embedKindFromExtension } from './embedKinds';

/** Zero-safe count with the caveat that produced it. */
export interface NodeCount {
  value: number;
  /** True when paging stopped at the cap, so `value` is a lower bound. */
  isFloor: boolean;
}

export const exactCount = (value: number): NodeCount => ({
  value,
  isFloor: false,
});
export const floorCount = (value: number): NodeCount => ({
  value,
  isFloor: true,
});

const userDataValue = (
  messages: NodeMessage[],
  type: NodeUserDataBody['userDataType'],
): string | undefined => {
  // Later messages supersede earlier ones for the same field: user data is a
  // log, and the newest value is the current one.
  let value: string | undefined;
  for (const message of messages) {
    if (
      message.userData?.userDataType === type &&
      message.userData.value !== ''
    ) {
      value = message.userData.value;
    }
  }
  return value;
};

export interface ApiUserFromNodeOptions {
  fid: number;
  /** Every USER_DATA_ADD message for this FID, oldest first. */
  userData: NodeMessage[];
  followerCount?: NodeCount;
  followingCount?: NodeCount;
  viewerContext?: ApiUser['viewerContext'];
}

/**
 * A profile as the fork's `ApiUser`. Every field that exists comes from the
 * account's own user-data messages; a missing field stays missing rather than
 * being filled with a placeholder that would read as real.
 */
export const apiUserFromNode = ({
  fid,
  userData,
  followerCount,
  followingCount,
  viewerContext,
}: ApiUserFromNodeOptions): ApiUser => {
  const username = userDataValue(userData, 'USER_DATA_TYPE_USERNAME');
  const displayName = userDataValue(userData, 'USER_DATA_TYPE_DISPLAY');
  const bio = userDataValue(userData, 'USER_DATA_TYPE_BIO') ?? '';
  const pfpUrl = userDataValue(userData, 'USER_DATA_TYPE_PFP');
  const url = userDataValue(userData, 'USER_DATA_TYPE_URL');
  const bannerImageUrl = userDataValue(userData, 'USER_DATA_TYPE_BANNER');
  const locationDescription = userDataValue(
    userData,
    'USER_DATA_TYPE_LOCATION',
  );

  const user: ApiUser = {
    fid,
    displayName: displayName ?? username ?? `fid ${fid}`,
    // The fork's type wants counts. They are counted from the node (see
    // reads.ts) and are honest as written: the node is the only source here.
    followerCount: followerCount?.value ?? 0,
    followingCount: followingCount?.value ?? 0,
    profile: {
      bio: { text: bio, mentions: [] },
      ...(url ? { url } : {}),
      ...(bannerImageUrl ? { bannerImageUrl } : {}),
    },
  };

  if (username !== undefined) {
    user.username = username;
  }
  if (pfpUrl !== undefined && pfpUrl !== '') {
    // `verified` is a hosted-API statement about the image host. Nothing here
    // has made that check, so it is false and not an implication.
    user.pfp = { url: pfpUrl, verified: false };
  }
  if (locationDescription) {
    user.profile.location = { placeId: '', description: locationDescription };
  }
  if (viewerContext) {
    user.viewerContext = viewerContext;
  }

  return user;
};

/** A channel as the UI expects it, built from the parent URL a cast carries. */
export const apiChannelMinimalFromParentUrl = (
  parentUrl: string | undefined,
): ApiChannelMinimal | undefined => {
  if (!parentUrl) {
    return undefined;
  }

  // Channels are addressed by a parent URL. Two forms exist on chain:
  // `https://farcaster.xyz/~/channel/<key>` (URL-keyed channels) and
  // `chain://eip155:7777777/erc721:0x…` (channels owned by an NFT). Only the
  // first has a name inside the URL; for the NFT form the key is the address,
  // which is what the node can prove and all this client will claim.
  const urlKeyed = /^https?:\/\/[^/]+\/~\/(?:channel|fc)\/([^/?#]+)/.exec(
    parentUrl,
  );
  if (urlKeyed?.[1]) {
    return { key: urlKeyed[1], name: urlKeyed[1] };
  }

  const chainKeyed = /^chain:\/\/eip155:\d+\/erc721:(0x[0-9a-f]{40})$/i.exec(
    parentUrl,
  );
  if (chainKeyed?.[1]) {
    return { key: parentUrl, name: `channel ${chainKeyed[1].slice(0, 10)}…` };
  }

  return undefined;
};

export interface CastEmbedsFromNodeResult {
  embeds: ApiCastEmbeds;
  /** Quoted casts this caller still has to read (`castById`), by target. */
  quoteTargets: { fid: number; hash: string }[];
}

/**
 * Embeds as the fork's `ApiCastEmbeds`. A URL that is known to be an image goes
 * to `images` (that is the bucket the renderer draws as a photo), one known to
 * be a video goes to `videos`, and everything else goes to `urls` with the URL
 * itself as its open-graph identity (no scraping happens here — an open-graph
 * lookup is a fetch of somebody's page, and this client does not make those).
 *
 * `embedKind` is how a caller hands in what it learned elsewhere: the node
 * adapter resolves each URL's media type ahead of time (`embedKinds.ts`, one
 * bounded probe per URL, cached) and passes the lookup in here. This function
 * stays synchronous and pure so it can be reasoned about — with no lookup the
 * file extension is all it has, and a URL that names no media type stays a
 * link card rather than being guessed into one.
 */
export const castEmbedsFromNode = ({
  body,
  quotedCasts = [],
  embedKind,
  cardOf,
}: {
  body: NodeCastAddBody;
  /** Casts already resolved for `body.embeds` quote targets, by `fid:hash`. */
  quotedCasts?: ApiQuoteCastEmbed[];
  /** What a caller has already learned about a URL's media type. */
  embedKind?: (url: string) => EmbedKindAnswer | undefined;
  /**
   * What a caller has already learned about a link's own page: its title, its
   * picture, and its mini-app card when it declares one (`embedCards.ts`).
   * Absent means the embed keeps the URL as its only open-graph fact.
   */
  cardOf?: (url: string) => EmbedCard | undefined;
}): CastEmbedsFromNodeResult => {
  const images: ApiCastImageEmbed[] = [];
  const videos: ApiCastVideoEmbed[] = [];
  const urls: ApiCastUrlEmbed[] = [];
  const quotes: ApiQuoteCastEmbed[] = [];
  const unknowns: ApiCastUnknownEmbed[] = [];
  const quoteTargets: { fid: number; hash: string }[] = [];

  const quotedByKey = new Map(
    quotedCasts.map((cast) => [`${cast.author.fid}:${cast.hash}`, cast]),
  );

  for (const embed of body.embeds) {
    if ('url' in embed && typeof embed.url === 'string' && embed.url !== '') {
      const kind = embedKind?.(embed.url) ?? embedKindFromExtension(embed.url);
      if (kind === 'image') {
        images.push({
          type: 'image',
          url: embed.url,
          sourceUrl: embed.url,
          alt: '',
        });
      } else if (kind === 'video') {
        videos.push({
          type: 'video',
          url: embed.url,
          sourceUrl: embed.url,
        });
      } else {
        // A link embed carries what its own page said about it — and, when that
        // page is a mini app, the card whose button opens it.
        urls.push({
          type: 'url',
          openGraph: openGraphFromCard(embed.url, cardOf?.(embed.url)),
        });
      }
      continue;
    }

    if ('castId' in embed && embed.castId) {
      const key = `${embed.castId.fid}:${embed.castId.hash}`;
      const quoted = quotedByKey.get(key);
      if (quoted) {
        quotes.push(quoted);
      } else {
        quoteTargets.push({ fid: embed.castId.fid, hash: embed.castId.hash });
        // Named, not silent: the box says which cast it is and why it is not
        // rendered yet, rather than looking like an empty embed.
        unknowns.push({
          type: 'unknown',
          source: `quoted cast ${embed.castId.hash} by fid ${embed.castId.fid}`,
        });
      }
    }
  }

  return {
    embeds: {
      images,
      urls,
      ...(videos.length > 0 ? { videos } : {}),
      ...(quotes.length > 0 ? { casts: quotes } : {}),
      unknowns,
    },
    quoteTargets,
  };
};

/**
 * A mentioned account whose user data has not been read: the fid, said as a
 * fid. The renderer degrades to this rather than to a wrong name.
 */
export const mentionFloorUser = (fid: number): ApiUser => ({
  fid,
  displayName: `fid ${fid}`,
  followerCount: 0,
  followingCount: 0,
  profile: { bio: { text: '', mentions: [] } },
});

/**
 * A full profile as the minimal one a list row carries.
 *
 * Used by the reads that return a list of accounts — a block list is the first:
 * the hosted shapes carry `ApiUserMinimal` next to the fid, and the page turns
 * that back into a row. Nothing is added that the profile read did not have: an
 * account with no picture has no picture.
 */
export const userMinimalFrom = (user: ApiUser): ApiUserMinimal => ({
  fid: user.fid,
  ...(user.username === undefined ? {} : { username: user.username }),
  displayName: user.displayName,
  ...(user.pfp === undefined ? {} : { pfp: user.pfp }),
});

/**
 * The app that made a cast, as `ApiCast.client`.
 *
 * A node-backed read resolves this from the protocol (`clientAttribution`): the
 * signing key's signed key request names an app FID, and that app account's own
 * profile names the app. The shape is the hosted API's own `client` field — a
 * minimal user — so the conversation view's "Sent from …" row and anything else
 * that already reads `cast.client` lights up without knowing where it came from.
 *
 * `fid` is the app FID when there is one; for a key the account requested
 * itself (`own`) or an on-chain key (`onchain`) there is no app, so it is the
 * account's own FID and `kind` is what says so. `displayName` carries the label
 * the cast card shows, which for `own`/`onchain` is a description rather than a
 * name — deliberately, because inventing an app for those would be a lie.
 */
export const apiCastClientFromIdentity = ({
  identity,
  authorFid,
}: {
  identity: ClientIdentity;
  authorFid: number;
}): ApiCastClient => ({
  fid: identity.requestFid ?? authorFid,
  displayName: identity.label,
  ...(identity.username === undefined ? {} : { username: identity.username }),
  ...(identity.pfpUrl === undefined
    ? {}
    : { pfp: { url: identity.pfpUrl, verified: false } }),
  kind: identity.kind,
  clientId: identity.id,
});

const HANDLE_CHARACTER = /[a-zA-Z0-9_.-]/;

/**
 * True when the text at `index` already reads `@username` — a whole handle, not
 * the start of a longer one (`@ivc` is not found in `@ivc2`).
 */
const alreadyNamesHandle = ({
  text,
  index,
  username,
}: {
  text: string;
  index: number;
  username: string;
}): boolean => {
  const written = text.slice(index, index + username.length + 1);
  if (written.toLowerCase() !== `@${username.toLowerCase()}`) {
    return false;
  }
  const after = text.charAt(index + username.length + 1);
  return after === '' || !HANDLE_CHARACTER.test(after);
};

/** Byte offset → index into the JS string, or undefined if it lands nowhere. */
const indexesByByteOffset = (text: string): Map<number, number> => {
  // The protocol counts mentions in *bytes*; a JS string is indexed in UTF-16
  // units. The two agree only while the text is ASCII — an emoji is four bytes
  // and two units, which is the difference that shifts every later mention.
  const byByte = new Map<number, number>();
  let bytes = 0;
  let index = 0;
  for (const character of text) {
    byByte.set(bytes, index);
    bytes += utf8ByteLength(character);
    index += character.length;
  }
  // The protocol allows a position at the very end of the text (a mention typed
  // last), so the end offset is a legal place to insert.
  byByte.set(bytes, index);
  return byByte;
};

export interface CastTextWithMentionsOptions {
  text: string;
  /** The mentioned FIDs, in the cast's own order. */
  mentions: number[];
  /** Each mention's position in the text, in UTF-8 bytes. */
  mentionsPositions: number[];
  /** What each mentioned fid's handle is, once it has been read. */
  mentionUsers?: ReadonlyMap<number, ApiUser>;
}

/**
 * A cast's text with its mentions rendered in, the way every Farcaster client
 * renders them.
 *
 * MEASURED (protocol spec + a live node, 2026-10-21): the stored text does *not*
 * contain the handles. Each mention leaves a placeholder character where the
 * handle belongs — usually a space — and `mentionsPositions` says where, in
 * bytes. "🤓@farcaster can mention immediately after emoji" is stored as
 * `🤓 can mention immediately after emoji` with position `4`. So a client that
 * does not render mentions shows raw placeholders: a cast tagging six people
 * reads as six spaces. That is the bug this closes.
 *
 * The rule here is insertion at the position, from the last mention backwards so
 * earlier byte offsets stay valid: the placeholder stays as the separator, which
 * is what the stored text was written to do ("Looking forward to  finally" +
 * `@dwr` at byte 19 reads "Looking forward to @dwr finally"). Two floors are
 * deliberate and both keep the cast readable:
 *
 *   - a mention with no resolved handle inserts nothing, so its placeholder
 *     stays and the mention list carries the fid;
 *   - a cast whose own text already writes the handle at that position is left
 *     alone. MEASURED in the wild (1 of 50 successive mention-casts on a live
 *     node): some bots write "@ivc" into the text *and* register the mention, and
 *     inserting again would read "@ivcivc".
 *
 * A position outside the text (also measured in the wild: 9 of 50 successive
 * mention-casts on that node carry one) inserts nothing rather than throwing —
 * the mention still appears in the mention list.
 */
export const castTextWithMentions = ({
  text,
  mentions,
  mentionsPositions,
  mentionUsers,
}: CastTextWithMentionsOptions): string => {
  if (mentions.length === 0) {
    return text;
  }

  const indexByByte = indexesByByteOffset(text);
  const insertions = mentions
    .map((fid, mention) => ({
      fid,
      byteOffset: mentionsPositions[mention],
    }))
    .flatMap(({ fid, byteOffset }) => {
      const index =
        typeof byteOffset === 'number'
          ? indexByByte.get(byteOffset)
          : undefined;
      const username = mentionUsers?.get(fid)?.username;
      return index === undefined || !username ? [] : [{ index, username }];
    })
    // Backwards, so each insertion happens at the offset the protocol named.
    .sort((a, b) => b.index - a.index);

  let rendered = text;
  for (const { index, username } of insertions) {
    if (alreadyNamesHandle({ text: rendered, index, username })) {
      continue;
    }
    rendered = `${rendered.slice(0, index)}@${username}${rendered.slice(index)}`;
  }

  return rendered;
};

export interface ApiCastFromNodeOptions {
  message: NodeMessage;
  body: NodeCastAddBody;
  author: ApiUser;
  parentAuthor?: ApiUser;
  /** The root of the thread this cast belongs to, when it is known. */
  threadHash?: string;
  ancestors?: { count: number; casts?: ApiCast[] };
  replies?: { count: number; casts?: ApiCast[] };
  reactions?: NodeCount;
  recasts?: NodeCount;
  quotedCasts?: ApiQuoteCastEmbed[];
  viewerContext?: ApiCast['viewerContext'];
  /** What the caller has already learned about embed URLs (see embedKinds). */
  embedKind?: (url: string) => EmbedKindAnswer | undefined;
  /** What the caller has already learned about a link's own page (embedCards). */
  cardOf?: (url: string) => EmbedCard | undefined;
  /**
   * The profile of every account this cast mentions, by fid. The caller reads
   * these (one batched `userDataByFid` per page — see `reads.ts`), because a
   * mention's handle is not in the cast: it is the mentioned account's own user
   * data. A fid with no entry keeps the fid floor.
   */
  mentionUsers?: ReadonlyMap<number, ApiUser>;
  /**
   * Which app made this cast, when the caller resolved it from the protocol
   * (`farcaster-node-client`'s `clientAttribution`: the signer's signed key
   * request names an app FID, and that app account's own profile names the app).
   * Absent when nothing established it — a cast with no attribution is drawn
   * without a client, never with a guessed one.
   */
  client?: ApiCastClient;
}

/**
 * One cast as `ApiCast`. `threadHash` falls back to the cast's own hash when
 * the ancestry has not been walked: on the protocol a cast with no parent is
 * its own thread root, and this client only claims a different root when it
 * read the parent chain.
 */
export const apiCastFromNode = ({
  message,
  body,
  author,
  parentAuthor,
  threadHash,
  ancestors,
  replies,
  reactions,
  recasts,
  quotedCasts,
  viewerContext,
  embedKind,
  cardOf,
  mentionUsers,
  client,
}: ApiCastFromNodeOptions): ApiCast => {
  const { embeds } = castEmbedsFromNode({
    body,
    quotedCasts,
    embedKind,
    cardOf,
  });

  // A cast's mentions are rendered into its text (see castTextWithMentions) and
  // listed as profiles. Both halves need the mentioned accounts' own user data,
  // which the caller read; a fid it could not read stays a fid.
  const text = castTextWithMentions({
    text: body.text,
    mentions: body.mentions,
    mentionsPositions: body.mentionsPositions,
    ...(mentionUsers ? { mentionUsers } : {}),
  });

  const cast: ApiCast = {
    hash: message.hash,
    threadHash: threadHash ?? message.hash,
    author,
    text,
    timestamp: message.timestampMs,
    replies: {
      count: replies?.count ?? 0,
      ...(replies?.casts ? { casts: replies.casts } : {}),
    },
    // A count is written only when it was READ. With no `reactions` in hand
    // (a feed page answers before its counts are read — see `reads.ts`
    // `readCastCounts`) the field is left absent rather than zeroed, so no
    // surface can render "0 likes" for a cast nobody counted.
    ...(reactions ? { reactions: { count: reactions.value } } : {}),
    ...(recasts ? { recasts: { count: recasts.value } } : {}),
    // View counts are the hosted indexer's; absent, not zero.
    watches: { count: 0 },
    // `castType` in this API means where the cast sits in a feed, not how long
    // it is: a protocol reply is a reply-cast, anything else is a root.
    castType: body.parentCastId ? 'reply-cast' : 'root-cast',
  };

  if (body.parentCastId) {
    cast.parentHash = body.parentCastId.hash;
    if (parentAuthor) {
      cast.parentAuthor = parentAuthor;
    }
  }
  if (body.parentUrl) {
    cast.parentUrl = body.parentUrl;
    const channel = apiChannelMinimalFromParentUrl(body.parentUrl);
    if (channel) {
      cast.channel = channel;
    }
  }
  if (body.mentions.length > 0) {
    // Every mentioned FID gets an entry: the profile the caller read, or the fid
    // floor. The text above was rendered from the same profiles, so the handle a
    // reader sees, the profile a popover opens and the fid the protocol names are
    // one account — never only the viewer's.
    cast.mentions = body.mentions.map(
      (fid) => mentionUsers?.get(fid) ?? mentionFloorUser(fid),
    );
  }
  if (ancestors) {
    cast.ancestors = ancestors;
  }
  if (Object.keys(embeds).some((key) => (embeds as never)[key])) {
    cast.embeds = embeds;
  }
  if (viewerContext) {
    cast.viewerContext = viewerContext;
  }
  if (client) {
    // The app that made this cast, as the protocol names it. Set only when it
    // was really resolved (see `reads.ts`): an unresolved client leaves the
    // field absent, which renders as no label rather than as a claim.
    cast.client = client;
  }

  return cast;
};

/** One feed item: a cast plus the context the feed renderer reads. */
export const apiCastFeedItemFromNode = ({
  cast,
}: {
  cast: ApiCast;
}): ApiCastFeedItem => ({
  // The hosted API ids a feed item by the cast hash; the feed's own
  // de-duplication and the "seen" bookkeeping key on it.
  id: cast.hash,
  timestamp: cast.timestamp,
  cast,
  otherParticipants: [],
});
