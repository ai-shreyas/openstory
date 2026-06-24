import { getEnv } from '#env';
import { falCostFromUnits } from '@/lib/ai/fal-cost';
import {
  AUDIO_MODELS,
  DEFAULT_MUSIC_MODEL,
  type AudioModel,
  type AudioModelConfig,
} from '@/lib/ai/models';
import { type Microdollars } from '@/lib/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import { generateAudio } from '@tanstack/ai';
import { falAudio } from '@tanstack/ai-fal';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'audio', 'music-generation']);

export type GenerateMusicOptions = {
  scopedDb?: ScopedDb;
  /** Style/mood prompt for the music (e.g., "tense orchestral, dark atmosphere") */
  prompt: string;
  /** Comma-separated genre tags (e.g., "orchestral, ambient, cinematic") */
  tags?: string;
  /** Lyrics with [verse], [chorus], [bridge] structure. Use [inst] for instrumental. */
  lyrics?: string;
  /** Duration in seconds (1-240, default: 60) */
  duration?: number;
  /** Generate instrumental only (default: true) */
  instrumental?: boolean;
  model?: AudioModel;
  /** Number of diffusion steps (default: 27) */
  steps?: number;
};

export type MusicResult = {
  success: boolean;
  audioUrl?: string;
  metadata: {
    model: string;
    provider: string;
    duration: number;
    cost: Microdollars;
    generatedAt: string;
    usedOwnKey: boolean;
  };
  error?: string;
  requestId?: string;
};

function clampDuration(
  requested: number | undefined,
  config: AudioModelConfig
): number {
  if (!requested) return config.capabilities.defaultDuration;
  return Math.min(requested, config.capabilities.maxDuration);
}

type AudioCallShape = {
  prompt: string;
  /**
   * Pass `duration` (seconds) only for models whose API actually accepts a
   * duration field — falAudio maps this to `music_length_ms` for ElevenLabs
   * and to bare `duration` elsewhere. Models without a duration parameter
   * (Lyria 2, Minimax Music v2) must omit this or fal will 422.
   */
  duration?: number;
  modelOptions: Record<string, unknown>;
};

type AudioCallBuilder = (
  options: GenerateMusicOptions,
  config: AudioModelConfig
) => AudioCallShape;

/**
 * Per-model builders that turn `GenerateMusicOptions` into the shape required
 * by `generateAudio`. Builders are the source of truth for which fields each
 * fal endpoint actually accepts. Only models that support a `duration` field
 * are included — fixed-length endpoints have been removed from the registry.
 */
const AUDIO_CALL_BUILDERS: Partial<Record<AudioModel, AudioCallBuilder>> = {
  // fal-ai/ace-step/prompt-to-audio: prompt + duration (seconds) + standard CFG knobs.
  ace_step: (options, config) => ({
    prompt: options.tags ?? options.prompt,
    duration: clampDuration(options.duration, config),
    modelOptions: {
      instrumental: options.instrumental ?? true,
      number_of_steps: options.steps ?? 27,
      scheduler: 'euler',
      guidance_type: 'apg',
    },
  }),

  // fal-ai/ace-step-1.5: prompt + lyrics + duration. No `instrumental` flag —
  // per fal docs, the way to force no vocals is `lyrics: '[Instrumental]'`.
  // Leaving `lyrics` empty/unset lets the built-in LM auto-write vocals.
  ace_step_1_5: (options, config) => {
    const isInstrumental = options.instrumental ?? true;
    const lyrics =
      options.lyrics ?? (isInstrumental ? '[Instrumental]' : undefined);
    return {
      prompt: options.tags ?? options.prompt,
      duration: clampDuration(options.duration, config),
      modelOptions: {
        ...(lyrics !== undefined ? { lyrics } : {}),
        ...(options.steps ? { num_inference_steps: options.steps } : {}),
      },
    };
  },

  // fal-ai/elevenlabs/music: adapter maps `duration` -> `music_length_ms` (ms).
  elevenlabs_music: (options, config) => ({
    prompt: options.prompt,
    duration: clampDuration(options.duration, config),
    modelOptions: {
      force_instrumental: options.instrumental ?? true,
    },
  }),
};

/**
 * Generate music/audio via TanStack AI's `generateAudio` activity using the
 * `falAudio` adapter.
 */
export async function generateMusic(
  options: GenerateMusicOptions
): Promise<MusicResult> {
  const modelKey = options.model || DEFAULT_MUSIC_MODEL;
  const modelConfig = AUDIO_MODELS[modelKey];

  return callFalAudio(options, modelConfig);
}

async function callFalAudio(
  options: GenerateMusicOptions,
  modelConfig: AudioModelConfig
): Promise<MusicResult> {
  const modelKey = options.model || DEFAULT_MUSIC_MODEL;
  const builder = AUDIO_CALL_BUILDERS[modelKey];
  if (!builder) {
    throw new Error(`No audio call builder for model: ${modelKey}`);
  }

  const shape = builder(options, modelConfig);
  // For cost estimation, use the builder's duration (models that accept one)
  // or fall back to the requested/default duration (fixed-length models).
  const billedDuration =
    shape.duration ?? clampDuration(options.duration, modelConfig);

  logger.info(`Generating music with model: ${modelConfig.id}`, {
    provider: modelConfig.provider,
    promptLength: shape.prompt.length,
    duration: shape.duration ?? '(fixed by model)',
  });

  const falApiKeyInfo = options.scopedDb
    ? await options.scopedDb.apiKeys.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };

  const adapter = falAudio(modelConfig.id, { apiKey: falApiKeyInfo.key });
  const result = await generateAudio({
    adapter,
    prompt: shape.prompt,
    duration: shape.duration,
    modelOptions: shape.modelOptions,
    debug: false,
  });

  if (!result.audio.url) {
    logger.error('No audio URL in result:', { result });
    throw new Error('No audio URL returned from music generation');
  }

  // Exact cost from fal's reported billed units.
  const cost = falCostFromUnits(modelConfig.id, result.usage?.unitsBilled);

  return {
    success: true,
    audioUrl: result.audio.url,
    requestId: result.id,
    metadata: {
      model: modelConfig.id,
      provider: modelConfig.provider,
      duration: billedDuration,
      cost,
      generatedAt: new Date().toISOString(),
      usedOwnKey: falApiKeyInfo.source === 'team',
    },
  };
}
