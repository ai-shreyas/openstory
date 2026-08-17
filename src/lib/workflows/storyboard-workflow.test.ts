/**
 * Tests for `StoryboardWorkflow.onFailure` (#839).
 *
 * The June 6 incident: the QStash-era log-only onFailure left ~20 sequences
 * stranded in 'processing' when await-analyze-script timed out. These tests
 * pin the rewritten hook's three branches:
 *
 *   1. Normal failure → sequence marked 'failed' with the error message and
 *      'generation.failed' emitted (failure summary + retry UI, not an
 *      eternal spinner).
 *   2. The analyze-script child already marked the sequence failed → no
 *      write, no emit — the child's specific message ("Your OpenRouter API
 *      key is invalid…") must not be clobbered by the parent's generic
 *      wrapper ("Child workflow analyze-script… failed").
 *   3. Payload without a sequenceId → no DB access at all.
 */

import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import { DEFAULT_ANALYSIS_MODEL } from '@/lib/ai/models.config';
import type { WorkflowEvent } from 'cloudflare:workers';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { StoryboardWorkflowInput } from '@/lib/workflow/types';

vi.doMock('@/lib/db/scoped', () => ({
  createScopedDb: vi.fn(),
}));
vi.doMock('@/lib/ai/fal-config', () => ({
  configureFalProxyFromEnv: vi.fn(),
}));
vi.doMock('@/lib/image/image-generation', () => ({
  generateImageWithProvider: vi.fn(),
}));

const emit = vi.fn();
const getGenerationChannel = vi.fn(() => ({ emit }));
vi.doMock('@/lib/realtime', () => ({ getGenerationChannel }));

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const { StoryboardWorkflow } = await import('./storyboard-workflow');

/** Widens the protected hook so tests can invoke it directly. */
class TestableStoryboardWorkflow extends StoryboardWorkflow {
  invokeOnFailure(failure: {
    event: Readonly<WorkflowEvent<StoryboardWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    return this.onFailure(failure);
  }
}

function makeWorkflow(): TestableStoryboardWorkflow {
  type Ctor = ConstructorParameters<typeof TestableStoryboardWorkflow>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly; onFailure never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal env stub; onFailure never reads bindings
  const env = {} as unknown as Ctor[1];
  return new TestableStoryboardWorkflow(ctx, env);
}

function makeEvent(
  sequenceId: string | undefined
): Readonly<WorkflowEvent<StoryboardWorkflowInput>> {
  const payload: StoryboardWorkflowInput = {
    userId: 'u1',
    teamId: 't1',
    sequenceId,
    title: 'The Long Walk',
    script: 'INT. HALLWAY — NIGHT',
    aspectRatio: '16:9',
    musicPromptSource: 'ai-generated',
    styleConfig: migrateStyleConfigV1ToV2({
      mood: 'tense and hopeful',
      artStyle: 'photoreal cinematic',
      lighting: 'hard key, deep shadows',
      colorPalette: ['#101020', '#e0d0b0'],
      cameraWork: 'handheld, tight lenses',
      referenceFilms: ['Children of Men'],
      colorGrading: 'cool shadows, warm highlights',
    }),
    analysisModelId: DEFAULT_ANALYSIS_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL,
    videoModel: DEFAULT_VIDEO_MODEL,
    elementIds: [],
    options: {
      shotsPerScene: 3,
      generateThumbnails: true,
      generateDescriptions: true,
      aiProvider: 'openrouter',
      regenerateAll: true,
    },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowEvent stub: onFailure only reads payload
  return {
    payload,
    instanceId: 'storyboard_run_A',
    timestamp: new Date(0),
  };
}

function makeScopedDb(status: 'processing' | 'failed') {
  const updateStatus = vi.fn();
  const getForUser = vi.fn(async () => ({ id: 'seq_1', status }));
  const stub = {
    // The existence guard is a sanctioned live read (#1067).
    liveRead: { sequences: { getForUser } },
    sequence: vi.fn(() => ({ updateStatus })),
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowScopedDb stub exposing only what onFailure touches
  const scopedDb = stub as unknown as WorkflowScopedDb;
  return { scopedDb, updateStatus, getForUser };
}

describe('StoryboardWorkflow.onFailure', () => {
  test('marks the sequence failed and emits generation.failed', async () => {
    emit.mockReset();
    getGenerationChannel.mockClear();
    const { scopedDb, updateStatus } = makeScopedDb('processing');

    await makeWorkflow().invokeOnFailure({
      event: makeEvent('seq_1'),
      error: 'Child workflow analyze-script timed out',
      scopedDb,
    });

    expect(updateStatus).toHaveBeenCalledWith(
      'failed',
      'Child workflow analyze-script timed out'
    );
    expect(getGenerationChannel).toHaveBeenCalledWith('seq_1');
    expect(emit).toHaveBeenCalledWith('generation.failed', {
      message: 'Child workflow analyze-script timed out',
    });
  });

  test('child already marked the sequence failed → no write, no emit', async () => {
    emit.mockReset();
    const { scopedDb, updateStatus } = makeScopedDb('failed');

    await makeWorkflow().invokeOnFailure({
      event: makeEvent('seq_1'),
      error: 'Child workflow analyze-script… failed',
      scopedDb,
    });

    expect(updateStatus).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  test('missing sequenceId → no DB access', async () => {
    emit.mockReset();
    const { scopedDb, updateStatus, getForUser } = makeScopedDb('processing');

    await makeWorkflow().invokeOnFailure({
      event: makeEvent(undefined),
      error: 'boom',
      scopedDb,
    });

    expect(getForUser).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
