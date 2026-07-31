import { getShotStalenessBatchFn, getShotStalenessFn } from '@/functions/shots';
import type { ArtifactStaleness } from '@/lib/shots/shot-staleness';
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

/**
 * Per-artifact staleness state — see `computeShotStaleness` for the state
 * semantics. `ArtifactStaleness` is imported rather than redeclared so the
 * client and server can't drift on the vocabulary. Only `'stale'` drives UI:
 * `'untracked'` (no hash on file) and `'unknown'` (the comparison failed)
 * both mean "no opinion to surface", so neither shows a regenerate prompt.
 */

/** The tracked artifacts, and the source of truth for `ShotStaleness`'s keys. */
const SHOT_ARTIFACTS = ['thumbnail', 'visualPrompt', 'motionPrompt'] as const;

export type ShotArtifact = (typeof SHOT_ARTIFACTS)[number];

export type ShotStaleness = Record<ShotArtifact, ArtifactStaleness>;

/** Which of the shot's artifacts are out of date, if any. */
const staleArtifacts = (staleness: ShotStaleness | undefined): ShotArtifact[] =>
  SHOT_ARTIFACTS.filter((artifact) => staleness?.[artifact] === 'stale');

/** Any artifact on the shot out of date? */
export const shotIsStale = (staleness: ShotStaleness | undefined): boolean =>
  staleArtifacts(staleness).length > 0;

/**
 * Invalidation target for anything that moves a shot's staleness (prompt
 * regen, image/video set, duration edit, script save). The per-shot,
 * scene-scoped and sequence-scoped entries all live under this prefix, so
 * invalidating the namespace keeps the shot indicators AND the scene/sequence
 * summaries / left-rail dots in step — a per-shot key invalidation would
 * leave the batched entries stale.
 */
export const shotStalenessNamespace = ['shot-staleness'] as const;

export const shotStalenessKey = (shotId: string | undefined) =>
  [...shotStalenessNamespace, shotId] as const;

/**
 * Batched keys live under the same `'shot-staleness'` namespace so the
 * existing namespace invalidations (script save, realtime events) refresh
 * them too. No collision with `shotStalenessKey`: shot ids are ULIDs, never
 * `'scene'`/`'sequence'`.
 */
const sceneShotStalenessKey = (sceneId: string | undefined) =>
  [...shotStalenessNamespace, 'scene', sceneId] as const;
const sequenceShotStalenessKey = (sequenceId: string) =>
  [...shotStalenessNamespace, 'sequence', sequenceId] as const;

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
 * Fetch the batch and prime the per-shot `shotStalenessKey` entries so
 * landing on a shot from the stale-shot navigation doesn't refire the
 * single-shot query.
 */
async function fetchAndPrimeBatch(
  queryClient: QueryClient,
  data: { sequenceId: string; sceneId?: string }
): Promise<Record<string, ShotStaleness>> {
  const byShot = await getShotStalenessBatchFn({ data });
  for (const [shotId, staleness] of Object.entries(byShot)) {
    queryClient.setQueryData<ShotStaleness>(
      shotStalenessKey(shotId),
      staleness
    );
  }
  return byShot;
}

/** Batched staleness for every shot in a scene (#1077), keyed by shot id. */
export function useSceneShotStaleness(args: {
  sequenceId: string;
  sceneId: string | undefined;
}) {
  const { sequenceId, sceneId } = args;
  const queryClient = useQueryClient();
  return useQuery<Record<string, ShotStaleness>>({
    queryKey: sceneShotStalenessKey(sceneId),
    queryFn: () => {
      if (!sceneId) throw new Error('sceneId required');
      return fetchAndPrimeBatch(queryClient, { sequenceId, sceneId });
    },
    enabled: !!sceneId,
    staleTime: 30_000,
  });
}

/**
 * Sequence-wide staleness (#1077), keyed by shot id. Gated by `enabled` —
 * it recomputes hashes for every shot in the sequence, so callers only turn
 * it on while the sequence-scope panel is actually showing.
 */
export function useSequenceShotStaleness(args: {
  sequenceId: string;
  enabled?: boolean;
}) {
  const { sequenceId, enabled = true } = args;
  const queryClient = useQueryClient();
  return useQuery<Record<string, ShotStaleness>>({
    queryKey: sequenceShotStalenessKey(sequenceId),
    queryFn: () => fetchAndPrimeBatch(queryClient, { sequenceId }),
    enabled: enabled && !!sequenceId,
    staleTime: 30_000,
  });
}
