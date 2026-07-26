import {
  ascendSelection,
  clearSelection,
  parseSelectionFromSearch,
  selectShot,
  type SceneFacet,
  type SceneSelection,
  type ScenesSearch,
  selectionToSearchParams,
  toggleSceneInSelection,
} from '@/lib/scenes/scene-selection';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

type UseSceneSelectionOptions = {
  search: ScenesSearch;
  sequenceId: string;
};

export function useSceneSelection({
  search,
  sequenceId,
}: UseSceneSelectionOptions) {
  const navigate = useNavigate();

  const { scenes, shot } = search;
  const selection = useMemo(
    () => parseSelectionFromSearch({ scenes, shot }),
    [scenes, shot]
  );

  const setSelection = useCallback(
    (next: SceneSelection, facet?: SceneFacet) => {
      void navigate({
        to: '/sequences/$id/scenes',
        params: { id: sequenceId },
        search: selectionToSearchParams(next, facet ?? search.facet) as Record<
          string,
          string | undefined
        >,
        replace: false,
      });
    },
    [navigate, sequenceId, search.facet]
  );

  const handleSelectScene = useCallback(
    (sceneId: string, additive: boolean) => {
      setSelection(toggleSceneInSelection(selection, sceneId, additive));
    },
    [selection, setSelection]
  );

  const handleSelectShot = useCallback(
    (shotId: string) => {
      setSelection(selectShot(shotId));
    },
    [setSelection]
  );

  const handleClearSelection = useCallback(() => {
    setSelection(clearSelection());
  }, [setSelection]);

  const handleAscendSelection = useCallback(
    (shots: ReadonlyArray<{ id: string; sceneId: string | null }>) => {
      const next = ascendSelection(selection, shots);
      if (next) setSelection(next);
      return next !== null;
    },
    [selection, setSelection]
  );

  const setFacet = useCallback(
    (facet: SceneFacet) => {
      void navigate({
        to: '/sequences/$id/scenes',
        params: { id: sequenceId },
        search: selectionToSearchParams(selection, facet),
        replace: true,
      });
    },
    [navigate, sequenceId, selection]
  );

  return {
    selection,
    setSelection,
    handleSelectScene,
    handleSelectShot,
    handleClearSelection,
    handleAscendSelection,
    facet: search.facet,
    setFacet,
  };
}
