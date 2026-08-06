import type { Meta, StoryObj } from '@storybook/react';
import type { Frame, ShotVariant } from '@/lib/db/schema';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { DivergenceCompareDialog } from './divergence-compare-dialog';

const NOW = new Date('2026-04-29T00:00:00Z');

// The still-image surface moved off `shots` onto the anchor `frame` in #989;
// the dialog reads the legacy projected names (`thumbnail*`/`image*`), so the
// fixture keeps them and adds the raw anchor `frame`.
const baseShot: ShotWithImage = {
  id: 'shot-1',
  sequenceId: 'seq-1',
  sceneId: null,
  shotNumber: 1,
  durationMs: 3000,
  thumbnailUrl: 'https://images.unsplash.com/photo-1502872364588-894d7d6ddfab',
  previewThumbnailUrl: null,
  thumbnailPath: null,
  variantImageUrl: null,
  variantImageStatus: 'pending',
  videoUrl: null,
  videoPath: null,
  thumbnailStatus: 'completed',
  thumbnailWorkflowRunId: null,
  imageModel: null,
  thumbnailError: null,
  imagePrompt: null,
  videoStatus: 'pending',
  videoWorkflowRunId: null,
  videoGeneratedAt: null,
  videoError: null,
  motionModel: null,
  motionPromptData: null,
  selectedMotionPromptVersionId: null,
  renderSegmentId: null,
  thumbnailInputHash: 'live-hash',
  videoInputHash: null,
  visualPromptInputHash: null,
  createdAt: NOW,
  updatedAt: NOW,
  frame: {
    id: 'shot-1',
    shotId: 'shot-1',
    sequenceId: 'seq-1',
    orderIndex: 0,
    role: 'first',
    previewImageUrl: null,
    imageStatus: 'completed',
    imageWorkflowRunId: null,
    imageError: null,
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    createdAt: NOW,
    updatedAt: NOW,
  } satisfies Frame,
};

function makeVariant(
  overrides: Partial<ShotVariant> & {
    variantType: ShotVariant['variantType'];
  }
): ShotVariant {
  return {
    id: 'variant-1',
    shotId: 'shot-1',
    sequenceId: 'seq-1',
    model: 'nano_banana_2',
    url: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee',
    storagePath: null,
    previewUrl: null,
    shotVariantUrl: null,
    shotVariantPath: null,
    shotVariantStatus: null,
    shotVariantWorkflowRunId: null,
    status: 'completed',
    workflowRunId: null,
    generatedAt: new Date(),
    error: null,
    promptHash: null,
    inputHash: 'snapshot-hash',
    divergedAt: new Date('2026-04-29T00:00:00Z'),
    discardedAt: null,
    durationMs: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const meta: Meta<typeof DivergenceCompareDialog> = {
  title: 'Scenes/DivergenceCompareDialog',
  component: DivergenceCompareDialog,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof DivergenceCompareDialog>;

export const ThumbnailVariant: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    shot: baseShot,
    variant: makeVariant({ variantType: 'image' }),
    onPromote: () => {},
    onDiscard: () => {},
    upstreamChanges: [
      'Character "Alex" — sheet regenerated',
      'Location "Warehouse" — recast',
    ],
  },
};

export const VideoVariant: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    shot: {
      ...baseShot,
      videoUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
    },
    variant: makeVariant({
      variantType: 'video',
      url: 'https://www.w3schools.com/html/movie.mp4',
    }),
    onPromote: () => {},
    onDiscard: () => {},
  },
};

export const Promoting: Story = {
  args: {
    ...ThumbnailVariant.args,
    isPromoting: true,
  },
};
