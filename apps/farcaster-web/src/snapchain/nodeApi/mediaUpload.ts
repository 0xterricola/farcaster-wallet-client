/**
 * Where a cast's media actually goes, now that the hosted upload endpoint is
 * gone.
 *
 * WHAT USED TO HAPPEN
 *
 * The composer asked Warpcast for a signed upload URL
 * (`POST /v1/generate-image-upload-url`) and then POSTed the bytes straight to
 * their Cloudflare Images account. A read node cannot mint such a URL — it is a
 * media pipeline, not a node read — so the adapter answered 501 and posting a
 * photo failed with "Image upload failed".
 *
 * WHAT HAPPENS INSTEAD
 *
 * The mapping in `hostedRoutes.ts` sends that request to our own media host
 * (`apps/legitmate-farcaster`: `POST /api/fiddy/media`), and this module does
 * the part a routing table cannot: it carries the bytes and reads back the URL.
 *
 * WHY THE URL COMES BACK FROM THE SERVER
 *
 * The URL is the content hash of the bytes, so it cannot be known before the
 * upload finishes. The composer's Cloudflare path guessed the final URL from
 * `optimisticImageId` before the bytes left the browser; guessing is exactly
 * what we cannot do here, so the upload is awaited and the embed is registered
 * with the URL the server returned. It costs a wait (and a multi-file
 * selection uploads one file at a time); it buys a cast that can only ever
 * reference media that is actually stored.
 *
 * CONFIGURATION
 *
 * `VITE_FIDDY_MEDIA_URL` is the media host's base URL. Unset (or unparseable)
 * means the production host, `https://fiddy.fun`. For local work point it at
 * the service you are running beside the client:
 *
 *   VITE_FIDDY_MEDIA_URL=http://localhost:3217 npx vite --port 5174
 *
 * Nothing secret lives here: the client knows a URL, never a key.
 *
 * WHAT DOES NOT LEAVE THE DEVICE
 *
 * The bytes are prepared before they are sent: a photo is re-encoded (≤2048px,
 * JPEG — or PNG when anything in it is see-through, so a sticker or a logo
 * keeps its transparency) and a video's location/device boxes are overwritten,
 * so the picture reaches the host and the camera's metadata does not. See
 * `./photoPrivacy` for what that does and does not cover. A file nothing can be
 * done to is still sent — an unscrubbable photo is not a reason to lose
 * somebody's post — and the result says whether anything was changed.
 */

import { type ScrubEnvironment, scrubForUpload } from './photoPrivacy';

export const MEDIA_UPLOAD_PATH = '/api/fiddy/media';

/** The production media host: fiddy.fun serves the client and the bytes. */
export const DEFAULT_MEDIA_BASE_URL = 'https://fiddy.fun';

/** Documented local fallback for a dev server started beside the client. */
export const LOCAL_MEDIA_BASE_URL = 'http://localhost:3217';

/** What a person is told when the upload does not work. */
export const MEDIA_UPLOAD_FAILED_MESSAGE =
  "the photo didn't make it - try again.";

export class MediaUploadError extends Error {
  constructor(message: string = MEDIA_UPLOAD_FAILED_MESSAGE) {
    super(message);
    this.name = 'MediaUploadError';
  }
}

/** A usable absolute base, or the production default. */
export const resolveMediaBaseUrl = (
  env: Record<string, unknown> = import.meta.env,
): string => {
  const configured = env.VITE_FIDDY_MEDIA_URL;
  const candidate =
    typeof configured === 'string' && configured.trim().length > 0
      ? configured.trim()
      : DEFAULT_MEDIA_BASE_URL;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return DEFAULT_MEDIA_BASE_URL;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return DEFAULT_MEDIA_BASE_URL;
  }
};

/** The absolute URL the bytes are POSTed to. */
export const mediaUploadUrl = (
  env: Record<string, unknown> = import.meta.env,
): string => `${resolveMediaBaseUrl(env)}${MEDIA_UPLOAD_PATH}`;

/**
 * Is this the upload URL our own media host handed out?
 *
 * This is how the composer knows which pipeline it is in: the answer comes from
 * the mint response itself rather than a second flag that could disagree with
 * it. A hosted (Cloudflare) URL is still handled the hosted way.
 */
export const isOwnMediaUploadUrl = (
  url: string,
  env: Record<string, unknown> = import.meta.env,
): boolean => {
  try {
    const requested = new URL(url);
    const ours = new URL(mediaUploadUrl(env));
    return (
      requested.origin === ours.origin && requested.pathname === ours.pathname
    );
  } catch {
    return false;
  }
};

export interface UploadedMedia {
  /** The absolute URL the stored bytes are readable at. */
  url: string;
  sha256: string;
  bytes: number;
  contentType: string;
  ext: string;
  deduped: boolean;
  /**
   * What was taken out of the file on the way out: `re-encoded` for a photo,
   * `metadata-stripped` for a video, `unchanged` when there was nothing this
   * client knows how to remove (or the file was already safe).
   */
  privacy: 're-encoded' | 'metadata-stripped' | 'unchanged';
}

interface MediaEndpointReply {
  ok?: boolean;
  url?: string;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  ext?: string;
  deduped?: boolean;
  message?: string;
}

/**
 * POST the bytes to our media host and read back where they now live.
 *
 * The server's own sentence wins when it has one ("that file is too big - 25MB
 * is the limit"): it knows why it refused, and it already says so the way a
 * person would.
 */
export const uploadMedia = async ({
  file,
  uploadUrl,
  fetchImpl = fetch,
  environment,
  scrub = true,
}: {
  file: File;
  /** Defaults to this build's media host. */
  uploadUrl?: string;
  fetchImpl?: typeof fetch;
  /** The browser pieces the re-encode needs; a test supplies its own. */
  environment?: ScrubEnvironment;
  /** Off only for a caller that has already prepared the bytes itself. */
  scrub?: boolean;
}): Promise<UploadedMedia> => {
  const prepared = scrub
    ? await scrubForUpload({ file, environment })
    : { file: file as Blob, changed: false };

  const body = new FormData();
  body.append('file', prepared.file, file.name);

  let response: Response;
  try {
    response = await fetchImpl(uploadUrl ?? mediaUploadUrl(), {
      method: 'POST',
      body,
    });
  } catch {
    throw new MediaUploadError(
      `we couldn't reach the photo host - ${MEDIA_UPLOAD_FAILED_MESSAGE}`,
    );
  }

  const reply = (await response.json().catch(() => undefined)) as
    | MediaEndpointReply
    | undefined;
  if (
    !response.ok ||
    typeof reply?.url !== 'string' ||
    reply.url.length === 0
  ) {
    throw new MediaUploadError(
      reply?.message?.trim() || MEDIA_UPLOAD_FAILED_MESSAGE,
    );
  }

  return {
    url: reply.url,
    sha256: reply.sha256 ?? '',
    bytes: typeof reply.bytes === 'number' ? reply.bytes : prepared.file.size,
    contentType: reply.contentType ?? prepared.file.type ?? file.type,
    ext: reply.ext ?? '',
    deduped: Boolean(reply.deduped),
    privacy: !prepared.changed
      ? 'unchanged'
      : /^image\//.test(prepared.file.type)
        ? 're-encoded'
        : 'metadata-stripped',
  };
};
