import type { SceneWithScript } from '@/hooks/use-scenes';
import { dbSceneId, type VideoVariant } from '@/lib/db/schema';
import { frameFixtureFor, videoFixtureFor } from '@/lib/mocks/frame-fixtures';
import {
  projectShotWithImage,
  type ShotWithImage,
} from '@/lib/shots/shot-with-image';
import type { Meta, StoryObj } from '@storybook/react';
import { ScenePlayer } from './scene-player';

const meta: Meta<typeof ScenePlayer> = {
  title: 'Motion/ScenePlayer',
  component: ScenePlayer,
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof ScenePlayer>;

// The still IMAGE surface moved off `shots` onto the anchor frame in #989. The
// mock rows carry the legacy `thumbnail*`/`image*` names the player still reads
// (the `ShotWithImage` projection); mirror them back onto a concrete anchor
// `Frame` (id == shot.id) so each row matches what `getShotsFn` returns.
/**
 * The segment's newest primary render — the row a shot's video lifecycle is
 * derived from (#1067). `videoFixtureFor` is url-gated, so a render that never
 * produced one borrows an empty url and puts the real (null) one back.
 */
const primaryVideoFixture = (
  shot: Omit<ShotWithImage, 'frame'>
): VideoVariant | null => {
  const status = shot.videoStatus;
  if (status === null) return null;
  const row = videoFixtureFor({ ...shot, videoUrl: shot.videoUrl ?? '' });
  if (!row) return null;
  return {
    ...row,
    url: shot.videoUrl,
    status,
    error: shot.videoError,
    workflowRunId: shot.videoWorkflowRunId,
  };
};

const toShotWithImage = (shot: Omit<ShotWithImage, 'frame'>): ShotWithImage => {
  const { frame, selectedVersion } = frameFixtureFor(shot);
  return projectShotWithImage(shot, frame, {
    selectedImage: selectedVersion,
    selectedImagePrompt: null,
    selectedVideo: videoFixtureFor(shot),
    primaryVideo: primaryVideoFixture(shot),
    gridSheet: {
      url: shot.variantImageUrl,
      status: shot.variantImageStatus,
    },
  });
};

// A shot row before its anchor frame is attached. Annotating each mock array as
// `MockShotRow[]` gives the literal a contextual type so the status fields
// ('completed' etc.) keep their enum-literal types instead of widening to
// `string` through `.map` (which would break assignability to `ShotWithImage`).
type MockShotRow = Omit<ShotWithImage, 'frame'>;

/**
 * The player takes its title from the shot's scene (#1067), so each mock shot
 * points at one of these by `sceneId: 'scene-<n>'`.
 */
const mockScene = (orderIndex: number, title: string): SceneWithScript => ({
  id: dbSceneId(`scene-${orderIndex + 1}`),
  sequenceId: 'seq-1',
  orderIndex,
  location: 'Forest',
  timeOfDay: 'Dawn',
  storyBeat: 'Introduction',
  title,
  continuity: null,
  musicDesign: null,
  originalScript: null,
  script: { extract: 'Sample scene text', dialogue: [] },
  selectedScriptVersionId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const mockShotBase = {
  sequenceId: 'seq-1',
  sceneId: null,
  shotNumber: 1,
  durationMs: 5000,
  thumbnailWorkflowRunId: null,
  imageModel: null,
  thumbnailError: null,
  imagePrompt: null,
  videoWorkflowRunId: null,
  videoGeneratedAt: null,
  videoError: null,
  motionPrompt: null,
  motionModel: 'veo3',
  motionPromptData: null,
  selectedMotionPromptVersionId: null,
  renderSegmentId: null,
  thumbnailInputHash: null,
  videoInputHash: null,
  visualPromptInputHash: null,
  motionPromptInputHash: null,
  variantImageUrl: null,
  variantImageStatus: 'pending' as const,
  previewThumbnailUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Mock shots with scene metadata
const mockShots: ShotWithImage[] = (
  [
    {
      ...mockShotBase,
      id: '1',
      thumbnailUrl: 'https://picsum.photos/seed/scene1/1280/720',
      thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
      variantImageUrl: 'https://picsum.photos/seed/scene1/1280/720',
      videoUrl:
        'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
      videoPath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
      thumbnailStatus: 'completed',
      videoStatus: 'completed',
      variantImageStatus: 'completed',
      sceneId: 'scene-1',
    },
    {
      ...mockShotBase,
      id: '2',
      thumbnailUrl: 'https://picsum.photos/seed/scene2/1280/720',
      thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
      variantImageUrl: 'https://picsum.photos/seed/scene2/1280/720',
      videoUrl:
        'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
      videoPath: 'teams/mock/sequences/mock/frames/2/motion.mp4',
      thumbnailStatus: 'completed',
      videoStatus: 'completed',
      variantImageStatus: 'completed',
      sceneId: 'scene-2',
    },
    {
      ...mockShotBase,
      id: '3',
      thumbnailUrl: 'https://picsum.photos/seed/scene3/1280/720',
      thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
      variantImageUrl: 'https://picsum.photos/seed/scene3/1280/720',
      videoUrl: null,
      videoPath: null,
      thumbnailStatus: 'completed',
      videoStatus: 'pending',
      variantImageStatus: 'pending',
      sceneId: 'scene-3',
    },
  ] satisfies MockShotRow[]
).map(toShotWithImage);

const mockScenes: SceneWithScript[] = [
  mockScene(0, 'Opening Scene'),
  mockScene(1, 'The Journey'),
  mockScene(2, 'Climax'),
];

// Note: This component now shows ALL shots with completed thumbnails, not just completed videos.
// Shots with pending/generating/failed video status show poster frame with status overlay.

export const WithMockSequence: Story = {
  args: {
    selectedShotId: '1',
    shots: mockShots,
    scenes: mockScenes,
    aspectRatio: '16:9',
    onSelectShot: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          'Demonstrates sequential playback with mixed video states. Scene 1-2 play videos, Scene 3 shows pending overlay on poster frame. Navigate through scenes to see different states.',
      },
    },
  },
};

export const AllVideoStates: Story = {
  args: {
    selectedShotId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: (
      [
        {
          ...mockShotBase,
          id: '1',
          thumbnailUrl: 'https://picsum.photos/seed/state1/1280/720',
          thumbnailPath:
            'teams/mock/sequences/mock/frames/state1/thumbnail.jpg',
          variantImageUrl: 'https://picsum.photos/seed/state1/1280/720',
          videoUrl:
            'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
          videoPath: 'teams/mock/sequences/mock/frames/state1/motion.mp4',
          thumbnailStatus: 'completed',
          videoStatus: 'completed',
          variantImageStatus: 'completed',
          sceneId: 'scene-1',
        },
        {
          ...mockShotBase,
          id: '2',
          thumbnailUrl: 'https://picsum.photos/seed/state2/1280/720',
          thumbnailPath:
            'teams/mock/sequences/mock/frames/state2/thumbnail.jpg',
          variantImageUrl: 'https://picsum.photos/seed/state2/1280/720',
          videoUrl: null,
          videoPath: null,
          thumbnailStatus: 'completed',
          videoStatus: 'pending',
          variantImageStatus: 'pending',
          sceneId: 'scene-2',
        },
        {
          ...mockShotBase,
          id: '3',
          thumbnailUrl: 'https://picsum.photos/seed/state3/1280/720',
          thumbnailPath:
            'teams/mock/sequences/mock/frames/state3/thumbnail.jpg',
          variantImageUrl: 'https://picsum.photos/seed/state3/1280/720',
          videoUrl: null,
          videoPath: null,
          thumbnailStatus: 'completed',
          videoStatus: 'generating',
          variantImageStatus: 'generating',
          sceneId: 'scene-3',
        },
        {
          ...mockShotBase,
          id: '4',
          thumbnailUrl: 'https://picsum.photos/seed/state4/1280/720',
          thumbnailPath:
            'teams/mock/sequences/mock/frames/state4/thumbnail.jpg',
          variantImageUrl: 'https://picsum.photos/seed/state4/1280/720',
          videoUrl: null,
          videoPath: null,
          thumbnailStatus: 'completed',
          videoStatus: 'failed',
          variantImageStatus: 'failed',
          sceneId: 'scene-4',
        },
      ] satisfies MockShotRow[]
    ).map(toShotWithImage),
    scenes: [
      mockScene(0, 'Completed Video'),
      mockScene(1, 'Pending Video'),
      mockScene(2, 'Generating Video'),
      mockScene(3, 'Failed Video'),
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows all possible video states: completed (plays video), pending (clock icon), generating (spinner), and failed (error icon). Navigate through scenes to see each state overlay.',
      },
    },
  },
};

export const OnlyPendingVideos: Story = {
  args: {
    selectedShotId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: (
      [
        {
          ...mockShotBase,
          id: '1',
          thumbnailUrl: 'https://picsum.photos/seed/pending1/1280/720',
          thumbnailPath:
            'teams/mock/sequences/mock/frames/pending1/thumbnail.jpg',
          variantImageUrl: 'https://picsum.photos/seed/pending1/1280/720',
          videoUrl: null,
          videoPath: null,
          thumbnailStatus: 'completed',
          videoStatus: 'pending',
          variantImageStatus: 'pending',
          sceneId: 'scene-1',
        },
        {
          ...mockShotBase,
          id: '2',
          thumbnailUrl: 'https://picsum.photos/seed/pending2/1280/720',
          thumbnailPath:
            'teams/mock/sequences/mock/frames/pending2/thumbnail.jpg',
          variantImageUrl: 'https://picsum.photos/seed/pending2/1280/720',
          videoUrl: null,
          videoPath: null,
          thumbnailStatus: 'completed',
          videoStatus: 'pending',
          variantImageStatus: 'pending',
          sceneId: 'scene-2',
        },
      ] satisfies MockShotRow[]
    ).map(toShotWithImage),
    scenes: [mockScene(0, 'Pending Scene 1'), mockScene(1, 'Pending Scene 2')],
  },
  parameters: {
    docs: {
      description: {
        story:
          'All shots have completed thumbnails but pending videos. Shows how the player handles a sequence where no videos are ready yet.',
      },
    },
  },
};

export const FailedVideoWithThumbnail: Story = {
  args: {
    selectedShotId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: (
      [
        {
          ...mockShotBase,
          id: '1',
          thumbnailUrl: 'https://picsum.photos/seed/failed-thumb/1280/720',
          thumbnailPath:
            'teams/mock/sequences/mock/frames/failed/thumbnail.jpg',
          videoUrl: null,
          videoPath: null,
          variantImageUrl: null,
          thumbnailStatus: 'completed',
          videoStatus: 'failed',
          videoError: 'Model generation timeout',
          variantImageStatus: 'completed',
          sceneId: 'scene-1',
        },
      ] satisfies MockShotRow[]
    ).map(toShotWithImage),
    scenes: [mockScene(0, 'Failed Video Generation')],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Video generation failed but thumbnail succeeded. Shows error overlay with semi-transparent background over the thumbnail image.',
      },
    },
  },
};

export const PreviewMode: Story = {
  args: {
    selectedShotId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: (
      [
        {
          ...mockShotBase,
          id: '1',
          thumbnailUrl: null,
          thumbnailPath: null,
          previewThumbnailUrl: 'https://picsum.photos/seed/preview1/1280/720',
          videoUrl: null,
          videoPath: null,
          thumbnailStatus: 'generating',
          videoStatus: 'pending',
          variantImageStatus: 'pending',
          sceneId: 'scene-1',
        },
        {
          ...mockShotBase,
          id: '2',
          thumbnailUrl: null,
          thumbnailPath: null,
          previewThumbnailUrl: 'https://picsum.photos/seed/preview2/1280/720',
          videoUrl: null,
          videoPath: null,
          thumbnailStatus: 'generating',
          videoStatus: 'pending',
          variantImageStatus: 'pending',
          sceneId: 'scene-2',
        },
        {
          ...mockShotBase,
          id: '3',
          thumbnailUrl: 'https://picsum.photos/seed/final3/1280/720',
          thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
          previewThumbnailUrl: 'https://picsum.photos/seed/preview3/1280/720',
          videoUrl: null,
          videoPath: null,
          thumbnailStatus: 'completed',
          videoStatus: 'pending',
          variantImageStatus: 'pending',
          sceneId: 'scene-3',
        },
      ] satisfies MockShotRow[]
    ).map(toShotWithImage),
    scenes: [
      mockScene(0, 'Preview - Generating Full Image'),
      mockScene(1, 'Preview - Still Processing'),
      mockScene(2, 'Final Image Ready'),
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows preview mode where fast preview images are displayed while full-resolution thumbnails are still generating. Scenes 1-2 show the "Preview" badge, Scene 3 has its final image ready.',
      },
    },
  },
};

export const FailedVideoWithoutThumbnail: Story = {
  args: {
    selectedShotId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: (
      [
        {
          ...mockShotBase,
          id: '1',
          thumbnailUrl: null,
          thumbnailPath: null,
          videoUrl: null,
          videoPath: null,
          variantImageUrl: null,
          thumbnailStatus: 'failed',
          videoStatus: 'failed',
          thumbnailError: 'Image generation failed',
          variantImageStatus: 'pending',
          videoError: 'Cannot generate video without thumbnail',
          sceneId: 'scene-1',
        },
      ] satisfies MockShotRow[]
    ).map(toShotWithImage),
    scenes: [mockScene(0, 'Complete Failure')],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Both thumbnail and video generation failed. Shows error overlay on a solid muted background since there is no thumbnail to display.',
      },
    },
  },
};
