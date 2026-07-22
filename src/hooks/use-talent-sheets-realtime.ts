import { getChannelHistoryFn } from '@/functions/realtime-history';
import { useUser } from '@/hooks/use-user';
import { useRealtime } from '@/lib/realtime/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { talentKeys } from './use-talent';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-talent-sheets-realtime']);

type SheetProgressEvent = {
  event: string;
  data: {
    talentId: string;
    status: 'generating' | 'sheet_ready' | 'completed' | 'failed';
    sheetId?: string;
    sheetImageUrl?: string;
    headshotImageUrl?: string;
    error?: string;
  };
};

/**
 * Hook for subscribing to real-time talent sheet generation events for multiple talent.
 * Tracks generating status for all provided talent IDs.
 * Replays channel history on mount for each talent to catch in-flight generations.
 *
 * @param talentIds - Array of talent IDs to subscribe to
 * @returns Map of talentId -> generating status
 */
export function useTalentSheetsRealtime(talentIds: string[] = []) {
  const queryClient = useQueryClient();
  const { data: user } = useUser();
  const [generatingStatus, setGeneratingStatus] = useState<
    Map<string, boolean>
  >(new Map());

  // Track which talent IDs we've already fetched history for
  const checkedIds = useRef(new Set<string>());

  // Build channels array: ['talent:id1', 'talent:id2', ...]
  const channels = useMemo(
    () => talentIds.map((id) => `talent:${id}`),
    [talentIds]
  );

  // Replay channel history for newly added talent IDs
  useEffect(() => {
    if (!user) return;

    const newIds = talentIds.filter((id) => !checkedIds.current.has(id));
    if (newIds.length === 0) return;

    for (const id of newIds) {
      checkedIds.current.add(id);

      getChannelHistoryFn({ data: { channel: `talent:${id}` } })
        .then((events) => {
          // Find the last status for this talent
          let lastStatus: string | null = null;
          for (const evt of events) {
            if (evt.event !== 'talent.sheet:progress') continue;
            try {
              const parsed = JSON.parse(evt.data);
              if (parsed.talentId !== id) continue;
              lastStatus = parsed.status;
            } catch {
              // skip
            }
          }

          if (lastStatus === 'generating') {
            setGeneratingStatus((prev) => {
              const next = new Map(prev);
              next.set(id, true);
              return next;
            });
          }
        })
        .catch((err: Error) => {
          logger.error(`Failed to fetch history for talent:${id}:`, { err });
        });
    }
  }, [talentIds, user]);

  const handleEvent = useCallback(
    (event: SheetProgressEvent) => {
      const { event: eventName, data } = event;

      if (eventName !== 'talent.sheet:progress') return;
      if (!talentIds.includes(data.talentId)) return;

      switch (data.status) {
        case 'generating':
          setGeneratingStatus((prev) => {
            const next = new Map(prev);
            next.set(data.talentId, true);
            return next;
          });
          break;

        case 'sheet_ready':
          // Sheet image is ready but headshot still generating - refresh list to show sheet
          void queryClient.invalidateQueries({
            queryKey: talentKeys.lists(),
          });
          break;

        case 'completed':
          setGeneratingStatus((prev) => {
            const next = new Map(prev);
            next.delete(data.talentId);
            return next;
          });
          // Invalidate queries to refresh sheets and headshot
          void queryClient.invalidateQueries({
            queryKey: talentKeys.detail(data.talentId),
          });
          // Also invalidate list to show new headshot in talent grid
          void queryClient.invalidateQueries({
            queryKey: talentKeys.lists(),
          });
          break;

        case 'failed':
          setGeneratingStatus((prev) => {
            const next = new Map(prev);
            next.delete(data.talentId);
            return next;
          });
          break;
      }
    },
    [talentIds, queryClient]
  );

  const { status } = useRealtime({
    channels,
    events: ['talent.sheet:progress'] as const,
    onData: handleEvent,
    enabled: talentIds.length > 0,
  });

  // Helper to check if a specific talent is generating
  const isGenerating = useCallback(
    (talentId: string) => generatingStatus.get(talentId) ?? false,
    [generatingStatus]
  );

  return {
    isGenerating,
    connectionStatus: status,
  };
}
