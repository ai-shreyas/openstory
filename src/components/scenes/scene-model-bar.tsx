import { type ModelGenerationStatus } from '@/components/model/base-model-selector';
import { ImageModelSelector } from '@/components/model/image-model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { Kbd } from '@/components/ui/kbd';
import type { ImageToVideoModel, TextToImageModel } from '@/lib/ai/models';
import type { SelectionScope } from '@/lib/scenes/scene-selection';

/**
 * Scope header for the inspector, plus the sequence's default models.
 *
 * Model selectors appear at SEQUENCE scope only. A sequence default is the one
 * persisted model setting left (`sequences.imageModel` / `videoModel`) — it
 * seeds the first generation when nothing has been rendered yet.
 *
 * Scene scope deliberately shows no model UI: a scene has no model identity
 * (#1066 moved it onto `frame_variants` / `video_variants`), so a selector here
 * would re-create the scene-level setting the schema just dropped.
 *
 * Shot scope shows none either — the Image and Video tabs own their own model
 * picker, next to the prompt and preview it affects.
 */
type SceneModelBarProps = {
  scope: SelectionScope;
  resolvedSequenceImageModel: TextToImageModel;
  resolvedSequenceVideoModel: ImageToVideoModel;
  imageModelStatuses?: Map<string, ModelGenerationStatus>;
  videoModelStatuses?: Map<string, ModelGenerationStatus>;
  onSequenceImageModelChange?: (model: TextToImageModel) => void;
  onSequenceVideoModelChange?: (model: ImageToVideoModel) => void;
  styleName?: string;
  recommendedImageModel?: string | null;
  recommendedVideoModel?: string | null;
  isUpdating?: boolean;
};

const scopeLabel: Record<SelectionScope, string> = {
  sequence: 'Sequence default',
  scenes: 'Scene assets',
  shot: 'Shot assets',
};

export const SceneModelBar: React.FC<SceneModelBarProps> = ({
  scope,
  resolvedSequenceImageModel,
  resolvedSequenceVideoModel,
  imageModelStatuses,
  videoModelStatuses,
  onSequenceImageModelChange,
  onSequenceVideoModelChange,
  styleName,
  recommendedImageModel,
  recommendedVideoModel,
  isUpdating = false,
}) => {
  const showSequenceModels = scope === 'sequence';

  return (
    <div className="space-y-3 border-b px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {scopeLabel[scope]}
        </span>
        {/* Scope zoom-out affordance — Esc walks shot → scene → sequence. */}
        {scope !== 'sequence' && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <Kbd>esc</Kbd> up
          </span>
        )}
      </div>
      {showSequenceModels && (
        <>
          <div className="space-y-2">
            <span className="text-sm font-medium">Image</span>
            <ImageModelSelector
              selectedModel={resolvedSequenceImageModel}
              onModelChange={(model) => onSequenceImageModelChange?.(model)}
              disabled={isUpdating}
              recommendedImageModel={recommendedImageModel}
              styleName={styleName}
              generatedStatuses={imageModelStatuses}
            />
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">Video</span>
            <MotionModelSelector
              selectedModel={resolvedSequenceVideoModel}
              onModelChange={(model) => onSequenceVideoModelChange?.(model)}
              disabled={isUpdating}
              recommendedVideoModel={recommendedVideoModel}
              styleName={styleName}
              generatedStatuses={videoModelStatuses}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Seeds the first generation. Per-shot models are set on the Image and
            Video tabs.
          </p>
        </>
      )}
    </div>
  );
};
