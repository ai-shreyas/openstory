/**
 * Shared core for creating a library talent: inserts the row, promotes any
 * reference images temp→permanent, and triggers the `/library-talent-sheet`
 * workflow (which writes `talent.defaultSheet`). Used by `createTalentFn` (the
 * dashboard serverFn) and the public API's one-shot resolver, so on-the-fly
 * talent created via the API gets a sheet generated — and the storyboard
 * workflow's `waitForTalentSheets` gate waits for it before casting.
 */

import { moveFile } from '#storage';
import {
  recordPortraitAttestation,
  requireLikenessAttachment,
  type LikenessRequestContext,
  type PortraitAttestationInput,
} from '@/lib/compliance/likeness-upload';
import { generateId } from '@/lib/db/id';
import type { Talent } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { getLogger } from '@/lib/observability/logger';
import {
  STORAGE_BUCKETS,
  getPathFromUrl,
  getPublicUrl,
} from '@/lib/storage/buckets';
import { getExtensionFromUrl } from '@/lib/utils/file';
import { getTalentChannel } from '@/lib/realtime';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { LibraryTalentSheetWorkflowInput } from '@/lib/workflow/types';
import { computeLibraryTalentSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';
import type { CharacterBibleEntry } from '@/lib/ai/scene-analysis.schema';
import {
  analyzeTalentMediaForTeam,
  sheetMetadataFromAnalysis,
} from './analyze-talent-media';

const logger = getLogger(['openstory', 'talent', 'create-library-talent']);

export type CreateLibraryTalentInput = {
  name: string;
  description?: string;
  // Nullable to accept the drizzle-zod `createTalentSchema` shape directly.
  isFavorite?: boolean | null;
  isHuman?: boolean | null;
  /** Temp-upload URLs in the TALENT bucket; moved to permanent here. */
  referenceImageUrls?: string[];
  /**
   * Subset of `referenceImageUrls` already classified as a character sheet.
   * `undefined` means classify server-side; `[]` means none are sheets.
   */
  characterSheetImageUrls?: string[];
  portraitAttestation?: PortraitAttestationInput;
};

export type CreateLibraryTalentContext = {
  scopedDb: ScopedDb;
  user: { id: string };
  teamId: string;
  request?: LikenessRequestContext;
};

export async function createLibraryTalent(
  input: CreateLibraryTalentInput,
  ctx: CreateLibraryTalentContext
): Promise<Talent> {
  const tempUrls = input.referenceImageUrls ?? [];
  const attestation = tempUrls.length
    ? requireLikenessAttachment({
        attestation: input.portraitAttestation,
      })
    : null;

  const newTalent = await ctx.scopedDb.talent.create({
    name: input.name,
    description: input.description,
    isFavorite: input.isFavorite ?? false,
    isHuman: input.isHuman ?? false,
    isInTeamLibrary: true,
  });

  if (attestation) {
    // Recorded before media so a failed insert cannot leave likeness bytes
    // without a warranty. The talent row exists either way.
    await recordPortraitAttestation({
      scopedDb: ctx.scopedDb,
      subjectId: newTalent.id,
      attestation,
      request: ctx.request,
    });
  }

  // Move temp files to permanent location and create media records.
  const permanentUrls: string[] = [];
  const tempToPermanent = new Map<string, string>();

  for (const tempUrl of tempUrls) {
    const tempPath = getPathFromUrl(tempUrl, STORAGE_BUCKETS.TALENT);
    const ext = getExtensionFromUrl(tempUrl);
    const mediaId = generateId();
    const permanentPath = `${ctx.teamId}/${newTalent.id}/${mediaId}.${ext}`;

    await moveFile(STORAGE_BUCKETS.TALENT, tempPath, permanentPath);

    const permanentUrl = getPublicUrl(STORAGE_BUCKETS.TALENT, permanentPath);
    permanentUrls.push(permanentUrl);
    tempToPermanent.set(tempUrl, permanentUrl);

    await ctx.scopedDb.talent.media.create({
      talentId: newTalent.id,
      type: 'image',
      url: permanentUrl,
      path: permanentPath,
    });
  }

  let uploadedSheetUrl: string | undefined;
  let uploadedSheetMetadata: CharacterBibleEntry | undefined;

  if (permanentUrls.length > 0) {
    const classifiedTempUrls = input.characterSheetImageUrls;
    if (classifiedTempUrls) {
      uploadedSheetUrl = classifiedTempUrls
        .map((url) => tempToPermanent.get(url))
        .find((url): url is string => Boolean(url));
    } else {
      for (const url of permanentUrls) {
        try {
          const analysis = await analyzeTalentMediaForTeam({
            scopedDb: ctx.scopedDb,
            userId: ctx.user.id,
            imageUrls: [url],
            idempotencyKey: `talent-vision:create:${newTalent.id}:${url}`,
          });
          if (analysis.isCharacterSheet) {
            uploadedSheetUrl = url;
            uploadedSheetMetadata = sheetMetadataFromAnalysis(
              newTalent.name,
              analysis
            );
            break;
          }
        } catch (error) {
          logger.warn('Talent-sheet classification failed; treating as photo', {
            err: error,
            talentId: newTalent.id,
          });
        }
      }
    }
  }

  // Trigger talent sheet generation. Always runs: if the user uploaded a
  // sheet we store that image; otherwise we generate a 4-panel (from
  // reference photos and/or the name + description).
  const workflowInput: LibraryTalentSheetWorkflowInput = {
    userId: ctx.user.id,
    teamId: ctx.teamId,
    talentId: newTalent.id,
    talentName: newTalent.name,
    talentDescription: newTalent.description ?? undefined,
    referenceImageUrls: [...permanentUrls].sort(),
    sheetName: uploadedSheetUrl ? 'Uploaded Sheet' : 'Default Sheet',
    uploadedSheetUrl,
    uploadedSheetMetadata,
  };
  workflowInput.snapshotInputHash =
    await computeLibraryTalentSheetHashFromDto(workflowInput);

  await getTalentChannel(newTalent.id).emit('talent.sheet:progress', {
    talentId: newTalent.id,
    status: 'generating',
  });

  void triggerWorkflow('/library-talent-sheet', workflowInput, {
    label: buildWorkflowLabel(newTalent.id),
  }).catch((error) => {
    logger.error('Failed to trigger talent sheet workflow:', { err: error });
    void getTalentChannel(newTalent.id)
      .emit('talent.sheet:progress', {
        talentId: newTalent.id,
        status: 'failed',
        error: 'Failed to start talent sheet generation',
      })
      .catch(() => undefined);
  });

  return newTalent;
}
