import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { Shot } from '@/types/database';
import { describe, expect, test } from 'vitest';
import { generateChaptersVTT } from './generate-chapters';

// Helper to create minimal test scene metadata
const createTestScene = (overrides: Partial<Scene>): Scene => ({
  sceneId: 'test-scene',
  sceneNumber: 1,
  originalScript: { extract: '', dialogue: [] },
  ...overrides,
});

// Helper to create test shots with minimal required fields
const createTestShot = (overrides: Partial<Shot>): Shot => ({
  id: '1',
  sequenceId: 'seq-1',
  sceneId: null,
  shotNumber: null,
  orderIndex: 0,
  description: null,
  durationMs: 3000,
  videoUrl: null,
  videoPath: null,
  videoStatus: 'pending',
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  videoWorkflowRunId: null,
  videoGeneratedAt: null,
  videoError: null,
  motionModel: 'veo3',
  motionPrompt: null,
  audioUrl: null,
  audioPath: null,
  audioStatus: 'pending',
  audioWorkflowRunId: null,
  audioGeneratedAt: null,
  audioError: null,
  audioModel: null,
  videoInputHash: null,
  audioInputHash: null,
  motionPromptInputHash: null,
  selectedMotionPromptVersionId: null,
  renderSegmentId: null,
  ...overrides,
});

describe('generateChaptersVTT', () => {
  test('generates valid WebVTT chapters with metadata', () => {
    const shots: Shot[] = [
      createTestShot({
        id: '1',
        durationMs: 5000,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
        metadata: createTestScene({
          sceneNumber: 1,
          metadata: {
            title: 'Opening Scene',
            durationSeconds: 5,
            location: 'Beach',
            timeOfDay: 'morning',
            storyBeat: 'Introduction',
          },
        }),
      }),
      createTestShot({
        id: '2',
        orderIndex: 1,
        durationMs: 3000,
        videoUrl: 'https://example.com/video2.mp4',
        videoStatus: 'completed',
        metadata: createTestScene({
          sceneNumber: 2,
          metadata: {
            title: 'Conflict Arises',
            durationSeconds: 3,
            location: 'Office',
            timeOfDay: 'afternoon',
            storyBeat: 'Rising action',
          },
        }),
      }),
    ];

    const vtt = generateChaptersVTT(shots);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Scene 1: Opening Scene');
    expect(vtt).toContain('Scene 2: Conflict Arises');
    expect(vtt).toContain('00:00:00.000 --> 00:00:05.000');
    expect(vtt).toContain('00:00:05.000 --> 00:00:08.000');
  });

  test('handles shots without metadata', () => {
    const shots: Shot[] = [
      createTestShot({
        id: '1',
        durationMs: 3000,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
      }),
      createTestShot({
        id: '2',
        orderIndex: 1,
        durationMs: 2000,
        videoUrl: 'https://example.com/video2.mp4',
        videoStatus: 'completed',
      }),
    ];

    const vtt = generateChaptersVTT(shots);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Scene 1');
    expect(vtt).toContain('Scene 2');
  });

  test('defaults to 3 seconds when durationMs is null', () => {
    const shots: Shot[] = [
      createTestShot({
        durationMs: null,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
      }),
    ];

    const vtt = generateChaptersVTT(shots);

    expect(vtt).toContain('00:00:00.000 --> 00:00:03.000');
  });

  test('calculates cumulative time correctly', () => {
    const shots: Shot[] = [
      createTestShot({
        id: '1',
        durationMs: 5000,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
      }),
      createTestShot({
        id: '2',
        orderIndex: 1,
        durationMs: 7000,
        videoUrl: 'https://example.com/video2.mp4',
        videoStatus: 'completed',
      }),
      createTestShot({
        id: '3',
        orderIndex: 2,
        durationMs: 4000,
        videoUrl: 'https://example.com/video3.mp4',
        videoStatus: 'completed',
      }),
    ];

    const vtt = generateChaptersVTT(shots);

    // First chapter: 0-5 seconds
    expect(vtt).toContain('00:00:00.000 --> 00:00:05.000');
    // Second chapter: 5-12 seconds
    expect(vtt).toContain('00:00:05.000 --> 00:00:12.000');
    // Third chapter: 12-16 seconds
    expect(vtt).toContain('00:00:12.000 --> 00:00:16.000');
  });

  test('formats timestamps correctly for hours', () => {
    const shots: Shot[] = [
      createTestShot({
        id: '1',
        durationMs: 3600000,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
      }),
      createTestShot({
        id: '2',
        orderIndex: 1,
        durationMs: 125000,
        videoUrl: 'https://example.com/video2.mp4',
        videoStatus: 'completed',
      }),
    ];

    const vtt = generateChaptersVTT(shots);

    expect(vtt).toContain('00:00:00.000 --> 01:00:00.000');
    expect(vtt).toContain('01:00:00.000 --> 01:02:05.000');
  });

  test('handles empty shots array', () => {
    const shots: Shot[] = [];

    const vtt = generateChaptersVTT(shots);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('NOTE Generated chapters from shots');
    // Should not contain any chapter markers
    const lines = vtt.split('\n').filter((line) => line.includes('-->'));
    expect(lines).toHaveLength(0);
  });

  test('uses scene metadata for chapter titles', () => {
    const shots: Shot[] = [
      createTestShot({
        durationMs: 3000,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
        metadata: createTestScene({
          sceneNumber: 5,
          metadata: {
            title: 'The Great Revelation',
            durationSeconds: 3,
            location: 'Castle',
            timeOfDay: 'night',
            storyBeat: 'Climax',
          },
        }),
      }),
    ];

    const vtt = generateChaptersVTT(shots);

    expect(vtt).toContain('Scene 5: The Great Revelation');
  });

  test('escapes XSS vectors in scene titles', () => {
    const xssVectors = [
      {
        input: "<script>alert('XSS')</script>",
        expected: "&lt;script&gt;alert('XSS')&lt;/script&gt;",
      },
      {
        input: '<img src=x onerror=alert(1)>',
        expected: '&lt;img src=x onerror=alert(1)&gt;',
      },
      {
        input: 'Scene --> 00:05:00',
        expected: 'Scene —&gt; 00:05:00',
      },
      {
        input: 'Title with &amp; entity',
        expected: 'Title with &amp;amp; entity',
      },
      {
        input: 'Line one\nLine two',
        expected: 'Line one Line two',
      },
    ];

    for (const { input, expected } of xssVectors) {
      const shots: Shot[] = [
        createTestShot({
          durationMs: 3000,
          metadata: createTestScene({
            sceneNumber: 1,
            metadata: {
              title: input,
              durationSeconds: 3,
              location: 'Test',
              timeOfDay: 'day',
              storyBeat: 'Test',
            },
          }),
        }),
      ];

      const vtt = generateChaptersVTT(shots);
      expect(vtt).toContain(`Scene 1: ${expected}`);
      expect(vtt).not.toContain(input !== expected ? input : '<<impossible>>');
    }
  });

  test('handles fractional seconds in timestamps', () => {
    const shots: Shot[] = [
      createTestShot({
        durationMs: 1234, // 1.234 seconds
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
      }),
    ];

    const vtt = generateChaptersVTT(shots);

    expect(vtt).toContain('00:00:00.000 --> 00:00:01.234');
  });
});
