import { useFetchImageUploadUrl } from 'farcaster-client-hooks';
import { useCallback } from 'react';

import {
  isOwnMediaUploadUrl,
  uploadMedia,
} from '~/snapchain/nodeApi/mediaUpload';

import { IMAGE_UPLOAD_ANIMATION_TOO_LARGE_MESSAGE } from './useOptimisticUploadCloudflareImage';

const CLOUDFLARE_ANIMATION_TOO_LARGE_ERROR_CODE = 5443;

type CloudflareImagesUploadResponse = {
  success?: boolean;
  result?: { variants?: string[] };
  errors?: { code?: number; message?: string }[];
};

class CloudflareImagesUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareImagesUploadError';
  }
}

function getCloudflareImagesUploadErrorMessage(
  response: CloudflareImagesUploadResponse,
) {
  const cloudflareError = response.errors?.find(
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

const useUploadCloudflareImage = () => {
  const fetchImageUploadUrl = useFetchImageUploadUrl();

  return useCallback(
    async ({ file }: { file: File }) => {
      const fetchImageUploadUrlResponse = await fetchImageUploadUrl();

      if (
        typeof fetchImageUploadUrlResponse === 'undefined' ||
        typeof fetchImageUploadUrlResponse.url === 'undefined'
      ) {
        return;
      }

      const imageUploadUrl = fetchImageUploadUrlResponse.url;

      // Our own media host: the URL comes back from the upload (the file is
      // named after its content), and there is no Cloudflare envelope to read.
      if (isOwnMediaUploadUrl(imageUploadUrl)) {
        const uploaded = await uploadMedia({ file, uploadUrl: imageUploadUrl });
        return { version: 'v1', imageUrl: uploaded.url } as {
          version: 'v1';
          imageUrl: string;
        };
      }

      // const f = {
      //   uri: file,
      //   type: 'image/jpeg',
      //   name: 'direct-cast-image.jpg',
      // };

      const body = new FormData();

      // @ts-ignore-next-line
      body.append('file', file, file.name);

      const r = await fetch(imageUploadUrl, {
        method: 'POST',
        body,
      });

      const response = (await r.json()) as CloudflareImagesUploadResponse;

      if (
        typeof response === 'undefined' ||
        !response.success ||
        typeof response.result?.variants === 'undefined'
      ) {
        throw new CloudflareImagesUploadError(
          getCloudflareImagesUploadErrorMessage(response),
        );
      }

      const originalVariantImageUrl = response.result.variants.find((o) =>
        o.endsWith('/original'),
      );

      if (typeof originalVariantImageUrl === 'undefined') {
        return undefined;
      }

      return { version: 'v1', imageUrl: originalVariantImageUrl } as {
        version: 'v1';
        imageUrl: string;
      };
    },
    [fetchImageUploadUrl],
  );
};

export { useUploadCloudflareImage };
