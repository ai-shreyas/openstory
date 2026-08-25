/**
 * /api/v1/sequences/$id/exports — server-side MP4 export for the public API.
 *
 *   POST — start a server-side export. Reserves a `sequence_exports` row
 *          (status `processing`) and triggers `SequenceExportWorkflow`, which
 *          renders the stitched MP4 in the video-export Cloudflare Container
 *          and streams it to R2. Responds 202; poll the GET endpoint.
 *   GET  — list this sequence's exports (any status) so an agent can poll for
 *          the `ready` URL.
 *
 * Team-scoped via `authWithTeamRequestMiddleware`; a key only sees its own
 * team's sequences. The browser-side export (`use-sequence-export`) is
 * untouched — both producers write the same `sequence_exports` table.
 */

import { authWithTeamRequestMiddleware } from '@/functions/middleware';
import { runApiV1Handler } from '@/lib/api-v1/errors';
import {
  API_V1_BASE,
  getLink,
  waitLink,
  withLinks,
  type HalLinks,
} from '@/lib/api-v1/hal';
import type { SequenceExport } from '@/lib/db/schema';
import { generateId } from '@/lib/db/id';
import { NotFoundError, ValidationError } from '@/lib/errors';
import {
  STORAGE_BUCKETS,
  getPublicUrl,
  toShareableUrl,
} from '@/lib/storage/buckets';
import { triggerWorkflow } from '@/lib/workflow/client';
import type { SequenceExportWorkflowInput } from '@/lib/workflow/types';
import { createFileRoute } from '@tanstack/react-router';

const EXPORT_FILENAME_SUFFIX = '_openstory.mp4';

// A `processing` row older than the workflow's worst-case render time is
// assumed dead (the worker crashed before `onFailure` ran). The render step is
// `timeout: 15m` with one retry (+10s delay), so a live export can legitimately
// run ~30m; pad past that so we only reconcile genuinely-orphaned rows. Such a
// stale row is marked `failed` (freeing the one-processing-row slot) rather
// than blocking new exports forever.
const STALE_PROCESSING_MS = 35 * 60 * 1000;

function buildExportPath(teamId: string, sequenceId: string): string {
  return `teams/${teamId}/sequences/${sequenceId}/exports/${generateId().slice(-8)}${EXPORT_FILENAME_SUFFIX}`;
}

function formatExport(row: SequenceExport, origin: string) {
  return {
    id: row.id,
    status: row.status,
    // The file only exists once `ready`; absolutize the stored `/r2/...` URL.
    url: row.status === 'ready' ? toShareableUrl(row.url, origin) : null,
    durationSeconds: row.durationSeconds,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

function exportsLinks(sequenceId: string): HalLinks {
  const base = `${API_V1_BASE}/sequences/${sequenceId}`;
  return {
    self: waitLink(`${base}/exports`, "List/poll this sequence's exports"),
    'create-export': {
      href: `${base}/exports`,
      method: 'POST',
      title: 'Start a server-side MP4 export of this sequence',
      contentType: 'application/json',
      examples: [{}],
    },
    sequence: getLink(base, 'Sequence status document'),
  };
}

export const Route = createFileRoute('/api/v1/sequences/$id/exports')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      GET: async ({ params, context, request }) =>
        runApiV1Handler(async () => {
          const sequence = await context.scopedDb.sequences.getById(params.id);
          if (!sequence) throw new NotFoundError('Sequence not found');

          const origin = new URL(request.url).origin;
          const exports =
            await context.scopedDb.sequenceExports.listAllBySequence(params.id);
          return Response.json(
            withLinks(
              {
                sequenceId: params.id,
                exports: exports.map((e) => formatExport(e, origin)),
              },
              exportsLinks(params.id)
            )
          );
        }),

      POST: async ({ params, context, request }) =>
        runApiV1Handler(async () => {
          const sequence = await context.scopedDb.sequences.getById(params.id);
          if (!sequence) throw new NotFoundError('Sequence not found');

          const origin = new URL(request.url).origin;

          // Resolve the cut here, before anything is reserved: the workflow
          // renders this snapshot and reads no DB, so a shot finishing
          // mid-render can't change the list under it. Ready clips export
          // even if siblings are still generating (#1286).
          const shots = await context.scopedDb.shots.listBySequence(params.id, {
            orderBy: 'sceneOrder',
            ascending: true,
          });
          if (shots.length === 0) {
            throw new ValidationError('Sequence has no shots yet');
          }
          // Each shot's video is the version its render segment points at
          // (#1067 phase 2d) — one batched read for the whole sequence.
          const selectedVideoByShot =
            await context.scopedDb.videoVariants.getSelectedByShotIds(
              shots.map((s) => s.id)
            );
          const scenes = shots
            .flatMap((s) => {
              const url = selectedVideoByShot.get(s.id)?.url;
              return url ? [url] : [];
            })
            .map((videoUrl, orderIndex) => ({ orderIndex, videoUrl }));
          if (scenes.length === 0) {
            throw new ValidationError('No scene videos are ready yet');
          }

          // Coalesce: reuse the in-flight export instead of spawning a
          // duplicate render. A stale row means the worker crashed before
          // `onFailure` ran — mark it failed so it stops blocking new exports
          // (and frees the one-processing-row unique slot).
          const existing =
            await context.scopedDb.sequenceExports.listAllBySequence(params.id);
          const inFlight = existing.find((e) => e.status === 'processing');
          if (inFlight) {
            if (
              Date.now() - inFlight.createdAt.getTime() <
              STALE_PROCESSING_MS
            ) {
              return Response.json(
                withLinks(
                  { export: formatExport(inFlight, origin) },
                  exportsLinks(params.id)
                ),
                { status: 202 }
              );
            }
            await context.scopedDb.sequenceExports.markFailed(
              inFlight.id,
              'Export timed out — no result from the render worker'
            );
          }

          // Reserve the row BEFORE triggering so a crash between the two
          // leaves a row the stale sweep above can reconcile. `created: false`
          // means a concurrent POST won the one-processing-row race — coalesce
          // onto its row rather than starting a second workflow.
          const path = buildExportPath(context.teamId, params.id);
          const { row, created } =
            await context.scopedDb.sequenceExports.createProcessing({
              sequenceId: params.id,
              url: getPublicUrl(STORAGE_BUCKETS.VIDEOS, path),
              storagePath: path,
            });
          if (!created) {
            return Response.json(
              withLinks(
                { export: formatExport(row, origin) },
                exportsLinks(params.id)
              ),
              { status: 202 }
            );
          }

          const workflowRunId =
            await triggerWorkflow<SequenceExportWorkflowInput>(
              'sequence-export',
              {
                userId: context.user.id,
                teamId: context.teamId,
                sequenceId: params.id,
                exportId: row.id,
                storagePath: path,
                scenes,
                musicUrl:
                  sequence.includeMusic && sequence.musicUrl
                    ? sequence.musicUrl
                    : null,
              }
            );
          await context.scopedDb.sequenceExports.setWorkflowRunId(
            row.id,
            workflowRunId
          );

          return Response.json(
            withLinks(
              { export: { ...formatExport(row, origin), workflowRunId } },
              exportsLinks(params.id)
            ),
            { status: 202 }
          );
        }),
    },
  },
});
