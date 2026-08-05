/**
 * Behavioural tests for the per-shot image-workflow hash helpers.
 *
 * `generateImageWorkflow` opts into the snapshot pattern so it can detect
 * drift between trigger-time and write-time. These tests pin that the inlined
 * DTO hash (`computeImageWorkflowHashFromDto`) and the re-resolved live hash
 * (`computeImageWorkflowHashCurrent`) agree on the convergent path and diverge
 * when any bound input (character sheet, element reference, model) changes
 * mid-flight.
 *
 * The convergent/divergent WRITE builders and the `persistImageResult`
 * orchestration were retired in #989: image divergence no longer reverts a
 * speculative primary thumbnail on `shots`/`shot_variants`. Image generation
 * now appends a `frame_variants` version and repoints
 * `frames.selectedImageVersionId`, so only the hash-comparison helpers remain.
 */

import { describe, expect, it } from 'vitest';
import type {
  ShotImageSceneSnapshot,
  ImageWorkflowInput,
} from '@/lib/workflow/types';
import {
  computeImageWorkflowHashCurrent,
  computeImageWorkflowHashFromDto,
  type ImageHashScopedDb,
  type SceneForHash,
} from './image-workflow-snapshot';

const baseScene: ShotImageSceneSnapshot = {
  sceneId: 's1',
  visualPrompt: 'A wide establishing shot of Jack at the docks at dusk',
  characterSheetHashes: ['jack-hash-v1'],
  locationSheetHashes: ['docks-hash-v1'],
  elementReferenceHashes: [],
};

const baseInput: ImageWorkflowInput = {
  userId: 'u1',
  teamId: 't1',
  sequenceId: 'seq1',
  shotId: 'f1',
  prompt: baseScene.visualPrompt,
  model: 'nano_banana_2',
  aspectRatio: '16:9',
  sceneSnapshot: baseScene,
};

const DEFAULT_SCENE: SceneForHash = {
  continuity: {
    characterTags: ['jack'],
    environmentTag: 'docks',
    elementTags: [],
  },
  metadata: { location: 'Docks' },
  originalScript: { extract: '' },
};

function buildHashScopedDb(opts: {
  characterSheetHash?: string | null;
  locationReferenceHash?: string | null;
  elementImageUrl?: string;
  shotMetadata?: SceneForHash | null;
}): ImageHashScopedDb {
  // `in` check distinguishes explicit `null` (data-corruption case) from omitted (default).
  const metadata =
    'shotMetadata' in opts ? (opts.shotMetadata ?? null) : DEFAULT_SCENE;
  return {
    shots: {
      getById: async () => ({ metadata }),
    },
    characters: {
      listWithSheets: async () =>
        opts.characterSheetHash === undefined
          ? []
          : [
              {
                id: 'c1',
                characterId: 'jack',
                consistencyTag: 'jack',
                name: 'Jack',
                physicalDescription: null,
                sheetImageUrl: 'https://example.com/jack.png',
                sheetStatus: 'completed',
                sheetInputHash: opts.characterSheetHash,
              },
            ],
    },
    sequenceLocations: {
      listWithReferences: async () =>
        opts.locationReferenceHash === undefined
          ? []
          : [
              {
                id: 'l1',
                locationId: 'docks',
                description: null,
                consistencyTag: 'docks',
                name: 'Docks',
                referenceImageUrl: 'https://example.com/docks.png',
                referenceStatus: 'completed',
                referenceInputHash: opts.locationReferenceHash,
              },
            ],
    },
    sequenceElements: {
      list: async () =>
        opts.elementImageUrl === undefined
          ? []
          : [
              {
                id: 'e1',
                token: 'LOGO',
                description: null,
                consistencyTag: 'logo',
                imageUrl: opts.elementImageUrl,
              },
            ],
    },
  };
}

const unreachableHashScopedDb: ImageHashScopedDb = {
  shots: {
    getById: async () => {
      throw new Error('shots.getById should not be called in this test');
    },
  },
  characters: {
    listWithSheets: async () => {
      throw new Error('characters.listWithSheets should not be called');
    },
  },
  sequenceLocations: {
    listWithReferences: async () => {
      throw new Error(
        'sequenceLocations.listWithReferences should not be called'
      );
    },
  },
  sequenceElements: {
    list: async () => {
      throw new Error('sequenceElements.list should not be called');
    },
  },
};

describe('computeImageWorkflowHashFromDto', () => {
  it('returns the inlined hash sentinel when no snapshot is opted in', async () => {
    const result = await computeImageWorkflowHashFromDto({
      ...baseInput,
      sceneSnapshot: undefined,
      snapshotInputHash: undefined,
    });
    expect(result).toBe('');
  });

  it('produces a deterministic hash for identical snapshots', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto(baseInput);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('changes the hash when the model changes', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto({
      ...baseInput,
      model: 'seedream_v5',
    });
    expect(a).not.toBe(b);
  });

  it('changes the hash when a character sheet hash changes', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto({
      ...baseInput,
      sceneSnapshot: {
        ...baseScene,
        characterSheetHashes: ['jack-hash-v2'],
      },
    });
    expect(a).not.toBe(b);
  });
});

describe('computeImageWorkflowHashCurrent', () => {
  it('matches the DTO hash on the convergent path (live state == snapshot)', async () => {
    const dtoHash = await computeImageWorkflowHashFromDto(baseInput);
    const currentHash = await computeImageWorkflowHashCurrent(
      baseInput,
      buildHashScopedDb({
        characterSheetHash: 'jack-hash-v1',
        locationReferenceHash: 'docks-hash-v1',
      })
    );
    expect(currentHash).toBe(dtoHash);
  });

  it('diverges from the DTO hash when a character sheet was re-hashed mid-flight', async () => {
    const dtoHash = await computeImageWorkflowHashFromDto(baseInput);
    const currentHash = await computeImageWorkflowHashCurrent(
      baseInput,
      buildHashScopedDb({
        characterSheetHash: 'jack-hash-v2',
        locationReferenceHash: 'docks-hash-v1',
      })
    );
    expect(currentHash).not.toBe(dtoHash);
  });

  it('diverges when an element reference image was swapped', async () => {
    const inputWithElement: ImageWorkflowInput = {
      ...baseInput,
      sceneSnapshot: {
        ...baseScene,
        elementReferenceHashes: ['https://example.com/logo-v1.png'],
      },
    };
    const stub = buildHashScopedDb({
      characterSheetHash: 'jack-hash-v1',
      locationReferenceHash: 'docks-hash-v1',
      elementImageUrl: 'https://example.com/logo-v2.png',
      shotMetadata: {
        continuity: {
          characterTags: ['jack'],
          environmentTag: 'docks',
          elementTags: ['LOGO'],
        },
        metadata: { location: 'Docks' },
        originalScript: { extract: 'see LOGO at the door' },
      },
    });
    const dtoHash = await computeImageWorkflowHashFromDto(inputWithElement);
    const currentHash = await computeImageWorkflowHashCurrent(
      inputWithElement,
      stub
    );
    expect(currentHash).not.toBe(dtoHash);
  });

  it('returns the inlined hash sentinel when no snapshot is opted in', async () => {
    const result = await computeImageWorkflowHashCurrent(
      { ...baseInput, sceneSnapshot: undefined, snapshotInputHash: undefined },
      unreachableHashScopedDb
    );
    expect(result).toBe('');
  });

  it('throws when sceneSnapshot is present but aspectRatio is missing', () => {
    expect(
      computeImageWorkflowHashCurrent(
        { ...baseInput, aspectRatio: undefined },
        buildHashScopedDb({
          characterSheetHash: 'jack-hash-v1',
          locationReferenceHash: 'docks-hash-v1',
        })
      )
    ).rejects.toThrow(/aspectRatio is required/);
  });

  it('throws when the shot exists but has null metadata (data corruption)', () => {
    const stub = buildHashScopedDb({
      characterSheetHash: 'jack-hash-v1',
      locationReferenceHash: 'docks-hash-v1',
      shotMetadata: null,
    });
    expect(computeImageWorkflowHashCurrent(baseInput, stub)).rejects.toThrow(
      /null metadata/
    );
  });
});

describe('computeImageWorkflowHashFromDto — aspectRatio guard', () => {
  it('throws when sceneSnapshot is present but aspectRatio is missing', () => {
    expect(() =>
      computeImageWorkflowHashFromDto({
        ...baseInput,
        aspectRatio: undefined,
      })
    ).toThrow(/aspectRatio is required/);
  });
});

// The `buildImageConvergentWrites`, `buildImageDivergentWrites`, and
// `persistImageResult` describe blocks were removed in #989: image divergence
// is retired (no speculative primary thumbnail on `shots`/`shot_variants` to
// revert), so those helpers no longer exist. Image selection now happens via
// `frameVariants.select` — covered by `frame-variants.test.ts`.
