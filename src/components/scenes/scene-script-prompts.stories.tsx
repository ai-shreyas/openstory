import type { Frame } from '@/lib/db/schema';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import {
  SceneScriptPrompts,
  tabsForScope,
  type TabValue,
} from './scene-script-prompts';

// The still-image surface moved off `shots` onto the anchor `frame` in #989;
// the component reads the legacy projected names (`thumbnail*`/`image*`), so the
// fixture keeps them and adds the raw anchor `frame`.
const mockShot = {
  id: 'shot-1',
  sequenceId: 'seq-1',
  sceneId: null,
  shotNumber: null,
  orderIndex: 0,
  description: 'A bustling coffee shop interior during morning rush hour',
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
  motionPrompt: null,
  motionModel: 'veo3',
  motionPromptData: null,
  selectedMotionPromptVersionId: null,
  renderSegmentId: null,
  audioUrl: null,
  audioPath: null,
  audioStatus: 'pending',
  audioWorkflowRunId: null,
  audioGeneratedAt: null,
  audioError: null,
  audioModel: null,
  thumbnailInputHash: null,
  videoInputHash: null,
  audioInputHash: null,
  visualPromptInputHash: null,
  motionPromptInputHash: null,
  previewThumbnailUrl: null,
  metadata: {
    sceneId: 'scene-1',
    sceneNumber: 1,
    originalScript: {
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
    metadata: {
      title: 'Coffee Shop Introduction',
      durationSeconds: 3,
      location: 'Coffee Shop',
      timeOfDay: 'Morning',
      storyBeat: 'Establish protagonist stress and setting',
    },
    continuity: {
      characterTags: [],
      environmentTag: '',
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
    musicDesign: {
      presence: 'none',
      style: '',
      mood: '',
      atmosphere: '',
    },
    sourceImageUrl: '',
  },
  createdAt: new Date(),
  updatedAt: new Date(),
  frame: {
    id: 'shot-1',
    shotId: 'shot-1',
    sequenceId: 'seq-1',
    orderIndex: 0,
    role: 'first',
    source: 'generated',
    previewImageUrl: null,
    imageStatus: 'completed',
    imageWorkflowRunId: null,
    imageError: null,
    imagePrompt: null,
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    visualPromptInputHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies Frame,
} satisfies ShotWithImage;

const meta: Meta<typeof SceneScriptPrompts> = {
  title: 'Scenes/SceneScriptPrompts',
  component: SceneScriptPrompts,
  parameters: {
    layout: 'centered',
  },
  args: {
    sequenceId: 'seq-1',
    selectedTab: 'script' as TabValue,
    visibleTabs: tabsForScope('shot'),
    onTabChange: fn(),
    regeneratingImages: new Set<string>(),
    regeneratingMotion: new Set<string>(),
    onRegenerateStart: fn(),
    // Resolved per-asset models (#1066) — these are required props; without
    // them IMAGE_TO_VIDEO_MODELS[undefined] is undefined and the component
    // crashes on `'requiredStyleCategory' in undefined`.
    resolvedImageModel: 'gpt_image_2',
    resolvedVideoModel: 'seedance_v2',
  },
  decorators: [
    (Story) => (
      <div className="w-[600px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SceneScriptPrompts>;

export const Default: Story = {
  args: {
    shot: mockShot,
  },
};

export const Loading: Story = {
  args: {
    shot: undefined,
  },
};

export const PartiallyLoaded: Story = {
  args: {
    shot: {
      ...mockShot,
      metadata: null,
    },
  },
};

export const LongScript: Story = {
  args: {
    shot: {
      ...mockShot,
      durationMs: 8500,
      metadata: {
        ...mockShot.metadata,
        originalScript: {
          extract: `INT. COFFEE SHOP - MORNING

SARAH sits at a corner table, typing furiously on her laptop. Steam rises from her untouched latte. The morning sun streams through large windows, casting long shadows across the wooden floor.

Other patrons bustle about, ordering drinks and chatting, creating a backdrop of ambient noise that Sarah tries to tune out. Her phone BUZZES. She glances at it, frowns, and silences it without reading the message.

BARISTA (O.S.)
    Large oat milk latte for Sarah!

Sarah doesn't respond, too absorbed in her work. The barista shrugs and sets the drink aside.`,
          dialogue: [
            {
              character: 'BARISTA',
              line: 'Large oat milk latte for Sarah!',
              tone: '',
            },
          ],
        },
      },
    },
  },
};

export const LongPrompts: Story = {
  args: {
    shot: {
      ...mockShot,
      metadata: {
        ...mockShot.metadata,
      },
    },
  },
};

export const ShortScript: Story = {
  args: {
    shot: {
      ...mockShot,
      durationMs: 1500,
      metadata: {
        ...mockShot.metadata,
        originalScript: {
          extract: 'INT. COFFEE SHOP - MORNING\n\nSARAH types on laptop.',
          dialogue: [],
        },
      },
    },
  },
};

export const NoDuration: Story = {
  args: {
    shot: {
      ...mockShot,
      durationMs: null,
    },
  },
};
