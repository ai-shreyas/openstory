import type { Scene } from '@/lib/ai/scene-analysis.schema';
/**
 * Image-regeneration trigger input builder (#1077) — the exact payload
 * assembly `generateShotImageFn` performs (reference matching, model
 * resolution, credits preflight, scene snapshot + input hash), extracted so
 * `UpdateStaleShotsWorkflow` builds byte-identical `ImageWorkflowInput`s
 * server-side without duplicating the logic.
 */

import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { resolveImageModel } from '@/lib/ai/resolve-asset-models';
import { estimateImageCost, gateEstimate } from '@/lib/billing/cost-estimation';
import { requireCredits } from '@/lib/billing/preflight';
import {
  aspectRatioToImageSize,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import type { Frame, SequenceLocation, Shot } from '@/lib/db/schema';
import { locationMatchesTag } from '@/lib/db/scoped/sequence-locations';
import type { ScopedDb } from '@/lib/db/scoped';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { buildUserEditProvenance } from '@/lib/prompts/user-edit-provenance';
import type {
  ImageWorkflowInput,
  ShotImageSceneSnapshot,
} from '@/lib/workflow/types';
import { shouldRecordUserEdit } from '@/lib/workflows/user-edit-predicate';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import { computeShotImageSceneHash } from '@/lib/workflows/sheet-snapshots';

/** Match locations by environmentTag or scene location and return reference images. */
export function getSceneLocationReferenceImages(
  allLocations: SequenceLocation[],
  environmentTag: string,
  sceneLocation?: string
): ReferenceImageDescription[] {
  if (!environmentTag && !sceneLocation) return [];

  const matchedLocations = allLocations.filter(
    (loc) =>
      (environmentTag && locationMatchesTag(loc, environmentTag)) ||
      (sceneLocation && locationMatchesTag(loc, sceneLocation))
  );

  return buildLocationReferenceImages(matchedLocations);
}

/**
 * Build the `/image` workflow payload for a shot from CURRENT scoped state.
 * Steps: resolve prompt (override > stored anchor-frame mirror > description)
 * → match character/location/element references → resolve the model
 * (explicit > last failed attempt > selected version > sequence default) →
 * credits preflight → scene snapshot + input hash (what makes the rendered
 * image participate in staleness tracking).
 *
 * Throws when the shot has no prompt/description, and rethrows the credits
 * preflight's `InsufficientCreditsError`.
 */
export async function prepareShotImageWorkflowInput(args: {
  scopedDb: ScopedDb;
  sequence: {
    id: string;
    teamId: string;
    aspectRatio: AspectRatio;
    imageModel: string | null;
    styleId: string | null;
    analysisModel: string;
  };
  shot: Shot;
  frame: Frame;
  /** The shot's scene, composed from `scenes` + its selected script version. */
  scene: Scene | null;
  /** Selected scene-script extract, for element matching. */
  scriptExtract: string;
  userId: string;
  promptOverride?: string;
  modelOverride?: ImageWorkflowInput['model'];
  /** True only when `promptOverride` came from a user edit (drives rescan upstream). */
  userEditedPrompt?: boolean;
}): Promise<ImageWorkflowInput> {
  const {
    scopedDb,
    sequence,
    shot,
    frame,
    scene,
    scriptExtract,
    userId,
    promptOverride,
    modelOverride,
    userEditedPrompt = false,
  } = args;

  // Priority: provided > the frame's selected prompt version > scene script.
  const selectedPrompt = await scopedDb.framePromptVersions.getSelected(
    frame.id
  );
  const prompt = promptOverride || selectedPrompt?.text || scriptExtract;
  if (!prompt) {
    throw new Error('Shot has no prompt or description to regenerate from');
  }

  // Decided HERE, not in the workflow: whether this is a real edit depends on
  // the prompt the user was looking at, and the provenance hash must describe
  // the inputs as they were at that moment.
  const userEditProvenance = shouldRecordUserEdit({
    userEditedPrompt,
    prompt,
    currentPrompt: selectedPrompt?.text ?? null,
  })
    ? await buildUserEditProvenance({
        kind: 'visual',
        scopedDb,
        sequence,
        scene,
      })
    : undefined;

  const continuity = scene?.continuity;

  const allCharacters = await scopedDb.characters.listWithSheets(sequence.id);
  const matchedCharacters = matchCharactersToScene(
    allCharacters,
    continuity?.characterTags ?? []
  );
  const characterReferences = buildCharacterReferenceImages(matchedCharacters);

  const allLocations = await scopedDb.sequenceLocations.listWithReferences(
    sequence.id
  );
  const matchedLocations = matchLocationsToScene(
    allLocations,
    continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? ''
  );
  const locationReferences = getSceneLocationReferenceImages(
    allLocations,
    continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? ''
  );

  const allElements = await scopedDb.sequenceElements.list(sequence.id);
  const matchedElements = matchElementsToScene(
    allElements,
    continuity?.elementTags ?? [],
    scriptExtract
  );
  const elementReferences = buildElementReferenceImages(matchedElements);

  // Model identity lives on the version that produced the still (#1066): an
  // explicit per-request model wins (one-off variant generation), else the
  // model of a failed attempt still awaiting retry, else the frame's
  // currently selected version, then the sequence default.
  const [selectedVersion, lastFailed] = await Promise.all([
    scopedDb.frameVariants.getSelected(frame.id),
    scopedDb.frameVariants.getLastFailed(frame.id),
  ]);
  const model = resolveImageModel({
    explicit: modelOverride,
    lastFailedAttemptModel: lastFailed?.model,
    selectedVersionModel: selectedVersion?.model,
    sequenceModel: sequence.imageModel,
  });

  await requireCredits(
    scopedDb,
    gateEstimate(
      estimateImageCost(model, sequence.aspectRatio, 1, {
        pricing: await getEffectiveFalPricing(),
      }),
      { model, operation: 'shot-image' }
    ),
    { errorMessage: 'Insufficient credits for image generation' }
  );

  // Build a per-scene snapshot so the image workflow records a non-null
  // `thumbnailInputHash`. Without this the convergent write path stores
  // `null`, and the staleness check loses the ability to flip back to
  // 'stale' on a future prompt regenerate. The sceneId fallback covers
  // legacy shots generated before scene metadata was attached.
  const sortedHashes = (
    values: ReadonlyArray<string | null | undefined>
  ): string[] =>
    values
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .sort();
  const sceneSnapshot: ShotImageSceneSnapshot = {
    sceneId: scene?.sceneId ?? shot.id,
    visualPrompt: prompt,
    characterSheetHashes: sortedHashes(
      matchedCharacters.map((c) => c.sheetInputHash)
    ),
    locationSheetHashes: sortedHashes(
      matchedLocations.map((l) => l.referenceInputHash)
    ),
    elementReferenceHashes: sortedHashes(
      matchedElements.map((e) => e.imageUrl)
    ),
  };
  const snapshotInputHash = await computeShotImageSceneHash(
    sceneSnapshot,
    model,
    sequence.aspectRatio
  );

  return {
    userId,
    teamId: sequence.teamId,
    prompt,
    model,
    imageSize: aspectRatioToImageSize(sequence.aspectRatio),
    numImages: 1,
    shotId: shot.id,
    sequenceId: sequence.id,
    aspectRatio: sequence.aspectRatio,
    sceneSnapshot,
    snapshotInputHash,
    referenceImages: [
      ...characterReferences,
      ...locationReferences,
      ...elementReferences,
    ],
    userEditProvenance,
  };
}
