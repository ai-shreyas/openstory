import { dbSceneId, type VideoVariant } from '@/lib/db/schema';
import type { SceneWithScript } from '@/hooks/use-scenes';
import { frameFixtureFor, videoFixtureFor } from '@/lib/mocks/frame-fixtures';
import {
  projectShotWithImage,
  type ShotWithImage,
} from '@/lib/shots/shot-with-image';
import type { Meta, StoryObj } from '@storybook/react';
import { SceneListItem } from './scene-list-item';

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

// The still IMAGE surface moved off `shots` onto the anchor frame in #989. The
// mock carries the legacy `thumbnail*`/`image*` names the card still reads (the
// `ShotWithImage` projection); mirror them back onto a concrete anchor `Frame`
// (id == shot.id) so the row matches what `getShotsFn` returns.
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

const mockShot: ShotWithImage = toShotWithImage({
  id: 'shot-1',
  sequenceId: 'seq-1',
  sceneId: null,
  shotNumber: 1,
  durationMs: 3000,
  thumbnailUrl: 'https://picsum.photos/seed/coffee/320/180',
  thumbnailPath: 'teams/mock/sequences/mock/frames/shot-1/thumbnail.jpg',
  variantImageUrl: null,
  variantImageStatus: 'pending',
  videoUrl: null,
  videoPath: null,
  thumbnailStatus: 'completed',
  videoStatus: 'pending',
  thumbnailWorkflowRunId: null,
  imageModel: null,
  thumbnailError: null,
  imagePrompt: null,
  videoWorkflowRunId: null,
  videoGeneratedAt: null,
  videoError: null,
  motionModel: 'veo3',
  motionPromptData: null,
  selectedMotionPromptVersionId: null,
  renderSegmentId: null,
  thumbnailInputHash: null,
  videoInputHash: null,
  visualPromptInputHash: null,
  previewThumbnailUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const mockScene: SceneWithScript = {
  id: dbSceneId('scene-1'),
  sequenceId: 'seq-1',
  orderIndex: 0,
  location: 'Coffee Shop',
  timeOfDay: 'Morning',
  storyBeat: 'Establish protagonist stress and setting',
  title: 'Coffee Shop Introduction',
  continuity: null,
  musicDesign: null,
  originalScript: null,
  script: {
    extract:
      'INT. COFFEE SHOP - MORNING\n\nSARAH sits at a corner table, typing furiously on her laptop. Steam rises from her untouched latte.',
    dialogue: [
      {
        character: 'SARAH',
        line: 'This deadline is going to kill me.',
        tone: '',
      },
    ],
  },
  selectedScriptVersionId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const meta: Meta<typeof SceneListItem> = {
  title: 'Scenes/SceneListItem',
  component: SceneListItem,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
  args: {
    scene: mockScene,
    onSelect: () => console.log('onSelect'),
  },
};

export default meta;
type Story = StoryObj<typeof SceneListItem>;

export const Inactive: Story = {
  args: {
    shot: mockShot,
    isActive: false,
  },
};

export const Active: Story = {
  args: {
    shot: mockShot,
    isActive: true,
  },
};

export const Completed: Story = {
  args: {
    shot: mockShot,
    isActive: false,
  },
};

export const ActiveAndCompleted: Story = {
  args: {
    shot: mockShot,
    isActive: true,
  },
};

export const Generating: Story = {
  args: {
    shot: {
      ...mockShot,
      thumbnailUrl: null,
      thumbnailStatus: 'generating',
    },
    isActive: false,
  },
};

export const GeneratingActive: Story = {
  args: {
    shot: {
      ...mockShot,
      thumbnailUrl: null,
      thumbnailStatus: 'generating',
    },
    isActive: true,
  },
};

export const Failed: Story = {
  args: {
    shot: {
      ...mockShot,
      thumbnailUrl: null,
      thumbnailStatus: 'failed',
      thumbnailError: 'Generation timeout',
    },
    isActive: false,
  },
};

export const LongTitle: Story = {
  args: {
    shot: mockShot,
    scene: {
      ...mockScene,
      title:
        'An Extremely Long Scene Title That Should Wrap Properly Without Breaking Layout',
    },
    isActive: false,
  },
};

export const LongScript: Story = {
  args: {
    shot: mockShot,
    scene: {
      ...mockScene,
      script: {
        extract:
          'INT. COFFEE SHOP - MORNING\n\nSARAH sits at a corner table, typing furiously on her laptop. Steam rises from her untouched latte. The morning sun streams through large windows, casting long shadows across the wooden floor. Other patrons bustle about, ordering drinks and chatting, creating a backdrop of ambient noise that Sarah tries to tune out.',
        dialogue: [],
      },
    },
    isActive: false,
  },
};
