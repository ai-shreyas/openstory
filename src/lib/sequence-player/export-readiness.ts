/**
 * Whether the theatre export actions can run: every shot must have a clip.
 * First-run users were hitting Export while scenes were still generating and
 * getting a thrown "N of M scenes are still generating" (#1286).
 */

export type ExportClipProgress = {
  clipsReady: number;
  clipsTotal: number;
  canExport: boolean;
};

export function exportClipProgress(
  shots: ReadonlyArray<{ video?: { url?: string | null } | null }>
): ExportClipProgress {
  const clipsTotal = shots.length;
  const clipsReady = shots.filter((s) => Boolean(s.video?.url)).length;
  return {
    clipsReady,
    clipsTotal,
    canExport: clipsTotal > 0 && clipsReady === clipsTotal,
  };
}

export function exportPendingLabel(
  clipsReady: number,
  clipsTotal: number
): string {
  return `Export · ${clipsReady} of ${clipsTotal} clips ready`;
}
