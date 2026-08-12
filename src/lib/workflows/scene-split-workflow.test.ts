/**
 * Blast-radius test for the preview-image fan-out (#1149).
 *
 * `scene-split` fires one decorative preview image per shot (`skipStorage:
 * true`, nothing downstream reads the result). Before this fix a single one of
 * them throwing — a content-checker hit on ~15% of runs in the #1143 load test
 * — failed `scene-splitting-stream`, and with it `scene-split` →
 * `analyze-script` → the whole sequence, discarding every still that had
 * already rendered and been paid for.
 *
 * The contract asserted here: previews are attempted for every shot, a failing
 * one is swallowed, and the split still returns its scenes and shot mapping.
 */

import { describe, expect, test, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { SceneSplittingScene } from '@/lib/ai/streaming-scene-parser';
import type { SceneSplitWorkflowInput } from '@/lib/workflow/types';
import type { StyleConfig } from '@/lib/db/schema';

const triggerWorkflow =
  vi.fn<(path: string, body: unknown, options?: unknown) => Promise<string>>();
vi.doMock('@/lib/workflow/client', () => ({ triggerWorkflow }));

vi.doMock('@/lib/prompts', () => ({
  getChatPrompt: vi.fn(() =>
    Promise.resolve({ messages: [{ role: 'user', content: 'go' }] })
  ),
}));

const emit = vi.fn(() => Promise.resolve());
vi.doMock('@/lib/realtime', () => ({
  getGenerationChannel: vi.fn(() => ({ emit })),
}));

vi.doMock('@/lib/billing/workflow-deduction', () => ({
  deductWorkflowCredits: vi.fn(() => Promise.resolve()),
}));

// One chunk carrying the whole (already-validated) result; the parser mock
// below is what turns it into per-scene events.
vi.doMock('@/lib/ai/llm-client', () => ({
  PROMPT_REASONING: undefined,
  llmCostFromUsage: vi.fn(() => 0),
  callLLMStream: vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield {
        done: true,
        accumulated: '{}',
        parsed: PARSED_RESULT,
        usage: undefined,
      };
    },
  })),
}));

vi.doMock('@/lib/ai/streaming-scene-parser', async () => {
  const real = await vi.importActual('@/lib/ai/streaming-scene-parser');
  return {
    ...real,
    createStreamingSceneParser: () => ({
      feed: () =>
        SCENES.map((scene, index) => ({ type: 'scene', scene, index })),
    }),
  };
});

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const { SceneSplitWorkflow } = await import('./scene-split-workflow');

function makeScene(n: number): SceneSplittingScene {
  return {
    sceneId: `scene_${n}`,
    sceneNumber: n,
    originalScript: { extract: `Scene ${n} action`, dialogue: [] },
    metadata: {
      title: `Scene ${n}`,
      durationSeconds: 3,
      location: 'A room',
      timeOfDay: 'day',
      storyBeat: 'setup',
    },
    continuity: {
      characterTags: [],
      environmentTag: '',
      elementTags: null,
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
  };
}

const SCENES = [makeScene(1), makeScene(2), makeScene(3)];

const PARSED_RESULT = {
  scenes: SCENES,
  projectMetadata: { title: 'Test Film' },
  characterBible: [],
  locationBible: [],
  elementBible: [],
};

const STYLE_CONFIG: StyleConfig = {
  mood: 'tense',
  artStyle: 'photoreal',
  lighting: 'hard key',
  colorPalette: ['#101020'],
  cameraWork: 'handheld',
  referenceFilms: [],
  colorGrading: 'cool shadows',
};

const INPUT: SceneSplitWorkflowInput = {
  userId: 'u1',
  teamId: 't1',
  sequenceId: 'seq_1',
  script: 'INT. ROOM - DAY',
  modelId: 'anthropic/claude-sonnet-5',
  promptName: 'scene-splitting',
  styleConfig: STYLE_CONFIG,
  aspectRatio: '16:9',
  elements: [],
};

function makeScopedDb(): WorkflowScopedDb {
  let shotSeq = 0;
  const shot = () => {
    shotSeq++;
    return { id: `shot_${shotSeq}`, anchorFrameId: `frame_${shotSeq}` };
  };
  const scopedDb = {
    credentials: {
      resolveLlmKey: () =>
        Promise.resolve({ source: 'platform', via: 'env', key: 'k' }),
    },
    scenes: {
      upsert: (row: { orderIndex: number }) =>
        Promise.resolve({
          id: `dbscene_${row.orderIndex}`,
          orderIndex: row.orderIndex,
          createdAt: new Date(0),
        }),
      deleteFromOrderIndex: () => Promise.resolve(),
    },
    sceneScriptVersions: { seedSplitVersions: () => Promise.resolve() },
    shots: {
      upsert: () => Promise.resolve(shot()),
      // Reconcile re-derives the mapping; keep ids stable per scene index.
      bulkUpsert: (rows: Array<{ sceneId: string | null }>) =>
        Promise.resolve(
          rows.map((row, index) => ({
            id: `shot_r${index}`,
            anchorFrameId: `frame_r${index}`,
            sceneId: row.sceneId,
          }))
        ),
      update: () => Promise.resolve(true),
      delete: () => Promise.resolve(),
      deleteByScenesFromOrderIndex: () => Promise.resolve(),
    },
    sequences: {
      updateTitle: () => Promise.resolve(),
      updateWorkflow: () => Promise.resolve(),
    },
    sequenceElements: { updateFirstMention: () => Promise.resolve() },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the scoped-db surface runImpl touches
  return scopedDb as unknown as WorkflowScopedDb;
}

function makeEvent(): Readonly<WorkflowEvent<SceneSplitWorkflowInput>> {

  // The stub satisfies WorkflowEvent structurally, so no assertion is needed
  // — and asserting anyway now trips no-unnecessary-type-assertion.
  return {
    payload: INPUT,
    instanceId: 'split_run_A',
    timestamp: new Date(0),
  };
}

function makeStep(): WorkflowStep {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: runImpl only uses `do`
  return {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as WorkflowStep;
}

/**
 * Exposes the protected `runImpl` so the split runs without the base class's
 * scoped-db construction and failure handling. Named `split`, not `run` — the
 * base class already owns `run(event, step)`.
 */
class Probe extends SceneSplitWorkflow {
  split(
    event: Readonly<WorkflowEvent<SceneSplitWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly; runImpl never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal env stub; runImpl never reads bindings
  const env = {} as unknown as Ctor[1];
  return new Probe(ctx, env);
}

const previewCalls = () =>
  triggerWorkflow.mock.calls.filter((call) => call[0] === '/image');

describe('SceneSplitWorkflow preview fan-out', () => {
  test('triggers one preview per shot on the happy path', async () => {
    triggerWorkflow.mockReset();
    triggerWorkflow.mockResolvedValue('run_1');

    const result = await makeWorkflow().split(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(previewCalls()).toHaveLength(SCENES.length);
    expect(result.shotMapping).toHaveLength(SCENES.length);
  });

  // The #1149 failure exactly: one preview's ImageWorkflow instance is a
  // tombstone, so its trigger throws `instance.already_exists` forever.
  test('a failing preview does not fail the split', async () => {
    triggerWorkflow.mockReset();
    triggerWorkflow
      .mockResolvedValueOnce('run_1')
      .mockRejectedValueOnce(
        new Error('(instance.already_exists) Instance already exists')
      )
      .mockResolvedValue('run_3');

    const result = await makeWorkflow().split(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(result.title).toBe('Test Film');
    expect(result.shotMapping).toHaveLength(SCENES.length);
  });

  // A swallow that also stopped the fan-out would silently lose every later
  // preview — the remaining shots must still be attempted.
  test('a failing preview does not stop the ones after it', async () => {
    triggerWorkflow.mockReset();
    triggerWorkflow
      .mockRejectedValueOnce(new Error('content checker flagged this prompt'))
      .mockResolvedValue('run_ok');

    await makeWorkflow().split(makeEvent(), makeStep(), makeScopedDb());

    expect(previewCalls()).toHaveLength(SCENES.length);
  });

  test('every preview fails: the split still completes', async () => {
    triggerWorkflow.mockReset();
    triggerWorkflow.mockRejectedValue(new Error('preview generation failed'));

    const result = await makeWorkflow().split(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(result.scenes).toHaveLength(SCENES.length);
  });
});
