/**
 * Persist seams for the prompt-only studio workflow (#1274).
 *
 * Generation itself is covered by image/motion tests; here we pin the row
 * transitions this workflow owns.
 */

import { describe, expect, it, vi } from 'vitest';
import { micros } from '@/lib/billing/money';
import type { GeneratedAssetOutput } from '@/lib/db/schema';
import {
  persistStudioCompletion,
  persistStudioFailure,
  type StudioPersistScopedDb,
} from './studio-generation-workflow';

function fakeDb(): StudioPersistScopedDb & {
  completed: Array<{
    id: string;
    outputs: GeneratedAssetOutput[];
    costMicros: number | null | undefined;
  }>;
  failed: Array<{ id: string; error: string }>;
} {
  const completed: Array<{
    id: string;
    outputs: GeneratedAssetOutput[];
    costMicros: number | null | undefined;
  }> = [];
  const failed: Array<{ id: string; error: string }> = [];
  return {
    completed,
    failed,
    generatedAssets: {
      markRunning: vi.fn(),
      markCompleted: async (id, fields) => {
        completed.push({
          id,
          outputs: fields.outputs,
          costMicros: fields.costMicros,
        });
      },
      markFailed: async (id, error) => {
        failed.push({ id, error });
      },
    },
  };
}

describe('persistStudioCompletion', () => {
  it('writes outputs and the billed cost onto the reserved row', async () => {
    const db = fakeDb();
    const outputs: GeneratedAssetOutput[] = [
      { url: '/r2/thumbnails/a.png', contentType: 'image/png' },
    ];
    await persistStudioCompletion({
      scopedDb: db,
      assetId: 'asset-1',
      outputs,
      costMicros: micros(12_000),
    });
    expect(db.completed).toEqual([
      { id: 'asset-1', outputs, costMicros: 12_000 },
    ]);
  });
});

describe('persistStudioFailure', () => {
  it('flips the reserved row to failed with the sanitized error', async () => {
    const db = fakeDb();
    await persistStudioFailure({
      scopedDb: db,
      assetId: 'asset-1',
      error: 'The model rejected the prompt.',
    });
    expect(db.failed).toEqual([
      { id: 'asset-1', error: 'The model rejected the prompt.' },
    ]);
  });
});
