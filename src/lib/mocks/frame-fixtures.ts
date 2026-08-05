/**
 * Fixture helper: rebuild the `(frame, selectedVersion)` pair that
 * `projectShotWithImage` consumes, from an already-flat `ShotWithImage`.
 *
 * Stories and fixtures author shots in the CLIENT shape (`thumbnailUrl`,
 * `imageModel`, …) because that is what the components read. The projection
 * takes the two DB rows instead, so these tests have to run it backwards. Since
 * #1067 that means splitting the flat shape across BOTH rows — identity and the
 * primary-render lifecycle onto the frame, the still itself onto a synthetic
 * `frame_variants` version — which is fiddly enough to be worth one helper
 * rather than six hand-maintained copies that drift.
 *
 * `selectedVersion` is null when the shot has no still, matching a real frame
 * whose `selectedImageVersionId` was never set.
 */

import type { Frame, FrameVariant } from '@/lib/db/schema';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';

/** The flat client-shaped fields this helper splits back into two rows. */
type FlatImageSurface = Pick<
  ShotWithImage,
  | 'id'
  | 'sequenceId'
  | 'thumbnailUrl'
  | 'previewThumbnailUrl'
  | 'thumbnailPath'
  | 'thumbnailStatus'
  | 'thumbnailWorkflowRunId'
  | 'thumbnailError'
  | 'thumbnailInputHash'
  | 'imageModel'
  | 'imagePrompt'
  | 'visualPromptInputHash'
  | 'createdAt'
  | 'updatedAt'
>;

export function frameFixtureFor(
  shot: FlatImageSurface,
  // Fixture-only id reuse: these rows are never persisted and never looked up
  // by id, so sharing the shot's id keeps snapshots stable. Real frames get
  // their own ULID (#989) — pass an id here to assert nothing relies on reuse.
  frameId: string = shot.id
): {
  frame: Frame;
  selectedVersion: FrameVariant | null;
} {
  const versionId = shot.thumbnailUrl === null ? null : `${frameId}-v1`;
  const frame: Frame = {
    id: frameId,
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    orderIndex: 0,
    role: 'first',
    previewImageUrl: shot.previewThumbnailUrl,
    imageStatus: shot.thumbnailStatus,
    imageWorkflowRunId: shot.thumbnailWorkflowRunId,
    imageError: shot.thumbnailError,
    imagePrompt: shot.imagePrompt,
    selectedImageVersionId: versionId,
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    visualPromptInputHash: shot.visualPromptInputHash,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  };
  if (versionId === null) return { frame, selectedVersion: null };
  return {
    frame,
    selectedVersion: selectedVersionFixture({
      id: versionId,
      frameId,
      sequenceId: shot.sequenceId,
      model: shot.imageModel ?? 'nano_banana_2',
      url: shot.thumbnailUrl,
      storagePath: shot.thumbnailPath,
      workflowRunId: shot.thumbnailWorkflowRunId,
      generatedAt: shot.updatedAt,
      inputHash: shot.thumbnailInputHash,
      createdAt: shot.createdAt,
      updatedAt: shot.updatedAt,
    }),
  };
}

/**
 * A completed `frame_variants` row — for fixtures that build their frame by
 * hand rather than projecting one from a flat shot.
 */
export function selectedVersionFixture(
  overrides: Partial<FrameVariant> &
    Pick<FrameVariant, 'frameId' | 'sequenceId' | 'url'>
): FrameVariant {
  const now = new Date();
  return {
    id: 'fv-1',
    kind: 'model',
    model: 'nano_banana_2',
    sourceVariantId: null,
    storagePath: null,
    previewUrl: null,
    status: 'completed',
    workflowRunId: null,
    generatedAt: now,
    error: null,
    promptHash: null,
    inputHash: null,
    pendingInputHash: null,
    dependsOnVersionId: null,
    promptVersionId: null,
    discardedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
