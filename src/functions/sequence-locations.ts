import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { safeTextToImageModel } from '@/lib/ai/models';
import { type SequenceLocation } from '@/lib/db/schema';
import { resolveSequenceStyleConfig } from '@/lib/style/style-config';
import { getGenerationChannel } from '@/lib/realtime';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { RecastLocationWorkflowInput } from '@/lib/workflow/types';
import { buildRecastRegenerateSnapshots } from '@/lib/workflows/recast-snapshot';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';

/** Narrow DB text column to the typed union, defaulting to 'interior'. */
function parseLocationType(
  value: string | null
): 'interior' | 'exterior' | 'both' {
  if (value === 'interior' || value === 'exterior' || value === 'both') {
    return value;
  }
  return 'interior';
}

/** Convert flat DB columns to the nested LocationBibleEntry shape. */
function toLocationMetadata(
  location: SequenceLocation
): RecastLocationWorkflowInput['locationMetadata'] {
  return {
    locationId: location.locationId,
    name: location.name,
    type: parseLocationType(location.type),
    timeOfDay: location.timeOfDay ?? '',
    description: location.description ?? '',
    architecturalStyle: location.architecturalStyle ?? '',
    keyFeatures: location.keyFeatures ?? '',
    colorPalette: location.colorPalette ?? '',
    lightingSetup: location.lightingSetup ?? '',
    ambiance: location.ambiance ?? '',
    consistencyTag: location.consistencyTag ?? '',
    firstMention: {
      sceneId: location.firstMentionSceneId ?? '',
      text: location.firstMentionText ?? '',
      lineNumber: location.firstMentionLine ?? 0,
    },
  };
}

export const getSequenceLocationsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceLocations.list(context.sequence.id);
  });

export const getTeamLocationsLibraryFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceLocations.getTeamLibrary(context.teamId, {
      completedOnly: false,
    });
  });

const getShotIdsForLocationInputSchema = z.object({
  locationId: z.string().min(1),
});

export const getShotIdsForLocationFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(getShotIdsForLocationInputSchema))
  .handler(async ({ context, data }) => {
    const shotIds =
      await context.scopedDb.sequenceLocations.getShotIdsForLocation(
        context.sequence.id,
        data.locationId
      );
    return { shotIds, count: shotIds.length };
  });

const recastLocationInputSchema = z.object({
  locationId: z.string().min(1),
  libraryLocationId: z.string().min(1),
  referenceImageUrl: mediaUrlSchema,
  description: z.string().optional(),
});

/**
 * Recast a location with a library location reference.
 * Triggers location reference regeneration and shot regeneration.
 */
export const recastLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(recastLocationInputSchema))
  .handler(async ({ context, data }) => {
    const location = await context.scopedDb.sequenceLocations.getById(
      data.locationId
    );
    if (!location) {
      throw new Error('Location not found');
    }

    // Fetch the sequence's style for location sheet generation
    const sequence = await context.scopedDb.sequences.getForUser({
      sequenceId: location.sequenceId,
    });
    const style =
      sequence.styleConfig == null && sequence.styleId
        ? await context.scopedDb.styles.getById(sequence.styleId)
        : null;
    const styleConfig =
      sequence.styleConfig != null || style
        ? resolveSequenceStyleConfig({
            snapshot: sequence.styleConfig,
            live: style?.config,
          })
        : undefined;

    // Bind the sequence location to the library location it was recast from.
    // Without this the downstream divergence check resolves the OLD (usually
    // null) link and compares against a hash from the new one.
    const libraryLocation = await context.scopedDb.locations.getById(
      data.libraryLocationId
    );
    if (!libraryLocation) {
      throw new Error('Library location not found');
    }
    const updatedLocation = await context.scopedDb.sequenceLocations.update(
      data.locationId,
      { libraryLocationId: data.libraryLocationId }
    );

    await context.scopedDb.sequenceLocations.updateReferenceStatus(
      data.locationId,
      'generating'
    );

    await getGenerationChannel(location.sequenceId).emit(
      'generation.location-sheet:progress',
      { locationId: data.locationId, status: 'generating' }
    );

    const affectedShotIds =
      await context.scopedDb.sequenceLocations.getShotIdsForLocation(
        location.sequenceId,
        data.locationId
      );

    // Freeze every regenerate-shots input here, at the trigger. The workflow
    // used to rebuild this after its sheet child finished — eight live reads
    // against state the user never authorised.
    const imageModel = safeTextToImageModel(sequence.imageModel);
    const { shotSnapshots, snapshotInputHash } =
      await buildRecastRegenerateSnapshots({
        scopedDb: context.scopedDb,
        sequenceId: location.sequenceId,
        shotIds: affectedShotIds,
        imageModel,
        aspectRatio: sequence.aspectRatio,
        subject: { kind: 'location', location: updatedLocation },
      });

    const workflowRunId = await triggerWorkflow(
      '/recast-location',
      {
        locationDbId: data.locationId,
        locationName: location.name,
        locationMetadata: toLocationMetadata(location),
        sequenceId: location.sequenceId,
        teamId: context.teamId,
        userId: context.user.id,
        referenceImageUrl: data.referenceImageUrl,
        libraryLocationDescription: data.description,
        libraryLocationId: data.libraryLocationId,
        libraryLocationReferenceHash: libraryLocation.referenceInputHash,
        imageModel,
        styleConfig,
        aspectRatio: sequence.aspectRatio,
        shotSnapshots,
        snapshotInputHash,
      } satisfies RecastLocationWorkflowInput,
      { label: buildWorkflowLabel(location.sequenceId) }
    );

    return {
      locationId: data.locationId,
      referenceWorkflowRunId: workflowRunId,
      // The shots actually queued — a shot with no selected image prompt is
      // dropped by the snapshot builder rather than failing the recast.
      affectedShotIds: shotSnapshots.map((s) => s.shotId),
    };
  });
