import { describe, expect, test } from 'vitest';
import { exportClipProgress, exportPendingLabel } from './export-readiness';

describe('exportClipProgress', () => {
  test('cannot export with no shots', () => {
    expect(exportClipProgress([])).toEqual({
      clipsReady: 0,
      clipsTotal: 0,
      canExport: false,
    });
  });

  test('cannot export while any shot is still generating', () => {
    expect(
      exportClipProgress([
        { video: { url: 'https://cdn.example/a.mp4' } },
        { video: { url: 'https://cdn.example/b.mp4' } },
        { video: { url: null } },
        { video: null },
        {},
        { video: { url: 'https://cdn.example/f.mp4' } },
      ])
    ).toEqual({
      clipsReady: 3,
      clipsTotal: 6,
      canExport: false,
    });
  });

  test('can export only when every shot has a clip', () => {
    expect(
      exportClipProgress([
        { video: { url: 'https://cdn.example/a.mp4' } },
        { video: { url: 'https://cdn.example/b.mp4' } },
      ])
    ).toEqual({
      clipsReady: 2,
      clipsTotal: 2,
      canExport: true,
    });
  });
});

describe('exportPendingLabel', () => {
  test('puts the ready count in the disabled export label', () => {
    expect(exportPendingLabel(3, 6)).toBe('Export · 3 of 6 clips ready');
  });
});
