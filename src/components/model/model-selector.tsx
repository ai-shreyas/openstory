import { BaseModelSelector } from './base-model-selector';
import {
  isSelectableAnalysisModelId,
  isValidAnalysisModelId,
  SCRIPT_ANALYSIS_MODELS,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import { useMemo } from 'react';

const GROUP_ORDER = ['all'] as const;

type ModelSelectorProps = {
  selectedModels: AnalysisModelId[];
  onModelsChange: (models: AnalysisModelId[]) => void;
  disabled?: boolean;
  singleSelect?: boolean;
};

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  selectedModels,
  onModelsChange,
  disabled = false,
  singleSelect = false,
}) => {
  const models = useMemo(
    () =>
      [...SCRIPT_ANALYSIS_MODELS]
        .filter((m) => isSelectableAnalysisModelId(m.id))
        .sort((a, b) => a.qualityRank - b.qualityRank)
        .map((m) => ({
          id: m.id,
          name: m.name,
          group: 'all',
          badge: m.license,
        })),
    []
  );

  return (
    <BaseModelSelector
      label="Analysis Model"
      models={models}
      groupOrder={GROUP_ORDER}
      selectedIds={selectedModels}
      onSelectionChange={(ids) => {
        const validIds = ids.filter((id): id is AnalysisModelId =>
          isValidAnalysisModelId(id)
        );
        if (validIds.length > 0) {
          onModelsChange(validIds);
        }
      }}
      disabled={disabled}
      multiSelect={!singleSelect}
    />
  );
};
