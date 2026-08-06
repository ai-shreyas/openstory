/**
 * Hook that drives the on-demand browser-side export pipeline:
 *   1. Reserve an upload URL via `requestSequenceExportUploadUrlFn`.
 *   2. Run the Mediabunny pipeline (`exportSequence`) — shares the
 *      `ConcatenatedVideoSource` primitive with the live `<SequencePlayer>`.
 *   3. PUT the resulting Blob to the reserved URL.
 *   4. Commit via `commitSequenceExportFn` (writes a new `sequence_exports` row).
 *
 * Returns a `latestExport` URL so the consumer can immediately offer the
 * fresh download once it commits — no full re-fetch round-trip.
 */

import {
  commitSequenceExportFn,
  listSequenceExportsFn,
  requestSequenceExportUploadUrlFn,
} from '@/functions/sequence-exports';
import { useShotsBySequence } from '@/hooks/use-shots';
import { putToR2 } from '@/lib/utils/upload';
import {
  exportSequence,
  type ExportProgress,
} from '@/lib/sequence-player/export';
import type { Sequence } from '@/types/database';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePostHog } from '@posthog/react';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

const sequenceExportKeys = {
  list: (sequenceId: string) => ['sequence-exports', sequenceId] as const,
};

// Cap the upload PUT so a stalled R2 proxy surfaces an error toast instead of
// spinning forever. Generous enough for a 5-min export on a slow connection.
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export type SequenceExportState = {
  isRunning: boolean;
  progress: ExportProgress | null;
  latestExportUrl: string | null;
  start: () => void;
  abort: () => void;
};

export function useSequenceExport(sequence: Sequence): SequenceExportState {
  const posthog = usePostHog();
  const queryClient = useQueryClient();
  const { data: shots } = useShotsBySequence(sequence.id);

  const { data: exports } = useQuery({
    queryKey: sequenceExportKeys.list(sequence.id),
    queryFn: () => listSequenceExportsFn({ data: { sequenceId: sequence.id } }),
    staleTime: 5_000,
  });

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const exportMutation = useMutation({
    mutationFn: async (signal: AbortSignal) => {
      if (!shots || shots.length === 0) {
        throw new Error('This sequence has no shots yet.');
      }
      const scenes = shots
        .filter((f): f is typeof f & { videoUrl: string } =>
          Boolean(f.videoUrl)
        )
        .map((f, i) => ({ orderIndex: i, videoUrl: f.videoUrl }));
      if (scenes.length === 0) {
        throw new Error('No scene videos are ready yet.');
      }
      if (scenes.length !== shots.length) {
        throw new Error(
          `${shots.length - scenes.length} of ${shots.length} scenes are still generating.`
        );
      }

      const reservation = await requestSequenceExportUploadUrlFn({
        data: { sequenceId: sequence.id },
      });

      const { blob, durationSeconds, reEncoded, resolutionsLabel } =
        await exportSequence({
          scenes,
          // Omit the music track entirely when the sequence's music toggle is
          // off — the exported MP4 then carries only scene/dialogue audio (#834).
          musicUrl: sequence.includeMusic ? (sequence.musicUrl ?? null) : null,
          musicLoudnessGainDb: null,
          onProgress: setProgress,
          signal,
        });

      // Tell the user from the export's OWN probe — the player's warning is a
      // separate, possibly-unfired prepare(), so it can't be relied on (#791).
      if (reEncoded) {
        toast.info(
          resolutionsLabel
            ? `Scenes have mixed resolutions (${resolutionsLabel}); the export was normalized by re-encoding.`
            : 'Scene video encodings differ; the export was re-encoded.'
        );
      }

      // `upload` and `commit` run here, after the Mediabunny pipeline. Report
      // them through the same progress channel so a stalled upload/commit
      // doesn't masquerade as a stuck "Finalizing…" (finalize is the last
      // phase exportSequence emits). putToR2 streams via XHR and, for exports
      // over Cloudflare's ~100MB single-body limit, transparently switches to a
      // chunked R2 multipart upload.
      setProgress({ phase: 'upload', completed: 0, total: 100 });
      await putToR2(
        reservation.uploadUrl,
        blob,
        reservation.contentType,
        (percent) =>
          setProgress({ phase: 'upload', completed: percent, total: 100 }),
        { signal, timeoutMs: UPLOAD_TIMEOUT_MS }
      );

      setProgress({ phase: 'commit', completed: 0, total: 0 });
      await commitSequenceExportFn({
        data: {
          sequenceId: sequence.id,
          path: reservation.path,
          durationSeconds,
        },
      });
      return { reEncoded };
    },
    onSuccess: ({ reEncoded }) => {
      toast.success('MP4 ready to download.');
      posthog.capture('sequence_export_completed', {
        sequence_id: sequence.id,
        re_encoded: reEncoded,
      });
      void queryClient.invalidateQueries({
        queryKey: sequenceExportKeys.list(sequence.id),
      });
    },
    onError: (error) => {
      if (abortRef.current?.signal.aborted) return;
      toast.error(toExportErrorMessage(error));
      posthog.captureException(error, { sequence_id: sequence.id });
    },
    onSettled: () => {
      setIsRunning(false);
      setProgress(null);
      abortRef.current = null;
    },
  });

  const start = useCallback(() => {
    if (isRunning) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setProgress(null);
    exportMutation.mutate(controller.signal);
  }, [exportMutation, isRunning]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    isRunning,
    progress,
    latestExportUrl: exports?.[0]?.url ?? null,
    start,
    abort,
  };
}

const MAX_EXPORT_ERROR_LENGTH = 500;
function toExportErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Browser export failed';
  return raw.length <= MAX_EXPORT_ERROR_LENGTH
    ? raw
    : `${raw.slice(0, MAX_EXPORT_ERROR_LENGTH - 1)}…`;
}
