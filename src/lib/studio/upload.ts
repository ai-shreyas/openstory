/**
 * R2 uploads for prompt-only studio assets (#1274).
 *
 * Keys live under `teams/<teamId>/studio/<assetId>/` so they never collide
 * with sequence frame paths. URLs are origin-relative `/r2/<key>` (#894).
 */

import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromMimeType,
  getExtensionFromUrl,
  getMimeTypeFromExtension,
  sniffImageMimeType,
} from '@/lib/utils/file';

export type StudioUploadResult = {
  url: string;
  path: string;
  contentType: string;
};

export async function uploadStudioImage(params: {
  imageUrl: string;
  teamId: string;
  assetId: string;
}): Promise<StudioUploadResult> {
  const response = await fetch(params.imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const sniffed = sniffImageMimeType(bytes);
  const headerType = response.headers.get('content-type');
  const extension =
    getExtensionFromMimeType(sniffed) ??
    getExtensionFromMimeType(headerType) ??
    getExtensionFromUrl(params.imageUrl);
  const contentType = sniffed ?? getMimeTypeFromExtension(extension);
  const path = `teams/${params.teamId}/studio/${params.assetId}/image.${extension}`;

  const result = await uploadResponse(
    new Response(bytes, {
      headers: {
        'content-type': contentType,
        'content-length': String(bytes.byteLength),
      },
    }),
    STORAGE_BUCKETS.THUMBNAILS,
    path,
    { contentType }
  );

  return { url: result.publicUrl, path, contentType };
}

export async function uploadStudioVideo(params: {
  videoUrl: string;
  teamId: string;
  assetId: string;
}): Promise<StudioUploadResult> {
  const response = await fetch(params.videoUrl);
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status}`);
  }

  const headerType = response.headers.get('content-type');
  const urlExtension = getExtensionFromUrl(params.videoUrl);
  let extension = urlExtension;
  if (urlExtension === 'jpg' && headerType) {
    if (headerType.includes('mp4')) extension = 'mp4';
    else if (headerType.includes('webm')) extension = 'webm';
    else if (headerType.includes('quicktime') || headerType.includes('mov')) {
      extension = 'mov';
    } else extension = 'mp4';
  }
  const contentType =
    headerType?.split(';', 1)[0]?.trim() || getMimeTypeFromExtension(extension);
  const path = `teams/${params.teamId}/studio/${params.assetId}/video.${extension}`;

  const result = await uploadResponse(response, STORAGE_BUCKETS.VIDEOS, path, {
    contentType,
  });

  return { url: result.publicUrl, path, contentType };
}
