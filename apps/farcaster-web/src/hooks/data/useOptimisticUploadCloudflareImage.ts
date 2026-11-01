import {
  useFetchImageUploadUrl,
  WARPCAST_CLOUDFLARE_CDN_PREFIX,
} from 'farcaster-client-hooks';
import { useCallback } from 'react';

import {
  isOwnMediaUploadUrl,
  uploadMedia,
} from '~/snapchain/nodeApi/mediaUpload';

const IMAGE_EMBED_MAX_DIMENSIONS = {
  // We will never render an image above this resolution on any of our clients.
  // Opportunity for another client around image being centered. (NFT feeds etc.)
  width: 2000,
  height: 2000,
  size: 1000000,
};

const CLOUDFLARE_ANIMATION_TOO_LARGE_ERROR_CODE = 5443;
export const IMAGE_UPLOAD_ANIMATION_TOO_LARGE_MESSAGE =
  'This GIF is too large to upload. Try a lower-resolution or shorter GIF.';

type CloudflareImagesUploadResponse = {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
};

class CloudflareImagesUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareImagesUploadError';
  }
}

async function getCloudflareImagesUploadErrorMessage(response: Response) {
  let responseBody: CloudflareImagesUploadResponse | undefined;

  try {
    responseBody = (await response.json()) as CloudflareImagesUploadResponse;
  } catch {}

  const cloudflareError = responseBody?.errors?.find(
    (error) => typeof error.message === 'string',
  );

  if (cloudflareError?.code === CLOUDFLARE_ANIMATION_TOO_LARGE_ERROR_CODE) {
    return IMAGE_UPLOAD_ANIMATION_TOO_LARGE_MESSAGE;
  }

  if (cloudflareError?.message) {
    return cloudflareError.message;
  }

  return 'Cloudflare failed to accept the image';
}

async function assertCloudflareImagesUploadAccepted(response: Response) {
  if (response.ok) {
    return response;
  }

  throw new CloudflareImagesUploadError(
    await getCloudflareImagesUploadErrorMessage(response),
  );
}

function containImageRes(
  w: number,
  h: number,
): [width: number, height: number] {
  let scale = 1;

  const { width: maxWidth, height: maxHeight } = IMAGE_EMBED_MAX_DIMENSIONS;
  if (w > maxWidth || h > maxHeight) {
    scale = w > h ? maxWidth / w : maxHeight / h;
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
  }

  return [w, h];
}

async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  const blobUrl = URL.createObjectURL(file);
  try {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(blobUrl);
        resolve(img);
      };
      img.onerror = (err) => {
        URL.revokeObjectURL(blobUrl);
        reject(err);
      };
      img.src = blobUrl;
    });
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw err;
  }
}

function getDataUriSize(dataUri: string): number {
  const base64Data = dataUri.split(',')[1];
  if (!base64Data) {
    return 0;
  }
  const padding = (base64Data.match(/=+$/) || [''])[0].length;
  return (base64Data.length * 3) / 4 - padding;
}

async function getFileDimensions(
  file: File,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const blobURL = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      URL.revokeObjectURL(blobURL);
      resolve({ width, height });
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(blobURL);
      reject(err);
    };
    img.src = blobURL;
  });
}

function dataUriToBlob(dataUri: string): Blob {
  const byteString = atob(dataUri.split(',')[1]);
  const arrayBuffer = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    arrayBuffer[i] = byteString.charCodeAt(i);
  }
  return new Blob([arrayBuffer], { type: 'image/jpeg' });
}

async function compressImage({ file }: { file: File }): Promise<File> {
  const { width, height } = await getFileDimensions(file);

  const [w, h] = containImageRes(width, height);

  const img = await loadImageFromFile(file);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);

  for (let i = 10; i > 0; i--) {
    const factor = i / 10;
    const dataUri = canvas.toDataURL('image/jpeg', factor);
    if (getDataUriSize(dataUri) <= IMAGE_EMBED_MAX_DIMENSIONS.size) {
      const blob = dataUriToBlob(dataUri);
      return new File([blob], file.name, { type: 'image/jpeg' });
    }
  }

  throw new Error('Unable to transform image');
}

const useOptimisticUploadCloudflareImage = () => {
  const fetchImageUploadUrl = useFetchImageUploadUrl();

  return useCallback(
    async ({
      file,
      imageUploaderPromise,
    }: {
      file: File;
      imageUploaderPromise?: Promise<{
        url: string;
        optimisticImageId: string;
      }>;
    }) => {
      const fetcher =
        typeof imageUploaderPromise !== 'undefined'
          ? imageUploaderPromise
          : fetchImageUploadUrl();

      const fetchImageUploadUrlResponse = await fetcher;

      if (
        typeof fetchImageUploadUrlResponse === 'undefined' ||
        typeof fetchImageUploadUrlResponse.url === 'undefined' ||
        typeof fetchImageUploadUrlResponse.optimisticImageId === 'undefined'
      ) {
        return;
      }

      const imageUploadUrl = fetchImageUploadUrlResponse.url;

      // OUR OWN MEDIA HOST
      //
      // The hosted API hands out a Cloudflare CDN URL and the composer guesses
      // the final image URL from `optimisticImageId` before the bytes leave the
      // browser. Our own host names a file after its content hash, so the URL
      // cannot be guessed - it is read back from the upload. The upload is
      // therefore awaited here, and the embed is registered with the URL the
      // server confirmed. The local preview still shows immediately (the
      // composer's own optimistic media embeds paint it), so nothing looks
      // slower than it is: only the canonical URL waits.
      if (isOwnMediaUploadUrl(imageUploadUrl)) {
        // NO `compressImage` HERE, and that is the point of this branch.
        //
        // `compressImage` writes a JPEG — it draws the picture onto a fresh
        // canvas and encodes `image/jpeg` — so a transparent PNG or WebP picked
        // here reached our host with an opaque box baked behind every
        // see-through pixel (MEASURED 2026-10-23 by scripts/verify-media-upload.mjs:
        // a sticker with a transparent border came back
        // `corner rgba=[0,2,0,255]`, a black box, on the dark feed). It also left
        // the embed bounded by nothing: the re-encode in `uploadMedia` after it
        // (see ~/snapchain/nodeApi/photoPrivacy) writes its own bytes anyway, so
        // the ≤1MB target this loop aims at was never the size that shipped.
        //
        // The re-encode IS the size bound now, and it does the whole job: the
        // long edge is capped at 2048px, every metadata block the camera wrote is
        // gone, and the format is chosen from the pixels — PNG while anything in
        // the picture is see-through, JPEG otherwise (upstream quilcast
        // 92d1aeead4af, MIT). A see-through picture is bounded here by the host's
        // own 25MB photo cap instead of a quality loop, because the alternative —
        // quantising a logo into an opaque JPEG — is the defect itself.
        const uploaded = await uploadMedia({
          file,
          uploadUrl: imageUploadUrl,
        });

        return {
          version: 'v2',
          previewUrl: URL.createObjectURL(file),
          imageUrl: uploaded.url,
          uploadPromise: Promise.resolve(
            new Response(JSON.stringify({ ok: true, url: uploaded.url }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            }),
          ),
        } as {
          version: 'v2';
          previewUrl: string;
          imageUrl: string;
          uploadPromise: Promise<Response>;
        };
      }

      const imageUrl = `${WARPCAST_CLOUDFLARE_CDN_PREFIX}/${fetchImageUploadUrlResponse.optimisticImageId}/original`;

      const uploadPromise = new Promise<Response>((resolve, reject) => {
        (async () => {
          let finalFileToUpload = file;

          if (file.type.indexOf('gif') === -1) {
            finalFileToUpload = await compressImage({
              file,
            });
          }

          const body = new FormData();

          // @ts-ignore-next-line
          body.append('file', finalFileToUpload, finalFileToUpload.name);

          const response = await fetch(imageUploadUrl, {
            method: 'POST',
            body,
          });

          return resolve(assertCloudflareImagesUploadAccepted(response));
        })().catch(reject);
      });

      const previewUrl = URL.createObjectURL(file);

      return {
        version: 'v2',
        previewUrl,
        imageUrl,
        uploadPromise,
      } as {
        version: 'v2';
        previewUrl: string;
        imageUrl: string;
        uploadPromise: Promise<Response>;
      };
    },
    [fetchImageUploadUrl],
  );
};

export { useOptimisticUploadCloudflareImage };
