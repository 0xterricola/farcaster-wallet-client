/**
 * The image links inside a direct message: which tokens of it are pictures, and
 * what text is left once they are taken out.
 *
 * WHY THIS EXISTS
 *
 * A direct message is plain text. People paste photo links into it — often in
 * the middle of a sentence, sometimes two of them. Until this module existed the
 * client knew exactly one shape: a message that STARTS with Fiddy's own
 * Cloudflare Images URL, which an inbox preview turned into "shared an image"
 * (`useDirectCastText`). Every other picture link — another host, a link after a
 * word, two pictures in one message — stayed a line of linkified text.
 *
 * PATTERN, AND WHERE IT CAME FROM
 *
 * quilcast (MIT, https://github.com/backmeupplz/quilcast) commit
 * `c7867637607c`, "image links inside DM text show as images" (0.10.5): its
 * `partsOf(m)` walks every whitespace-delimited token of a message, pulls out
 * each one that IS an image — all of them, in the order they were posted — and
 * leaves whatever text remains for the bubble. This module is the same idea,
 * reimplemented against this client's types.
 *
 * OUR TWIST: a token is ASKED what it is, never guessed.
 *
 * The check is the bounded, cached resolver cast embeds already go through —
 * `~/snapchain/nodeApi/embedKinds` (`kindOf`, HEAD → ranged GET → `Image()`,
 * one probe per URL, remembered for the session and beyond). It arrives here as
 * the injected `kindOf` so this module stays pure, synchronous and testable. A
 * file extension is never the answer: Cloudflare's delivery URLs
 * (`…/imagedelivery.net/<account>/<id>/original`) carry none at all.
 *
 * WHAT IT REFUSES TO DO
 *
 *   - It never reads anything. `kindOf` answers from what is already known; the
 *     caller does the asking (see `useDirectCastText`), once per URL, and
 *     re-renders when an answer lands.
 *   - It never lets a token be classified if the origin cannot answer this page
 *     (`REFUSED_TOKEN_ORIGINS`, kept in step with
 *     `scripts/verify-no-off-site-reads.mjs`). Those tokens stay the plain links
 *     they are, and come back in `refusedUrls` so a caller can say why.
 *   - A token nothing has answered for is NOT an image. It stays in the text as
 *     the honest link it is, and comes back in `unknownImageCandidates` so the
 *     caller can ask and draw it once an answer arrives. An unanswered link is
 *     never a broken frame.
 */

import type { EmbedKindAnswer } from '~/snapchain/nodeApi/embedKinds';
import { FARCASTER_PUBLIC_BASE_URL } from '~/snapchain/providers/catalog';

/** What is known about a URL right now. Synchronous, cached, never a read. */
export type EmbedKindLookup = (url: string) => EmbedKindAnswer | undefined;

/**
 * The media host Fiddy itself puts images on: Cloudflare Images, under this
 * app's own account. A URL there is a picture by construction, so it is drawn
 * without asking anyone — which is what lets a DM list say "shared an image"
 * for a message that was never opened (a preview starts no read; see
 * `useDirectCastText`).
 *
 * This is the one hard-coded host the old special case had, kept deliberately:
 * it is knowledge about our own storage, not a guess about someone's filename.
 */
const FIDDY_IMAGE_HOST_PREFIX =
  'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/';

export const isFiddyOwnImageUrl = (url: string): boolean =>
  url.startsWith(FIDDY_IMAGE_HOST_PREFIX);

/**
 * Origins a page on this one cannot read, so a read is never attempted:
 *
 *   - Farcaster's own public server, whose every `/v1/**` and `/v2/**` path
 *     permits its own origins only (`/fc/*` is the one path that answers, and
 *     it serves no messages). Measured and written up in
 *     `~/snapchain/providers/publicServerOffTheWeb`.
 *   - the analytics hosts, which must send nothing when this build has no key
 *     of its own (`~/constants/analytics`).
 *
 * The same three families `scripts/verify-no-off-site-reads.mjs` fails a
 * release on. A picture is never hosted on any of them; a token that points
 * there is left as the plain link it is.
 */
const REFUSED_TOKEN_ORIGINS: RegExp[] = [
  new RegExp(`^${FARCASTER_PUBLIC_BASE_URL}/(?!fc/)`),
  /^https:\/\/(?:[a-z0-9-]+\.)?posthog\.com\//i,
  /^https:\/\/ph\.neynar\.com\//i,
];

export const isRefusedTokenUrl = (url: string): boolean =>
  REFUSED_TOKEN_ORIGINS.some((pattern) => pattern.test(url));

export interface SplitDirectCastMessageOptions {
  /** The message as it will be drawn (already cleared of embeds, if any). */
  message: string;
  /** What is known about a URL right now. Asked only about allowed origins. */
  kindOf: EmbedKindLookup;
  /**
   * URLs another part of the bubble already draws (this direct cast's own media
   * embeds). They are left where they are rather than drawn twice.
   */
  skip?: ReadonlySet<string>;
}

export interface DirectCastMessageImageParts {
  /** Tokens that ARE pictures, in the order they were posted. Draw these. */
  imageUrls: string[];
  /** Tokens nothing has answered for yet. The caller may ask, once, cached. */
  unknownImageCandidates: string[];
  /** Tokens whose origin this client will not read. They stay plain links. */
  refusedUrls: string[];
  /** The message with the pictures taken out, whitespace tidied. */
  text: string;
}

/** A whitespace-delimited token — what a message is a list of. */
const TOKEN = /\S+/g;

/**
 * Punctuation that ends a sentence, not a URL: "look, https://a.test/1.png."
 * The token is a picture, the full stop belongs to the sentence. Kept as it was
 * written.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"”’)\]}]+$/u;

/** The URL inside a token, when the token is one, plus what followed it. */
const tokenUrl = (
  token: string,
): { url: string; trailing: string } | undefined => {
  const trailing = TRAILING_PUNCTUATION.exec(token)?.[0] ?? '';
  const candidate =
    trailing === '' ? token : token.slice(0, token.length - trailing.length);
  if (candidate === '') {
    return undefined;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined;
    }
    if (parsed.hostname === '') {
      return undefined;
    }
    return { url: candidate, trailing };
  } catch {
    return undefined;
  }
};

/**
 * Split one line of a message. Returns the text that remains, the pictures
 * pulled out of it, and whether the line held one of them (so an emptied line
 * can be dropped instead of leaving a hole where the picture was).
 */
const splitLine = (
  line: string,
  {
    kindOf,
    skip,
    imageUrls,
    unknownImageCandidates,
    refusedUrls,
  }: {
    kindOf: EmbedKindLookup;
    skip: ReadonlySet<string> | undefined;
    imageUrls: string[];
    unknownImageCandidates: string[];
    refusedUrls: string[];
  },
): { text: string; heldPicture: boolean } => {
  const kept: string[] = [];
  let cursor = 0;
  let heldPicture = false;

  for (const match of line.matchAll(TOKEN)) {
    const token = match[0];
    const start = match.index;
    kept.push(line.slice(cursor, start));
    cursor = start + token.length;

    const found = tokenUrl(token);

    if (found === undefined) {
      kept.push(token);
      continue;
    }

    if (isRefusedTokenUrl(found.url)) {
      refusedUrls.push(found.url);
      kept.push(token);
      continue;
    }

    if (skip?.has(found.url) === true) {
      kept.push(token);
      continue;
    }

    const answer: EmbedKindAnswer | undefined = isFiddyOwnImageUrl(found.url)
      ? 'image'
      : kindOf(found.url);

    if (answer === 'image') {
      imageUrls.push(found.url);
      // The sentence's punctuation stays where the reader wrote it.
      kept.push(found.trailing);
      heldPicture = true;
      continue;
    }

    if (answer === undefined && !unknownImageCandidates.includes(found.url)) {
      unknownImageCandidates.push(found.url);
    }

    kept.push(token);
  }

  kept.push(line.slice(cursor));

  return {
    text: kept
      .join('')
      .replace(/ {2,}/g, ' ')
      // A full stop or comma that belonged to the sentence was left behind by
      // the picture that went away: put it back against the word it followed.
      .replace(/ +([.,;:!?])/g, '$1')
      .trimEnd(),
    heldPicture,
  };
};

/**
 * Take every picture out of a direct message, in order, and hand back the text
 * that is left.
 */
export const splitDirectCastMessageImageTokens = ({
  message,
  kindOf,
  skip,
}: SplitDirectCastMessageOptions): DirectCastMessageImageParts => {
  const imageUrls: string[] = [];
  const unknownImageCandidates: string[] = [];
  const refusedUrls: string[] = [];
  const lines: string[] = [];

  for (const line of message.split('\n')) {
    const { text, heldPicture } = splitLine(line, {
      kindOf,
      skip,
      imageUrls,
      unknownImageCandidates,
      refusedUrls,
    });

    // A line that held nothing but the picture goes away with it: the picture
    // is drawn in its place, and a blank line would be a hole in the message.
    if (heldPicture && text.trim() === '') {
      continue;
    }

    lines.push(text);
  }

  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  return {
    imageUrls,
    unknownImageCandidates,
    refusedUrls,
    text: lines.join('\n'),
  };
};
