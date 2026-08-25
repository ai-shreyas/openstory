/**
 * Silent retry of a lone failed primary image (#1286).
 *
 * A single content-flag / timeout of seven shouldn't open the scenes page on
 * "Generation partially failed. 1 image failed". Retry that one child once
 * before returning; leave real multi-miss batches alone.
 */

import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { ShotImagesWorkflowInput } from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';

const spawnAndAwaitChild = vi.fn();
vi.doMock('@/lib/workflow/await-child', () => ({ spawnAndAwaitChild }));
vi.doMock('@/lib/workflow/client', () => ({
  triggerWorkflow: vi.fn(async () => 'variant-run'),
}));
vi.doMock('@/lib/workflows/sheet-snapshots', () => ({
  computeShotImagesHashFromDto: vi.fn(async () => 'hash'),
  computeShotImageSceneHash: vi.fn(async () => 'scene-hash'),
}));

const { ShotImagesWorkflow } = await import('./shot-images-workflow');

const SCENE_IDS = ['scene_1', 'scene_2', 'scene_3'];
const MODEL = 'gpt_image_2' as const;

function makeInput(): ShotImagesWorkflowInput {
  return {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 'seq_1',
    aspectRatio: '16:9',
    imageModel: MODEL,
    imageModels: [MODEL],
    snapshotInputHash: 'hash',
    charactersWithSheets: [],
    locationsWithSheets: [],
    elements: [],
    shotMapping: SCENE_IDS.map((sceneId, i) => ({
      analysisSceneId: sceneId,
      shotId: `shot_${i + 1}`,
      frameId: `frame_${i + 1}`,
    })),
    sceneSnapshots: SCENE_IDS.map((sceneId) => ({
      sceneId,
      visualPrompt: `still of ${sceneId}`,
      characterSheetHashes: [],
      locationSheetHashes: [],
      elementReferenceHashes: [],
    })),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal Scene stubs: the batch only reads sceneId / continuity
    scenesWithVisualPrompts: SCENE_IDS.map((sceneId, i) => ({
      sceneId,
      sceneNumber: i + 1,
      originalScript: { extract: 'a beat', lineNumber: i + 1 },
      metadata: { title: sceneId, durationSeconds: 5 },
      continuity: {},
    })) as unknown as ShotImagesWorkflowInput['scenesWithVisualPrompts'],
  };
}

function makeEvent(): Readonly<WorkflowEvent<ShotImagesWorkflowInput>> {
  return {
    payload: makeInput(),
    instanceId: 'shot_images_run_A',
    workflowName: 'shot-images',
    timestamp: new Date(0),
  };
}

function makeStep(): WorkflowStep {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl only uses `do`
  return {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as WorkflowStep;
}

class Probe extends ShotImagesWorkflow {
  batch(
    event: Readonly<WorkflowEvent<ShotImagesWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only IMAGE_WORKFLOW is read, and the spawn is mocked
  const env = { IMAGE_WORKFLOW: {} } as unknown as Ctor[1];
  return new Probe(ctx, env);
}

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl only reads liveRead.compliance.listEnforcementFor
const SCOPED_DB = {
  liveRead: {
    compliance: {
      listEnforcementFor: vi.fn(async () => ({})),
    },
  },
} as unknown as WorkflowScopedDb;

function sceneIdFromChildId(childId: string): string {
  // image:seq_1:shot_2:gpt_image_2 or image:seq_1:shot_2:gpt_image_2:retry
  const shot = childId.split(':')[2] ?? '';
  const n = shot.replace('shot_', '');
  return `scene_${n}`;
}

describe('ShotImagesWorkflow silent single-image retry', () => {
  test('retries a lone failed primary once and returns the recovered URL', async () => {
    spawnAndAwaitChild.mockReset();
    spawnAndAwaitChild.mockImplementation(
      (_step: unknown, args: { childId: string }) => {
        const sceneId = sceneIdFromChildId(args.childId);
        if (sceneId === 'scene_2' && !args.childId.endsWith(':retry')) {
          return Promise.reject(new Error('content flag'));
        }
        return Promise.resolve({
          imageUrl: `https://cdn.example/${sceneId}.png`,
        });
      }
    );

    const result = await makeWorkflow().batch(
      makeEvent(),
      makeStep(),
      SCOPED_DB
    );

    expect(result.imageUrls).toEqual([
      'https://cdn.example/scene_1.png',
      'https://cdn.example/scene_2.png',
      'https://cdn.example/scene_3.png',
    ]);
    // 3 first-pass children + 1 silent retry of the lone miss.
    expect(spawnAndAwaitChild).toHaveBeenCalledTimes(4);
  });

  test('does not retry when two primaries failed', async () => {
    spawnAndAwaitChild.mockReset();
    spawnAndAwaitChild.mockImplementation(
      (_step: unknown, args: { childId: string }) => {
        const sceneId = sceneIdFromChildId(args.childId);
        if (sceneId === 'scene_1' || sceneId === 'scene_3') {
          return Promise.reject(new Error('content flag'));
        }
        return Promise.resolve({
          imageUrl: `https://cdn.example/${sceneId}.png`,
        });
      }
    );

    const result = await makeWorkflow().batch(
      makeEvent(),
      makeStep(),
      SCOPED_DB
    );

    expect(result.imageUrls).toEqual([
      null,
      'https://cdn.example/scene_2.png',
      null,
    ]);
    expect(spawnAndAwaitChild).toHaveBeenCalledTimes(3);
  });
});
