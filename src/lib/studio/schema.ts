/**
 * Prompt-only Images and Videos (#1274). Client-safe: no env, no adapters.
 *
 * Sequence image + image-to-video models only — not the flagged `/models`
 * catalog. Video is still-then-motion: a prompt-only clip generates a still
 * with the chosen image model, then animates it with the chosen video model.
 */

import {
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { z } from 'zod';

const visibleImageModelKeys = Object.entries(IMAGE_MODELS)
  .filter(([, model]) => !('hidden' in model))
  .map(([key]) => key);

const imageModelKeySchema = z
  .string()
  .refine(
    (value): value is TextToImageModel =>
      isValidTextToImageModel(value) && visibleImageModelKeys.includes(value),
    { message: 'Unknown image model' }
  );

const videoModelKeySchema = z
  .string()
  .refine(
    (value): value is ImageToVideoModel => isValidImageToVideoModel(value),
    { message: 'Unknown video model' }
  );

const promptSchema = z
  .string()
  .trim()
  .min(1, 'Enter a prompt')
  .max(50_000, 'Prompt is too long');

const countSchema = z.number().int().min(1).max(4);

export const studioCreateInputSchema = z.discriminatedUnion('activity', [
  z.object({
    activity: z.literal('image'),
    prompt: promptSchema,
    imageModel: imageModelKeySchema,
    aspectRatio: aspectRatioSchema,
    count: countSchema.default(1),
  }),
  z.object({
    activity: z.literal('video'),
    prompt: promptSchema,
    imageModel: imageModelKeySchema,
    videoModel: videoModelKeySchema,
    aspectRatio: aspectRatioSchema,
    duration: z.number().positive(),
    count: countSchema.default(1),
    generateAudio: z.boolean().optional(),
  }),
]);

export type StudioCreateInput = z.infer<typeof studioCreateInputSchema>;

export type StudioKindFilter = 'all' | 'image' | 'video';

export type StudioSort = 'newest' | 'oldest';

type StudioCreateAsset = {
  id: string;
  workflowRunId: string;
};

export type StudioCreateResult = {
  assets: StudioCreateAsset[];
};

export function studioEndpointId(
  input: Pick<StudioCreateInput, 'activity'> & {
    imageModel: TextToImageModel;
    videoModel?: ImageToVideoModel;
  }
): string {
  if (input.activity === 'video') {
    if (!input.videoModel) {
      throw new Error('Video generation requires a video model');
    }
    return IMAGE_TO_VIDEO_MODELS[input.videoModel].id;
  }
  return IMAGE_MODELS[input.imageModel].id;
}

export function studioModelName(
  input: Pick<StudioCreateInput, 'activity'> & {
    imageModel: TextToImageModel;
    videoModel?: ImageToVideoModel;
  }
): string {
  if (input.activity === 'video') {
    if (!input.videoModel) {
      throw new Error('Video generation requires a video model');
    }
    return IMAGE_TO_VIDEO_MODELS[input.videoModel].name;
  }
  return IMAGE_MODELS[input.imageModel].name;
}
