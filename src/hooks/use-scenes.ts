import { getComposedScriptFn, getScenesFn } from '@/functions/scenes';
import type { SceneRow } from '@/lib/db/schema';
import { useQuery } from '@tanstack/react-query';

export const sceneKeys = {
  all: ['scenes'] as const,
  list: (sequenceId: string) => [...sceneKeys.all, 'list', sequenceId] as const,
  composedScript: (sequenceId: string) =>
    [...sceneKeys.all, 'composed-script', sequenceId] as const,
};

/** Composed sequence script from selected scene versions (#1030). */
export function useComposedScript(sequenceId?: string) {
  return useQuery({
    queryKey: sceneKeys.composedScript(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getComposedScriptFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

/** Ordered scenes for a sequence — the editor groups shots under these (#909). */
export function useScenesBySequence(sequenceId?: string) {
  return useQuery<SceneRow[]>({
    queryKey: sceneKeys.list(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getScenesFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

// NOTE: no `useUpdateSceneModel` (#1066) — a scene has no model to write. The
// editor's model pick is a per-request choice passed to the generate call; it
// becomes durable when the version it produces is selected, and
// `useSequenceSelectedModels` reads it back.
