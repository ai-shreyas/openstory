/**
 * Core sequence-creation logic, shared by the `createSequenceFn` server
 * function (dashboard) and the public API's one-shot endpoint. Both arrive here
 * with a fully-resolved `CreateSequenceInput` (style id, model keys, element
 * uploads), so credit pre-flight, per-analysis-model fan-out, element promotion,
 * and the `/storyboard` trigger live in exactly one place.
 *
 * Returns the created sequences alongside their workflow run ids — the public
 * API surfaces the run ids to callers; the dashboard server fn ignores them.
 */

import {
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  isValidAudioModel,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import { resolveAudioModels } from '@/lib/ai/resolve-audio-models';
import { resolveImageModels } from '@/lib/ai/resolve-image-models';
import { resolveVideoModels } from '@/lib/ai/resolve-video-models';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { requireCredits } from '@/lib/billing/preflight';
import { estimateStoryboardPreflightCost } from '@/lib/billing/storyboard-preflight-cost';
import { generateId } from '@/lib/db/id';
import type { ScopedDb } from '@/lib/db/scoped';
import { ValidationError } from '@/lib/errors';
import {
  AUTO_STYLE_ID,
  type AutoStyleDraft,
  placeholderAutoStyleDraft,
} from '@/lib/style/auto-style';
import { parseStyleConfig } from '@/lib/style/style-config';
import type { Sequence } from '@/types/database';
import type { CreateSequenceInput } from '@/lib/schemas/sequence.schemas';
import { copySequenceElements } from '@/lib/sequence-elements/copy-sequence-elements';
import { promoteTempElements } from '@/lib/sequence-elements/promote-temp-elements';
import { captureProductEvent } from '@/lib/observability/product-events';
import { bumpStylePopularity } from '@/lib/style/bump-style-popularity';
import { triggerStoryboard } from '@/lib/workflow/launchers';
import type { StoryboardTriggerInput } from '@/lib/workflow/types';
import { createServerOnlyFn } from '@tanstack/react-start';

type StyleSource =
  | { kind: 'library' }
  /** Fresh automatic style: placeholder row now, recipe derived by the run. */
  | { kind: 'pending'; draft: AutoStyleDraft }
  /** Copy of another sequence's (already derived) automatic style. */
  | { kind: 'clone'; draft: AutoStyleDraft };

async function resolveStyleSource(
  scopedDb: ScopedDb,
  styleId: string
): Promise<StyleSource> {
  if (styleId === AUTO_STYLE_ID) {
    return { kind: 'pending', draft: placeholderAutoStyleDraft() };
  }
  const style = await scopedDb.styles.getById(styleId);
  if (!style) {
    throw new ValidationError(`Style ${styleId} not found`);
  }
  if (style.sequenceId === null) return { kind: 'library' };
  if (style.teamId !== scopedDb.teamId) {
    throw new ValidationError(`Style ${styleId} not found`);
  }
  return {
    kind: 'clone',
    draft: {
      name: style.name,
      description: style.description,
      config: parseStyleConfig(style.config),
      category: style.category,
      tags: style.tags ?? [],
    },
  };
}

export type CreateSequencesContext = {
  scopedDb: ScopedDb;
  user: { id: string };
  teamId: string;
};

export type CreateSequencesResult = {
  sequences: Sequence[];
  /** Aligned 1:1 with `sequences` — the `/storyboard` run id for each. */
  workflowRunIds: string[];
  /** Paired view, convenient for callers that need both together. */
  entries: Array<{ sequence: Sequence; workflowRunId: string }>;
};

export const createSequences = createServerOnlyFn(
  async (
    data: CreateSequenceInput,
    context: CreateSequencesContext
  ): Promise<CreateSequencesResult> => {
    // The scoped DB IS the authorization boundary: middleware resolved the
    // caller's team and built `context.scopedDb`/`context.teamId` for it, so
    // every write below is already team-authorized. (The old `data.teamId`
    // override was vestigial — writes always went through the scoped db anyway.)
    const teamId = context.teamId;

    const {
      script,
      styleId,
      aspectRatio,
      analysisModels,
      imageModel: imageModelLegacy,
      imageModels: imageModelsInput,
      videoModel,
      videoModels: videoModelsInput,
      autoGenerateMotion = true,
      autoGenerateMusic = true,
      musicModel,
      audioModels: audioModelsInput,
      targetDurationSeconds,
      suggestedTalentIds,
      suggestedLocationIds,
      elementUploads,
      sourceSequenceId,
    } = data;

    // Verify source sequence access (scoped read returns null for other teams)
    if (sourceSequenceId) {
      const source = await context.scopedDb.sequences.getById(sourceSequenceId);
      if (!source) {
        throw new Error('Source sequence not found');
      }
    }

    // Validate and resolve image models
    const validatedModels = imageModelsInput.map((m) =>
      safeTextToImageModel(m)
    );
    const imageModels = resolveImageModels(
      validatedModels,
      imageModelLegacy ? safeTextToImageModel(imageModelLegacy) : undefined
    );
    const [primaryImageModel] = imageModels;
    if (!primaryImageModel) {
      throw new Error(
        'Expected resolveImageModels to return at least one model'
      );
    }

    // Validate and resolve video models (mirrors the image-model handling).
    const validatedVideoModels = videoModelsInput.map((m) =>
      safeImageToVideoModel(m, DEFAULT_VIDEO_MODEL)
    );
    const videoModels = resolveVideoModels(
      validatedVideoModels,
      videoModel
        ? safeImageToVideoModel(videoModel, DEFAULT_VIDEO_MODEL)
        : undefined
    );
    const [primaryVideoModel] = videoModels;
    if (!primaryVideoModel) {
      throw new Error(
        'Expected resolveVideoModels to return at least one model'
      );
    }

    // Validate and resolve audio models (sequence-level, mirrors the pattern).
    const validatedAudioModels = audioModelsInput?.map((m) =>
      safeAudioModel(m, DEFAULT_MUSIC_MODEL)
    );
    const audioModels = resolveAudioModels(
      validatedAudioModels,
      musicModel && isValidAudioModel(musicModel)
        ? safeAudioModel(musicModel, DEFAULT_MUSIC_MODEL)
        : undefined
    );
    const [primaryAudioModel] = audioModels;
    if (!primaryAudioModel) {
      throw new Error(
        'Expected resolveAudioModels to return at least one model'
      );
    }

    if (!styleId || !aspectRatio) {
      throw new Error('Style ID and aspect ratio are required');
    }

    await requireCredits(
      context.scopedDb,
      estimateStoryboardPreflightCost({
        script,
        imageModel: primaryImageModel,
        imageModelCount: imageModels.length,
        aspectRatio,
        autoGenerateMotion,
        videoModels,
        autoGenerateMusic,
        audioModels,
        // Align with Generate ActionCost (duration chip → scene count + clip length).
        targetDurationSeconds,
        pricing: await getEffectiveFalPricing(),
      }),
      {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to generate storyboard',
      }
    );

    // Automatic style (#1213). `'auto'` asks for a fresh script-derived style;
    // a style already bound to another sequence (regenerate / copy of an auto
    // sequence) is cloned rather than shared, so each sequence owns its row.
    const styleSource = await resolveStyleSource(context.scopedDb, styleId);

    const created = await Promise.all(
      analysisModels.map(async (modelId) => {
        // Only persist video/music model choices when the user actually opts
        // into auto-generation. Otherwise the sequence ends up with a "ghost"
        // model preference the user never picked, which surfaces stale values
        // in the header chip and batch footer. Tracked in #714.
        const persistedMusicModel = autoGenerateMusic
          ? primaryAudioModel
          : undefined;

        const sequenceId = generateId();
        const boundStyle =
          styleSource.kind === 'library'
            ? null
            : await context.scopedDb.styles.createForSequence({
                sequenceId,
                draft: styleSource.draft,
              });

        const sequence = await context.scopedDb.sequences.create({
          id: sequenceId,
          title: data.title || 'Untitled Sequence',
          script: data.script,
          styleId: boundStyle?.id ?? styleId,
          // A placeholder recipe must not be frozen — the run derives the real one.
          deferStyleSnapshot: styleSource.kind === 'pending',
          aspectRatio,
          analysisModel:
            getAnalysisModelById(modelId)?.id || DEFAULT_ANALYSIS_MODEL,
          imageModel: primaryImageModel,
          videoModel: autoGenerateMotion ? primaryVideoModel : undefined,
          musicModel: persistedMusicModel,
          autoGenerateMotion,
          autoGenerateMusic,
          suggestedTalentIds: suggestedTalentIds?.length
            ? suggestedTalentIds
            : undefined,
          suggestedLocationIds: suggestedLocationIds?.length
            ? suggestedLocationIds
            : undefined,
        });

        // Promote any draft element uploads to this new sequence (temp → final
        // path + insert rows + trigger vision). Runs before workflow trigger
        // so analyze-script-workflow can wait for vision to complete.
        if (elementUploads && elementUploads.length > 0) {
          await promoteTempElements({
            scopedDb: context.scopedDb,
            teamId,
            userId: context.user.id,
            sequenceId: sequence.id,
            uploads: elementUploads,
          });
        }

        // Carry forward elements from the source sequence when regenerating.
        if (sourceSequenceId) {
          await copySequenceElements({
            scopedDb: context.scopedDb,
            teamId,
            userId: context.user.id,
            sourceSequenceId,
            targetSequenceId: sequence.id,
          });
        }

        const workflowInput: StoryboardTriggerInput = {
          userId: context.user.id,
          teamId,
          sequenceId: sequence.id,
          imageModels,
          videoModels,
          options: {
            shotsPerScene: 3,
            generateThumbnails: true,
            generateDescriptions: true,
            aiProvider: 'openrouter',
            regenerateAll: true,
          },
          autoGenerateMotion,
          autoGenerateMusic,
          musicModel: autoGenerateMusic ? primaryAudioModel : undefined,
          audioModels: autoGenerateMusic ? audioModels : undefined,
          suggestedTalentIds,
          suggestedLocationIds,
        };

        const { workflowRunId } = await triggerStoryboard(
          context.scopedDb,
          workflowInput
        );

        return { sequence, workflowRunId };
      })
    );

    // One click = one popularity bump + one analytics event, regardless of how
    // many analysis models the caller picked. Fire-and-forget — never block.
    const sequenceIds = created.map((c) => c.sequence.id);
    if (styleSource.kind === 'library') {
      bumpStylePopularity({
        scopedDb: context.scopedDb,
        styleId,
        sequenceIds,
        teamId,
        userId: context.user.id,
      });
    }

    // Server-side so dashboard + public API both feed #product-alerts (#1088).
    captureProductEvent({
      distinctId: context.user.id,
      event: 'sequence_generated',
      properties: {
        team_id: teamId,
        style_id: styleId,
        automatic_style: styleSource.kind !== 'library',
        aspect_ratio: aspectRatio,
        sequence_ids: sequenceIds,
        sequence_count: sequenceIds.length,
        analysis_model_count: analysisModels.length,
        image_models: imageModels,
        video_models: videoModels,
        audio_models: audioModels,
        auto_generate_motion: autoGenerateMotion,
        auto_generate_music: autoGenerateMusic,
        script_length: data.script.length,
        source: sourceSequenceId ? 'regenerate' : 'create',
      },
    });

    return {
      sequences: created.map((c) => c.sequence),
      workflowRunIds: created.map((c) => c.workflowRunId),
      entries: created,
    };
  }
);
