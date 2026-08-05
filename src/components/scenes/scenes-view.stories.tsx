import { ScenesView } from '@/components/scenes/scenes-view';
import type { SceneWithScript } from '@/hooks/use-scenes';
import { dbSceneId } from '@/lib/db/schema';
import type { Sequence, Shot, Style } from '@/types/database';
import type { Meta, StoryObj } from '@storybook/react';
import {
  fixtureScenes,
  fixtureSequence,
  fixtureShots,
  fixtureStyle,
} from './scenes-view.fixture';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

// Extend the component props to include shots for story mocking
// Shots are passed through parameters, not args, so make them optional
type ScenesViewStoryProps = React.ComponentProps<typeof ScenesView> & {
  shots?: Shot[];
};

const mockSequence: Sequence = {
  id: 'demo-sequence-123',
  teamId: 'team-1',
  title: 'Demo Sequence',
  script: 'Sample script text for the demo sequence.',
  status: 'completed',
  statusError: null,
  workflowRunId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 'user-1',
  updatedBy: 'user-1',
  styleId: 'style-1',
  aspectRatio: '16:9',
  analysisModel: 'anthropic/claude-haiku-4.5',
  analysisDurationMs: 0,
  imageModel: 'nano_banana',
  videoModel: 'veo3',
  workflow: null,
  musicUrl: null,
  musicPath: null,
  musicStatus: 'pending',
  musicGeneratedAt: null,
  musicError: null,
  musicModel: null,
  musicPrompt: null,
  musicTags: null,
  musicPromptInputHash: null,
  includeMusic: true,
  posterUrl: null,
  autoGenerateMotion: false,
  autoGenerateMusic: false,
  suggestedTalentIds: null,
  suggestedLocationIds: null,
};

const meta = {
  title: 'Scenes/ScenesView',
  component: ScenesView,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story, context) => {
      // Pull mock data from story parameters (not args, since ScenesView doesn't
      // accept them). `context.parameters` is loosely typed (any), so annotate the
      // locals rather than assert — avoids an unsafe-from-any type assertion.
      const shots: Shot[] = context.parameters.shots ?? [];
      const scenes: SceneWithScript[] = context.parameters.scenes ?? [];
      const style: Style | undefined = context.parameters.style;
      const sequenceId = context.args.sequenceId || 'mock-sequence';
      const sequenceOverrides: Partial<Sequence> =
        context.parameters.sequenceOverrides ?? {};
      // A story can supply a whole sequence (real fixture) or just overrides on
      // the synthetic mock.
      const sequence: Sequence = context.parameters.sequence ?? {
        ...mockSequence,
        id: sequenceId,
        ...sequenceOverrides,
      };

      // Create a query client with mock data
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
          },
        },
      });

      // Pre-populate the cache with mock data using the correct query keys.
      // Scenes group the shots (they carry no model of their own, #1066); the
      // model the image/motion tabs show is resolved per shot from its selected
      // image/video version.
      queryClient.setQueryData(['shots', 'list', sequenceId], shots);
      queryClient.setQueryData(['scenes', 'list', sequenceId], scenes);
      queryClient.setQueryData(['sequences', 'detail', sequenceId], sequence);
      // The per-shot resolved models the tab selectors read (#1066). Seeded
      // empty: this fixture has no version rows, so every shot falls back to
      // the sequence default — the same answer the live editor gives for a
      // shot that has never generated. Without the key the query would never
      // settle and the story couldn't exercise resolution at all.
      queryClient.setQueryData(['sequence-selected-models', sequenceId], {
        imageModelByShot: {},
        videoModelByShot: {},
        failedImageModelByShot: {},
        failedVideoModelByShot: {},
      });
      if (style) {
        queryClient.setQueryData(['styles', 'detail', style.id], style);
      }

      // Provide a minimal TanStack Router context for useNavigate()
      const rootRoute = createRootRoute({
        component: () => <Story />,
      });
      const router = createRouter({
        routeTree: rootRoute,
        history: createMemoryHistory({ initialEntries: ['/'] }),
      });

      return (
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      );
    },
  ],
} satisfies Meta<ScenesViewStoryProps>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Real sequence (MAKEUP AD, 9:16) captured from local D1, so the editor renders
 * exactly as it does live: a flat shot list with the image/motion tab selectors
 * resolving each shot's per-asset look/motion models. Media URLs are swapped for public
 * placeholders (stored R2 paths are origin-relative and don't resolve from the
 * Storybook origin). Regenerate via scratchpad/gen-fixture.mjs.
 */
export const RealSequence: Story = {
  args: {
    sequenceId: fixtureSequence.id,
    search: {},
  },
  parameters: {
    sequence: fixtureSequence,
    // The fixture rows are `SceneRow`s; the editor reads the SELECTED script,
    // which for this snapshot is the split-time one.
    scenes: fixtureScenes.map((scene) => ({
      ...scene,
      script: scene.originalScript,
    })),
    shots: fixtureShots,
    style: fixtureStyle,
    docs: {
      description: {
        story:
          'A real, fully-generated sequence pulled from the local database — the closest match to the live editor (flat shot list + per-asset model selectors in the image/motion tabs).',
      },
    },
  },
};

/**
 * A shot's number, title and script come from its scene (#1067), so each mock
 * shot points at one of these by `sceneId: 'scene-<n>'`.
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

// Mock shot base — all Shot fields included
const mockShotBase = {
  sequenceId: 'seq-1',
  sceneId: null,
  shotNumber: null,
  orderIndex: 0,
  durationMs: 5000,
  thumbnailWorkflowRunId: null,
  thumbnailGeneratedAt: null,
  thumbnailError: null,
  imageModel: 'nano_banana',
  imagePrompt: null,
  videoWorkflowRunId: null,
  videoGeneratedAt: null,
  videoError: null,
  motionPrompt: null,
  motionModel: 'veo3',
  variantImageUrl: null,
  variantImageStatus: 'pending' as const,
  variantWorkflowRunId: null,
  variantImageGeneratedAt: null,
  variantImageError: null,
  previewThumbnailUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export const MixedStates: Story = {
  args: {
    sequenceId: 'demo-sequence-123',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/scene1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        sceneId: 'scene-1',
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/scene2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/2/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        sceneId: 'scene-2',
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/scene3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        sceneId: 'scene-3',
      },
      {
        ...mockShotBase,
        id: '4',
        orderIndex: 3,
        thumbnailUrl: 'https://picsum.photos/seed/scene4/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/4/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'generating',
        sceneId: 'scene-4',
      },
      {
        ...mockShotBase,
        id: '5',
        orderIndex: 4,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        sceneId: 'scene-5',
      },
    ],
    scenes: [
      mockScene(0, 'Opening Scene'),
      mockScene(1, 'The Journey'),
      mockScene(2, 'Climax'),
      mockScene(3, 'Resolution'),
      mockScene(4, 'Epilogue'),
    ],
    docs: {
      description: {
        story:
          'Full scenes page with mixed states. Scenes 1-2 have completed videos and play normally. Scene 3 shows "Generating video..." overlay. Scene 4 is generating video. Scene 5 is still generating its shot (appears in list but not player).',
      },
    },
  },
};

export const AllCompleted: Story = {
  args: {
    sequenceId: 'all-completed',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/complete1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        sceneId: 'scene-1',
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/complete2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/2/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        sceneId: 'scene-2',
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/complete3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/3/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        sceneId: 'scene-3',
      },
    ],
    scenes: [
      mockScene(0, 'Scene 1'),
      mockScene(1, 'Scene 2'),
      mockScene(2, 'Scene 3'),
    ],
    docs: {
      description: {
        story:
          'All scenes have completed videos. Demonstrates sequential playback of multiple videos. Videos will auto-advance from one to the next.',
      },
    },
  },
};

export const AllPending: Story = {
  args: {
    sequenceId: 'all-pending',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/pending1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        sceneId: 'scene-1',
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/pending2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        sceneId: 'scene-2',
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/pending3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        sceneId: 'scene-3',
      },
    ],
    scenes: [
      mockScene(0, 'Waiting for Video 1'),
      mockScene(1, 'Waiting for Video 2'),
      mockScene(2, 'Waiting for Video 3'),
    ],
    docs: {
      description: {
        story:
          'All scenes have thumbnails but are waiting for video generation. Player shows pending overlay on each scene.',
      },
    },
  },
};

export const ShotsGenerating: Story = {
  args: {
    sequenceId: 'shots-generating',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/shotgen1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        sceneId: 'scene-1',
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/shotgen2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        sceneId: 'scene-2',
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        sceneId: 'scene-3',
      },
      {
        ...mockShotBase,
        id: '4',
        orderIndex: 3,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'pending',
        videoStatus: 'pending',
        sceneId: 'scene-4',
      },
    ],
    scenes: [
      mockScene(0, 'Scene 1 - Ready'),
      mockScene(1, 'Scene 2 - Shot Ready'),
      mockScene(2, 'Scene 3 - Generating Shot'),
      mockScene(3, 'Scene 4 - Shot Pending'),
    ],
    docs: {
      description: {
        story:
          'Shows shots at different stages of generation. Scene 1 is complete and playable. Scene 2 has shot ready, shows "Generating video..." in player. Scenes 3-4 are generating/pending shots (visible in list with skeleton, not in player).',
      },
    },
  },
};

export const GenerationInProgress: Story = {
  args: {
    sequenceId: 'generating',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/gen1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'generating',
        sceneId: 'scene-1',
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        sceneId: 'scene-2',
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'pending',
        videoStatus: 'pending',
        sceneId: 'scene-3',
      },
    ],
    scenes: [
      mockScene(0, 'Video Generating'),
      mockScene(1, 'Shot Generating'),
      mockScene(2, 'Shot Pending'),
    ],
    docs: {
      description: {
        story:
          'Multiple scenes in generation. Scene 1 shows "Generating video..." in player. Scenes 2-3 are generating/pending shots (visible in list only, not player).',
      },
    },
  },
};

export const PreviewMode: Story = {
  args: {
    sequenceId: 'preview-mode',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: null,
        thumbnailPath: null,
        previewThumbnailUrl: 'https://picsum.photos/seed/preview1/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        sceneId: 'scene-1',
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: null,
        thumbnailPath: null,
        previewThumbnailUrl: 'https://picsum.photos/seed/preview2/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        sceneId: 'scene-2',
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/final3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        previewThumbnailUrl: 'https://picsum.photos/seed/preview3/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        sceneId: 'scene-3',
      },
    ],
    scenes: [
      mockScene(0, 'Preview - Generating Full Image'),
      mockScene(1, 'Preview - Still Processing'),
      mockScene(2, 'Final Image Ready'),
    ],
    docs: {
      description: {
        story:
          'Shows preview mode where fast preview images are displayed while full-resolution thumbnails are still generating. Scenes 1-2 show the "Preview" badge, Scene 3 has its final image ready (no badge).',
      },
    },
  },
};

export const PreviewModePortrait: Story = {
  args: {
    sequenceId: 'preview-mode-portrait',
  },
  parameters: {
    sequenceOverrides: { aspectRatio: '9:16' },
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: null,
        thumbnailPath: null,
        previewThumbnailUrl: 'https://picsum.photos/seed/preview1p/720/1280',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        sceneId: 'scene-1',
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: null,
        thumbnailPath: null,
        previewThumbnailUrl: 'https://picsum.photos/seed/preview2p/720/1280',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        sceneId: 'scene-2',
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/final3p/720/1280',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        previewThumbnailUrl: 'https://picsum.photos/seed/preview3p/720/1280',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        sceneId: 'scene-3',
      },
    ],
    scenes: [
      mockScene(0, 'Preview - Generating Full Image'),
      mockScene(1, 'Preview - Still Processing'),
      mockScene(2, 'Final Image Ready'),
    ],
    docs: {
      description: {
        story:
          'Portrait (9:16) preview mode. Shows preview badge and subtext on tall aspect ratio shots.',
      },
    },
  },
};

export const WithFailures: Story = {
  args: {
    sequenceId: 'with-failures',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/fail1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        sceneId: 'scene-1',
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/fail2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'failed',
        sceneId: 'scene-2',
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/fail3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        sceneId: 'scene-3',
      },
    ],
    scenes: [
      mockScene(0, 'Successful Scene'),
      mockScene(1, 'Failed Generation'),
      mockScene(2, 'Pending Scene'),
    ],
    docs: {
      description: {
        story:
          'Demonstrates error handling. Scene 1 plays normally, Scene 2 shows failed state with error icon, Scene 3 is pending.',
      },
    },
  },
};

export const EmptySequence: Story = {
  args: {
    sequenceId: 'empty-sequence',
  },
  parameters: {
    shots: [],
    docs: {
      description: {
        story:
          'Empty sequence with no shots. Shows how the page handles sequences without any scenes.',
      },
    },
  },
};
