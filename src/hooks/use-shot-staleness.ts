import { getSceneShotStalenessFn, getShotStalenessFn } from '@/functions/shots';
import { useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * Per-artifact staleness state.
 *   - `'stale'`     — stored input hash no longer matches a freshly-computed one.
 *   - `'fresh'`     — stored input hash matches; the artifact is up-to-date.
 *   - `'untracked'` — the artifact has no input hash on file (legacy data, or
 *                     never generated). The UI must not show a regenerate
 *                     prompt — we have no opinion to surface.
 */
type ArtifactStaleness = 'stale' | 'fresh' | 'untracked';

export type ShotStaleness = {
  thumbnail: ArtifactStaleness;
  visualPrompt: ArtifactStaleness;
  motionPrompt: ArtifactStaleness;
};

/**
 * Invalidation target for anything that moves a shot's staleness (prompt
 * regen, image/video set, duration edit, script save). Both the per-shot and
 * scene-scoped entries live under this prefix, so invalidating the namespace
 * keeps the shot indicators AND the scene summary / left-rail dots in step —
 * a per-shot key invalidation would leave the scene entry stale.
 */
export const shotStalenessNamespace = ['shot-staleness'] as const;

export const shotStalenessKey = (shotId: string | undefined) =>
  [...shotStalenessNamespace, shotId] as const;

/**
 * Scene-scoped key lives under the same `'shot-staleness'` namespace so the
 * existing namespace invalidations (script save, realtime events) refresh it
 * too. No collision with `shotStalenessKey`: shot ids are ULIDs, never
 * `'scene'`.
 */
const sceneShotStalenessKey = (sceneId: string | undefined) =>
  [...shotStalenessNamespace, 'scene', sceneId] as const;

/**
 * Shared query for shot staleness — consumers must use this hook rather
 * than an inline `useQuery` so cache invalidation hits one entry.
 */
export function useShotStaleness(args: {
  sequenceId: string;
  shotId: string | undefined;
}) {
  const { sequenceId, shotId } = args;
  return useQuery<ShotStaleness>({
    queryKey: shotStalenessKey(shotId),
    queryFn: () => {
      if (!shotId) throw new Error('shotId required');
      return getShotStalenessFn({ data: { sequenceId, shotId } });
    },
    enabled: !!shotId,
    staleTime: 30_000,
  });
}

/**
 * Batched staleness for every shot in a scene (#1077), keyed by shot id.
 * Primes the per-shot `shotStalenessKey` entries so landing on a shot from
 * the scene panel's stale-shot navigation doesn't refire the single-shot
 * query.
 */
export function useSceneShotStaleness(args: {
  sequenceId: string;
  sceneId: string | undefined;
}) {
  const { sequenceId, sceneId } = args;
  const queryClient = useQueryClient();
  return useQuery<Record<string, ShotStaleness>>({
    queryKey: sceneShotStalenessKey(sceneId),
    queryFn: async () => {
      if (!sceneId) throw new Error('sceneId required');
      const bySceneShot = await getSceneShotStalenessFn({
        data: { sequenceId, sceneId },
      });
      for (const [shotId, staleness] of Object.entries(bySceneShot)) {
        queryClient.setQueryData<ShotStaleness>(
          shotStalenessKey(shotId),
          staleness
        );
      }
      return bySceneShot;
    },
    enabled: !!sceneId,
    staleTime: 30_000,
  });
}
