/**
 * Snapshot DTO hashers for the image workflow.
 *
 * `computeFromDto` hashes the inlined per-scene snapshot for the start-time
 * tamper check. `computeCurrent` re-resolves the live character / location /
 * element sheet hashes from the scoped DB so the workflow can detect upstream
 * drift between trigger and write time. In #989 a drift no longer routes to a
 * divergent `shot_variants` row — the image workflow simply appends the new
 * `frame_variants` version without repointing `frames.selectedImageVersionId`
 * (the retained-but-unselected version is the "divergence"). These hashers are
 * the unchanged staleness inputs.
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  ShotImageSceneSnapshot,
  ImageWorkflowInput,
} from '@/lib/workflow/types';
import {
  computeShotImageSceneHash,
  resolveSceneShotImageReferences,
} from './sheet-snapshots';

/**
 * Subset of `Scene` actually read by `computeImageWorkflowHashCurrent` —
 * keeping the narrow shape declared here so production `Scene` (a superset)
 * assigns cleanly while test stubs can build small literals.
 */
export type SceneForHash = {
  continuity?: {
    characterTags?: string[];
    environmentTag?: string;
    // nullable: `Scene.continuity.elementTags` is `.nullish()` (model emits
    // null when no elements) — keep this assignable from production `Scene`.
    elementTags?: string[] | null;
  } | null;
  metadata?: { location?: string } | null;
  originalScript?: { extract?: string } | null;
};

/**
 * Minimum scopedDb surface for `computeImageWorkflowHashCurrent`. Production
 * `ScopedDb` is a structural superset and assigns cleanly; tests can build
 * literal objects against this type without casting.
 */
export type ImageHashScopedDb = {
  shots: {
    getById: (id: string) => Promise<{ metadata: SceneForHash | null } | null>;
  };
  characters: {
    listWithSheets: (seqId: string) => Promise<CharacterMinimal[]>;
  };
  sequenceLocations: {
    listWithReferences: (seqId: string) => Promise<SequenceLocationMinimal[]>;
  };
  sequenceElements: {
    list: (seqId: string) => Promise<SequenceElementMinimal[]>;
  };
};

const NO_SNAPSHOT_SENTINEL = '';

function requireAspectRatio(
  input: ImageWorkflowInput
): NonNullable<ImageWorkflowInput['aspectRatio']> {
  if (!input.aspectRatio) {
    throw new WorkflowValidationError(
      'aspectRatio is required when sceneSnapshot is present; trigger-time and write-time hashes would otherwise diverge'
    );
  }
  return input.aspectRatio;
}

export function computeImageWorkflowHashFromDto(
  input: ImageWorkflowInput
): Promise<string> | string {
  if (!input.sceneSnapshot) {
    return input.snapshotInputHash ?? NO_SNAPSHOT_SENTINEL;
  }
  return computeShotImageSceneHash(
    input.sceneSnapshot,
    input.model ?? DEFAULT_IMAGE_MODEL,
    requireAspectRatio(input)
  );
}

export async function computeImageWorkflowHashCurrent(
  input: ImageWorkflowInput,
  scopedDb: ImageHashScopedDb
): Promise<string> {
  if (!input.sceneSnapshot)
    return input.snapshotInputHash ?? NO_SNAPSHOT_SENTINEL;

  const model = input.model ?? DEFAULT_IMAGE_MODEL;
  const aspectRatio = requireAspectRatio(input);

  if (!input.sequenceId || !input.shotId) {
    return computeShotImageSceneHash(input.sceneSnapshot, model, aspectRatio);
  }

  const shot = await scopedDb.shots.getById(input.shotId);
  // Deleted mid-flight: collapse to convergent so the workflow's
  // deleted-shot short-circuit handles the cleanup. Distinct from a shot
  // that exists with null metadata, which is data corruption — refuse.
  if (!shot) {
    return computeShotImageSceneHash(input.sceneSnapshot, model, aspectRatio);
  }
  if (!shot.metadata) {
    throw new WorkflowValidationError(
      `Shot ${input.shotId} exists but has null metadata; snapshot recompute requires scene metadata`
    );
  }

  const [characters, locations, elements] = await Promise.all([
    scopedDb.characters.listWithSheets(input.sequenceId),
    scopedDb.sequenceLocations.listWithReferences(input.sequenceId),
    scopedDb.sequenceElements.list(input.sequenceId),
  ]);

  const refs = resolveSceneShotImageReferences({
    scene: shot.metadata,
    characters,
    locations,
    elements,
  });

  const currentSnapshot: ShotImageSceneSnapshot = {
    sceneId: input.sceneSnapshot.sceneId,
    visualPrompt: input.sceneSnapshot.visualPrompt,
    characterSheetHashes: refs.characterSheetHashes,
    locationSheetHashes: refs.locationSheetHashes,
    elementReferenceHashes: refs.elementReferenceHashes,
  };

  return computeShotImageSceneHash(currentSnapshot, model, aspectRatio);
}
