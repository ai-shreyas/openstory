import {
  recommendStylesForScriptFn,
  type StyleRecommendation,
} from '@/functions/ai';
import { getPublicStylesFn, getStyleFn, getStylesFn } from '@/functions/styles';
import { usePublicOrTeamQuery } from '@/hooks/use-public-or-team-query';
import { useSession } from '@/lib/auth/client';
import { simpleHash } from '@/lib/utils/hash';
import type { Style } from '@/types/database';
import { useQuery } from '@tanstack/react-query';

// Query keys
export const styleKeys = {
  all: ['styles'] as const,
  lists: () => [...styleKeys.all, 'list'] as const,
  list: (teamId?: string) => [...styleKeys.lists(), teamId] as const,
  public: () => [...styleKeys.lists(), 'public'] as const,
  details: () => [...styleKeys.all, 'detail'] as const,
  detail: (id: string) => [...styleKeys.details(), id] as const,
  // Recommendations are keyed by a hash of the (trimmed) script, so the same
  // script never re-spends an LLM call and enhancing — which changes the
  // script — naturally lands on a fresh key.
  recommend: (scriptHash: string, limit: number) =>
    [...styleKeys.all, 'recommend', scriptHash, limit] as const,
};

// Hook for listing styles.
// Anonymous (logged-out) visitors get the public style catalogue so they can
// compose a sequence before signing in; authenticated users get their team's
// styles plus public ones (see usePublicOrTeamQuery for the session rules).
export function useStyles(teamId?: string, enabled = true) {
  return usePublicOrTeamQuery<Style[]>({
    teamKey: styleKeys.list(teamId),
    publicKey: styleKeys.public(),
    teamFn: () => getStylesFn(),
    publicFn: () => getPublicStylesFn(),
    staleTime: 10 * 60 * 1000, // 10 minutes (styles change less frequently)
    enabled,
  });
}

// Hook for getting single style
export function useStyle(id: string) {
  return useQuery<Style>({
    queryKey: styleKeys.detail(id),
    queryFn: async () => {
      return getStyleFn({ data: { styleId: id } });
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!id,
  });
}

export type { StyleRecommendation };

const MIN_RECOMMEND_SCRIPT_LENGTH = 3;

/**
 * Rank the team's + public styles against the current script/one-liner.
 *
 * Auth-gated (the underlying server fn is billed, like Enhance) and
 * caller-gated via `enabled` so the LLM call is only spent on an explicit
 * trigger (the Recommend button or a completed enhance pre-warm). Repeats
 * are free: the cache key is the script hash and `staleTime: Infinity` means a
 * given script is only ranked once.
 */
export function useRecommendedStyles(
  script: string | null | undefined,
  options?: { enabled?: boolean; limit?: number }
) {
  const { data: session, isPending } = useSession();
  const isAuthenticated = !!session;

  const trimmed = (script ?? '').trim();
  const limit = options?.limit ?? 5;
  const scriptHash = simpleHash(trimmed);

  return useQuery({
    queryKey: styleKeys.recommend(scriptHash, limit),
    queryFn: () =>
      recommendStylesForScriptFn({ data: { script: trimmed, limit } }),
    enabled:
      (options?.enabled ?? true) &&
      isAuthenticated &&
      !isPending &&
      trimmed.length >= MIN_RECOMMEND_SCRIPT_LENGTH,
    staleTime: Infinity,
  });
}
