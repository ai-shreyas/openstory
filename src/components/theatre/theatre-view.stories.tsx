import type { Meta, StoryObj } from '@storybook/react';
import { TheatreView } from './theatre-view';
import type { Sequence } from '@/types/database';

const baseSequence: Sequence = {
  id: 'seq_123',
  teamId: 'team_123',
  title: 'My Awesome Sequence',
  script: 'A short film about nature.',
  status: 'completed',
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 'user_123',
  updatedBy: 'user_123',
  styleId: 'style_123',
  styleConfig: null,
  aspectRatio: '16:9',
  analysisModel: 'anthropic/claude-haiku-4.5',
  analysisDurationMs: 5000,
  imageModel: 'nano_banana_pro',
  videoModel: 'kling_v2_5_turbo_pro',
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
  statusError: null,
  workflowRunId: null,
  posterUrl: null,
  autoGenerateMotion: false,
  autoGenerateMusic: false,
  suggestedTalentIds: null,
  suggestedLocationIds: null,
};

const meta: Meta<typeof TheatreView> = {
  title: 'Theatre/TheatreView',
  component: TheatreView,
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof TheatreView>;

// Live-player render requires actual scene MP4s + WebCodecs — not meaningful
// in isolation. The "no scenes" empty state is the one branch worth pinning.
export const NoScenesReady: Story = {
  args: { sequence: baseSequence },
};
