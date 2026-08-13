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
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { LibraryTalentSheetWorkflowInput } from '@/lib/workflow/types';
import { computeLibraryTalentSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';

const logger = getLogger(['openstory', 'talent', 'create-library-talent']);

export type CreateLibraryTalentInput = {
  name: string;
  description?: string;
  // Nullable to accept the drizzle-zod `createTalentSchema` shape directly.
  isFavorite?: boolean | null;
  isHuman?: boolean | null;
  /** Temp-upload URLs in the TALENT bucket; moved to permanent here. */
  referenceImageUrls?: string[];
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

  for (const tempUrl of tempUrls) {
    const tempPath = getPathFromUrl(tempUrl, STORAGE_BUCKETS.TALENT);
    const ext = getExtensionFromUrl(tempUrl);
    const mediaId = generateId();
    const permanentPath = `${ctx.teamId}/${newTalent.id}/${mediaId}.${ext}`;

    await moveFile(STORAGE_BUCKETS.TALENT, tempPath, permanentPath);

    const permanentUrl = getPublicUrl(STORAGE_BUCKETS.TALENT, permanentPath);
    permanentUrls.push(permanentUrl);

    await ctx.scopedDb.talent.media.create({
      talentId: newTalent.id,
      type: 'image',
      url: permanentUrl,
      path: permanentPath,
    });
  }

  // Trigger talent sheet generation (works with or without reference images).
  const workflowInput: LibraryTalentSheetWorkflowInput = {
    userId: ctx.user.id,
    teamId: ctx.teamId,
    talentId: newTalent.id,
    talentName: newTalent.name,
    talentDescription: newTalent.description ?? undefined,
    referenceImageUrls: [...permanentUrls].sort(),
    sheetName: 'Default Sheet',
  };
  workflowInput.snapshotInputHash =
    await computeLibraryTalentSheetHashFromDto(workflowInput);

  void triggerWorkflow('/library-talent-sheet', workflowInput, {
    label: buildWorkflowLabel(newTalent.id),
  }).catch((error) => {
    logger.error('Failed to trigger talent sheet workflow:', { err: error });
  });

  return newTalent;
}
