/**
 * Server-side sequence export (#968) — the API counterpart of the browser
 * export in `src/lib/sequence-player/export.ts`.
 *
 * Flow:
 *   1. `gather-export-inputs` — load the reserved export row + sequence +
 *      frames via `scopedDb`, absolutize each scene/music URL, build the
 *      container job. ALL database access lives here, in the Worker — the
 *      container is a stateless renderer and never touches D1.
 *   2. `render-and-upload` — POST the job to the `VideoExportContainer` (Node +
 *      @mediabunny/server), stream the returned MP4 straight into R2.
 *   3. `mark-export-ready` — flip the `sequence_exports` row to `ready`.
 *
 * The container binding is production-only (see wrangler.jsonc); outside prod
 * the render step throws and the row is marked `failed` via `onFailure`.
 */

import { uploadFile } from '#storage';
import type { ScopedDb } from '@/lib/db/scoped';
import { STORAGE_BUCKETS, toShareableUrl } from '@/lib/storage/buckets';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { CloudflareEnv, UserWorkflowContext } from '@/lib/workflow/types';
import type { VideoExportContainer } from '@/lib/containers/video-export-container';
import { getContainer } from '@cloudflare/containers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

type SequenceExportWorkflowInput = UserWorkflowContext & {
  sequenceId: string;
  /** Pre-reserved `sequence_exports` row (status `processing`) to fill in. */
  exportId: string;
};

/** Wire contract — keep in sync with `containers/video-export/src/types.ts`. */
type ContainerExportJob = {
  scenes: { orderIndex: number; videoUrl: string }[];
  musicUrl: string | null;
  musicLoudnessGainDb: number | null;
};

// The container binding only exists in [env.production]; CloudflareEnv (typed
// from the default block) doesn't include it, so we narrow at the call site.
// `VIDEO_EXPORT_DEV_URL` is a local-dev-only escape hatch (injected by
// `bun dev:all`, or set in .env.local for a two-terminal setup; never in
// prod): when present, the workflow POSTs to the host `bun dev:bunny` service
// instead of the container binding.
type ContainerEnv = {
  VIDEO_EXPORT_CONTAINER?: DurableObjectNamespace<VideoExportContainer>;
  VIDEO_EXPORT_DEV_URL?: string;
};

export class SequenceExportWorkflow extends OpenStoryWorkflowEntrypoint<SequenceExportWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<SequenceExportWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<{ exportId: string; durationSeconds: number }> {
    const { sequenceId, exportId } = event.payload;
    const env = this.env as CloudflareEnv & ContainerEnv;

    const { job, storagePath } = await step.do(
      'gather-export-inputs',
      async () => {
        const exportRow = await scopedDb.sequenceExports.getById(exportId);
        if (!exportRow) throw new Error(`Export ${exportId} not found`);

        const sequence = await scopedDb.sequences.getById(sequenceId);
        if (!sequence) throw new Error(`Sequence ${sequenceId} not found`);

        const shots = await scopedDb.shots.listBySequence(sequenceId, {
          orderBy: 'orderIndex',
          ascending: true,
        });
        if (shots.length === 0) throw new Error('Sequence has no shots yet');

        // Absolutize stored `/r2/...` URLs so the off-platform container can
        // fetch them (CDN domain in prod, else the worker origin).
        const origin = env.VITE_APP_URL;
        const scenes = shots
          .filter((s): s is typeof s & { videoUrl: string } =>
            Boolean(s.videoUrl)
          )
          .map((s) => ({
            orderIndex: s.orderIndex,
            videoUrl: toShareableUrl(s.videoUrl, origin),
          }));
        if (scenes.length === 0) {
          throw new Error('No scene videos are ready yet');
        }
        if (scenes.length !== shots.length) {
          throw new Error(
            `${shots.length - scenes.length} of ${shots.length} scenes are still generating`
          );
        }

        const musicUrl =
          sequence.includeMusic && sequence.musicUrl
            ? toShareableUrl(sequence.musicUrl, origin)
            : null;

        const job: ContainerExportJob = {
          scenes,
          musicUrl,
          musicLoudnessGainDb: null,
        };
        return { job, storagePath: exportRow.storagePath };
      }
    );

    const { durationSeconds } = await step.do(
      'render-and-upload',
      {
        retries: { limit: 1, delay: '10 seconds', backoff: 'constant' },
        timeout: '15 minutes',
      },
      async () => {
        const requestInit = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(job),
        };
        // Local dev (VIDEO_EXPORT_DEV_URL set via `bun dev:all` or .env.local):
        // hit the host `bun dev:bunny` service directly. Prod has no such var →
        // use the container binding.
        let response: Response;
        const devUrl = env.VIDEO_EXPORT_DEV_URL;
        if (devUrl) {
          response = await fetch(
            `${devUrl.replace(/\/$/, '')}/export`,
            requestInit
          );
        } else {
          const ns = env.VIDEO_EXPORT_CONTAINER;
          if (!ns) {
            throw new Error(
              'VIDEO_EXPORT_CONTAINER binding unavailable — server-side export runs in production only (use `bun dev:all`, or set VIDEO_EXPORT_DEV_URL in .env.local, to route to the local `bun dev:bunny` service)'
            );
          }
          response = await getContainer(ns, exportId).fetch(
            new Request('http://video-export/export', requestInit)
          );
        }
        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => '');
          throw new Error(
            `Container export failed (${response.status}): ${detail.slice(0, 500)}`
          );
        }

        // The container ALWAYS sets x-export-meta (see container server.ts) with
        // a real durationSeconds. A missing/garbled header means the
        // container↔worker contract broke — fail loudly rather than storing a
        // `ready` export with a silently-wrong duration of 0.
        const metaHeader = response.headers.get('x-export-meta');
        if (!metaHeader) {
          throw new Error('Container response missing x-export-meta header');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(decodeURIComponent(metaHeader));
        } catch {
          throw new Error(
            `Container x-export-meta is not valid JSON: ${metaHeader.slice(0, 200)}`
          );
        }
        // Narrow from `unknown` rather than asserting JSON.parse's `any`.
        const durationSecondsFromMeta =
          typeof parsed === 'object' &&
          parsed !== null &&
          'durationSeconds' in parsed &&
          typeof parsed.durationSeconds === 'number' &&
          Number.isFinite(parsed.durationSeconds)
            ? parsed.durationSeconds
            : null;
        if (durationSecondsFromMeta === null) {
          throw new Error(
            `Container x-export-meta lacks a finite durationSeconds: ${metaHeader.slice(0, 200)}`
          );
        }

        // Stream the container's MP4 into R2 via the binding — no presigned
        // URL, no full-buffer in the isolate. R2.put needs a *known length*
        // for a stream: the container sends the MP4 with a content-length (it
        // renders the whole file before responding), but a bare `response.body`
        // doesn't carry that length to R2 ("readable stream must have a known
        // length"). Rewrap it through a FixedLengthStream of the declared size
        // so R2 accepts the stream.
        const contentLength = Number(response.headers.get('content-length'));
        if (!Number.isInteger(contentLength) || contentLength <= 0) {
          throw new Error(
            `Container response has no usable content-length (got ${response.headers.get('content-length')}) — cannot stream the MP4 to R2`
          );
        }
        const sized = new FixedLengthStream(contentLength);
        // Pump and upload concurrently: R2 drains `sized.readable` while the
        // container body fills `sized.writable`. Promise.all surfaces a pump
        // failure (e.g. a short/aborted body) rather than leaving it unhandled.
        await Promise.all([
          response.body.pipeTo(sized.writable),
          uploadFile(STORAGE_BUCKETS.VIDEOS, storagePath, sized.readable, {
            contentType: 'video/mp4',
            upsert: true,
          }),
        ]);

        return { durationSeconds: durationSecondsFromMeta };
      }
    );

    await step.do('mark-export-ready', async () => {
      await scopedDb.sequenceExports.markReady(exportId, { durationSeconds });
    });

    return { exportId, durationSeconds };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<SequenceExportWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    await scopedDb.sequenceExports.markFailed(event.payload.exportId, error);
  }
}
