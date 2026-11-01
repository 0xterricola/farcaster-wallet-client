/**
 * The picture links inside a direct message: which tokens of the message ARE
 * pictures, and which are left as the honest links they are.
 *
 * These tests go through the real classifier (`createEmbedKindResolver`) with
 * only its network stubbed, because the whole point of the change is that a
 * token is ASKED what it is rather than guessed:
 *
 *   - Fiddy's own Cloudflare Images URL, which has no file extension at all, is
 *     a picture without anyone being asked (a DM list draws previews and must
 *     never start a read);
 *   - a foreign imagedelivery URL with no extension is a picture because the
 *     classifier says so — and is only a picture AFTER it says so;
 *   - a page that is not an image stays text, and is never a candidate again;
 *   - a URL whose origin this page may not read (Farcaster's own public server,
 *     the analytics hosts) is never asked at all, and stays text;
 *   - two pictures plus text in one message come out in the order they were
 *     written, with the sentence's own punctuation left where the reader put it.
 */

import { describe, expect, it, vi } from 'vitest';

import { createEmbedKindResolver } from '~/snapchain/nodeApi/embedKinds';
import {
  isFiddyOwnImageUrl,
  isRefusedTokenUrl,
  splitDirectCastMessageImageTokens,
} from '~/utils/directCastImageTokens';

/** Fiddy's own media host — the one shape the inbox special case used to know. */
const FIDDY_PHOTO =
  'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/a62d038c-974d-4c48-a658-c764f4205c00/original';

/** Someone else's Cloudflare Images account: no extension, not ours. */
const FOREIGN_PHOTO =
  'https://imagedelivery.net/ZZanotherAccount/a62d038c-974d-4c48-a658-c764f4205c00/original';

/** A page, by content type, on a host that answers. */
const A_PAGE = 'https://blog.test/posts/1';

/** Origins this page cannot read (and so must not try to). */
const REFUSED_PAGE = 'https://api.farcaster.xyz/v2/direct-cast-inbox';
const REFUSED_ANALYTICS = 'https://ph.neynar.com/decide';

/** The one path on Farcaster's public server a page MAY read. */
const PUBLIC_SERVER_READABLE = 'https://api.farcaster.xyz/fc/primary-address';

const contentTypes: Record<string, string> = {
  [FOREIGN_PHOTO]: 'image/jpeg',
  [A_PAGE]: 'text/html; charset=utf-8',
  [PUBLIC_SERVER_READABLE]: 'application/json',
};

const stubbedClassifier = () => {
  const asked: { url: string; method: string }[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, method: init?.method ?? 'GET' });
      const contentType = contentTypes[url];
      if (contentType === undefined) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        status: 200,
        headers: { 'content-type': contentType },
      });
    },
  ) as unknown as typeof fetch;

  const resolver = createEmbedKindResolver({
    fetchImpl,
    storage: null,
    // No browser here: the last-resort probe answers nothing, so a URL that
    // could not be asked stays a link (which is what the resolver promises).
    imageProbe: async () => undefined,
  });

  return { resolver, kindOf: (url: string) => resolver.kindOf(url), asked };
};

const split = ({
  message,
  kindOf,
  skip,
}: {
  message: string;
  kindOf: (url: string) => 'image' | 'video' | 'link' | undefined;
  skip?: ReadonlySet<string>;
}) => splitDirectCastMessageImageTokens({ message, kindOf, skip });

describe("Fiddy's own media host needs no one to be asked", () => {
  it('takes the picture out of the message without a single read', () => {
    const { kindOf, asked } = stubbedClassifier();

    const parts = split({ message: `here you go ${FIDDY_PHOTO}`, kindOf });

    expect(parts.imageUrls).toEqual([FIDDY_PHOTO]);
    expect(parts.text).toBe('here you go');
    expect(parts.unknownImageCandidates).toEqual([]);
    expect(asked).toEqual([]);
    expect(isFiddyOwnImageUrl(FIDDY_PHOTO)).toBe(true);
  });

  it('knows our host from anyone else’s on it', () => {
    expect(isFiddyOwnImageUrl(FOREIGN_PHOTO)).toBe(false);
  });
});

describe('a token is asked what it is, never guessed from its name', () => {
  it('draws a no-extension URL as a picture once the classifier answers', async () => {
    const { resolver, kindOf, asked } = stubbedClassifier();

    // Nothing is known yet: the message is left exactly as it was written.
    const before = split({ message: `look ${FOREIGN_PHOTO}`, kindOf });

    expect(before.imageUrls).toEqual([]);
    expect(before.unknownImageCandidates).toEqual([FOREIGN_PHOTO]);
    expect(before.text).toBe(`look ${FOREIGN_PHOTO}`);
    expect(asked).toEqual([]);

    await resolver.classify([FOREIGN_PHOTO]);

    const after = split({ message: `look ${FOREIGN_PHOTO}`, kindOf });

    expect(after.imageUrls).toEqual([FOREIGN_PHOTO]);
    expect(after.text).toBe('look');
    expect(after.unknownImageCandidates).toEqual([]);
    // One bounded probe, of the URL itself, asking the server what it holds.
    expect(asked).toEqual([{ url: FOREIGN_PHOTO, method: 'HEAD' }]);
  });

  it('leaves a page a page, and does not ask about it again', async () => {
    const { resolver, kindOf } = stubbedClassifier();

    await resolver.classify([A_PAGE]);

    const parts = split({ message: `read this ${A_PAGE}`, kindOf });

    expect(parts.imageUrls).toEqual([]);
    expect(parts.text).toBe(`read this ${A_PAGE}`);
    // "not an image" is an answer, not a question still open.
    expect(parts.unknownImageCandidates).toEqual([]);
    expect(kindOf(A_PAGE)).toBe('link');
  });

  it('leaves a URL nothing could answer as the link it is', async () => {
    const { resolver, kindOf, asked } = stubbedClassifier();
    const unreachable = 'https://gone.test/photo/1';

    await resolver.classify([unreachable]);
    await resolver.settle();

    const parts = split({ message: `old link ${unreachable}`, kindOf });

    expect(parts.imageUrls).toEqual([]);
    expect(parts.text).toBe(`old link ${unreachable}`);
    expect(asked.map(({ url }) => url)).toEqual([unreachable, unreachable]);
  });
});

describe('an origin this page may not read is never asked', () => {
  it('refuses the public server’s own paths and the analytics hosts', () => {
    expect(isRefusedTokenUrl(REFUSED_PAGE)).toBe(true);
    expect(isRefusedTokenUrl(REFUSED_ANALYTICS)).toBe(true);
    // The single path there that does answer a page is not refused.
    expect(isRefusedTokenUrl(PUBLIC_SERVER_READABLE)).toBe(false);
  });

  it('keeps such a token as text without a read', () => {
    const { kindOf, asked } = stubbedClassifier();
    const parts = split({
      message: `shared ${REFUSED_PAGE} and ${REFUSED_ANALYTICS} ok`,
      kindOf,
    });

    expect(parts.refusedUrls).toEqual([REFUSED_PAGE, REFUSED_ANALYTICS]);
    expect(parts.unknownImageCandidates).toEqual([]);
    expect(parts.text).toBe(
      `shared ${REFUSED_PAGE} and ${REFUSED_ANALYTICS} ok`,
    );
    // Nothing was sent anywhere: not even the path that would have answered.
    expect(asked).toEqual([]);
  });
});

describe('a message can hold more than one picture', () => {
  it('pulls them all out, in order, and keeps the sentence', async () => {
    const { resolver, kindOf } = stubbedClassifier();
    await resolver.classify([FOREIGN_PHOTO, A_PAGE]);

    const message = [
      `two photos for you ${FIDDY_PHOTO}`,
      `and the same one from another app ${FOREIGN_PHOTO}`,
      `here is a page ${A_PAGE}, and a word from you`,
    ].join('\n');

    const parts = split({ message, kindOf });

    expect(parts.imageUrls).toEqual([FIDDY_PHOTO, FOREIGN_PHOTO]);
    expect(parts.text).toBe(
      [
        'two photos for you',
        'and the same one from another app',
        `here is a page ${A_PAGE}, and a word from you`,
      ].join('\n'),
    );
  });

  it('leaves a line that held nothing but the picture out of the text', () => {
    const { kindOf } = stubbedClassifier();

    const parts = split({
      message: `good morning\n${FIDDY_PHOTO}\nsee you later`,
      kindOf,
    });

    expect(parts.imageUrls).toEqual([FIDDY_PHOTO]);
    expect(parts.text).toBe('good morning\nsee you later');
  });

  it('keeps the punctuation the picture sat next to', () => {
    const { kindOf } = stubbedClassifier();

    const parts = split({
      message: `that is ${FIDDY_PHOTO}, nice one ${FOREIGN_PHOTO}.`,
      kindOf,
    });

    expect(parts.imageUrls).toEqual([FIDDY_PHOTO]);
    expect(parts.text).toBe('that is, nice one ' + FOREIGN_PHOTO + '.');
  });

  it('counts the same link twice when the message wrote it twice', () => {
    const { kindOf } = stubbedClassifier();

    const parts = split({
      message: `${FIDDY_PHOTO} ${FIDDY_PHOTO}`,
      kindOf,
    });

    expect(parts.imageUrls).toEqual([FIDDY_PHOTO, FIDDY_PHOTO]);
    expect(parts.text).toBe('');
  });
});

describe('a URL the bubble already draws is left alone', () => {
  it('does not pull out a media embed’s own URL', () => {
    const { kindOf } = stubbedClassifier();
    const alreadyDrawn = new Set([FIDDY_PHOTO]);

    const parts = split({
      message: `${FIDDY_PHOTO}`,
      kindOf,
      skip: alreadyDrawn,
    });

    expect(parts.imageUrls).toEqual([]);
    expect(parts.text).toBe(FIDDY_PHOTO);
  });
});
