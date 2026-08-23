/**
 * Copy a stored (or fetchable) image into a new R2 key. Used when a
 * character reuses a talent sheet: the bytes live in the talent bucket
 * and must land in the characters bucket so the character owns its sheet.
 */

import { readStorageObject, uploadFile } from '#storage';
import {
  r2KeyFromUrl,
  type StorageBucket,
  type UploadResult,
} from '@/lib/storage/buckets';

export async function copyStoredImage(params: {
  sourceUrl: string;
  destBucket: StorageBucket;
  destPath: string;
  contentType?: string;
}): Promise<UploadResult> {
  const key = r2KeyFromUrl(params.sourceUrl);
  if (key) {
    const object = await readStorageObject(key);
    if (!object) {
      throw new Error(`Source image not found: ${params.sourceUrl}`);
    }
    return uploadFile(params.destBucket, params.destPath, object.bytes, {
      contentType: params.contentType || object.contentType || 'image/png',
    });
  }

  const response = await fetch(params.sourceUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch source image: ${response.status} ${params.sourceUrl}`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return uploadFile(params.destBucket, params.destPath, bytes, {
    contentType:
      params.contentType || response.headers.get('content-type') || 'image/png',
  });
}
