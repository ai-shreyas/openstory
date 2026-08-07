import { z } from 'zod';

// ============================================================================
// Strict structured-output note
// ============================================================================
//
// These schemas are sent to the LLM as native structured-output JSON Schemas
// (`outputSchema` on `chat()`), which the provider compiles into a strict
// grammar that GUARANTEES conformance. Anthropic caps that grammar at 16
// union-typed parameters per request, and `convertSchemaToJsonSchema` compiles
// every `.catch(default)` / `.optional()` field into a `["T","null"]` union —
// so defensive `.catch()` defaults (which previously absorbed lenient
// `json_object` output) would silently blow the union budget and force the old
// fallback path. With strict output the model is REQUIRED to emit every field,
// so `.catch()` is both unnecessary and harmful here: keep these schemas free
// of `.catch()` and prefer required-but-emptyable fields ('' / [] / false) over
// `.optional()`.
//
// Resilience for streaming partial-scene parsing lives in
// `streaming-scene-parser.ts` (its own lenient schema), and frame.metadata is
// stored as a `$type<Scene>()` cast (never re-parsed on read), so dropping
// `.catch()` here does not weaken any DB-read path.

// ============================================================================
// Character Bible Schemas
// ============================================================================

export const characterBibleEntrySchema = z.object({
  characterId: z.string().meta({
    description:
      'Unique identifier for cross-referencing this character across scenes',
  }),
  name: z
    .string()
    .meta({ description: 'Full character name as written in the script' }),
  age: z.string().meta({
    description: 'Age as number (e.g., 35) or range (e.g., "30s", "early 40s")',
  }),
  gender: z
    .string()
    .meta({ description: 'Character gender for casting consistency' }),
  ethnicity: z.string().meta({
    description: 'Character ethnicity for accurate visual representation',
  }),
  physicalDescription: z.string().meta({
    description:
      'Detailed appearance: height, build, hair color, eye color, distinguishing features',
  }),
  standardClothing: z.string().meta({
    description:
      'Default outfit and clothing style for visual consistency across scenes',
  }),
  distinguishingFeatures: z.string().meta({
    description:
      'Unique visual markers: scars, tattoos, accessories, distinctive mannerisms',
  }),
  consistencyTag: z.string().meta({
    description:
      'Short prompt tag for image generation (e.g., "detective_sarah_blonde_30s")',
  }),
});

// ============================================================================
// Element Bible Schemas (user-uploaded reference images + detected recurring
// products/objects that get an auto-generated reference image)
// ============================================================================

export const elementBibleEntrySchema = z.object({
  token: z.string().meta({
    description:
      'Uppercase token used in the script to reference this element (e.g. "LOGO", "BOTTLE")',
  }),
  description: z.string().meta({
    description:
      'Concise visual description of the element for prompt guidance',
  }),
  consistencyTag: z.string().meta({
    description: 'Short slug tag for image generation (e.g. "red-hex-logo")',
  }),
  firstMention: z
    .object({
      sceneId: z.string(),
      text: z.string(),
      lineNumber: z.number(),
    })
    .meta({ description: 'First appearance of this element in the script' }),
});

// ============================================================================
// Location Bible Schemas
// ============================================================================

export const locationBibleEntrySchema = z.object({
  locationId: z.string().meta({
    description:
      'Unique identifier for cross-referencing this location across scenes',
  }),
  name: z.string().meta({
    description:
      'Location name as written in the script (e.g., "INT. OFFICE - DAY")',
  }),
  type: z.enum(['interior', 'exterior', 'both']).meta({
    description: 'Whether the location is interior, exterior, or both',
  }),
  timeOfDay: z.string().meta({
    description: 'Default time of day: day, night, dusk, dawn, etc.',
  }),
  description: z.string().meta({
    description:
      'Detailed visual description of the location including layout, size, and atmosphere',
  }),
  architecturalStyle: z.string().meta({
    description:
      'Architectural or design style (e.g., "modern minimalist", "industrial loft", "Victorian")',
  }),
  keyFeatures: z.string().meta({
    description:
      'Notable visual elements that define this location (e.g., "large windows, exposed brick, vintage furniture")',
  }),
  colorPalette: z.string().meta({
    description:
      'Dominant colors and color scheme (e.g., "cool blues, steel grays, warm wood accents")',
  }),
  lightingSetup: z.string().meta({
    description:
      'Primary lighting characteristics (e.g., "harsh overhead fluorescent", "warm golden hour sunlight")',
  }),
  ambiance: z.string().meta({
    description:
      'Mood and atmosphere of the location (e.g., "tense corporate", "cozy intimate", "gritty urban")',
  }),
  consistencyTag: z.string().meta({
    description:
      'Short prompt tag for image generation (e.g., "office_modern_steel_glass")',
  }),
  firstMention: z
    .object({
      sceneId: z
        .string()
        .meta({ description: 'Scene ID where location first appears' }),
      text: z
        .string()
        .meta({ description: 'Original script text mentioning the location' }),
      lineNumber: z.number().meta({ description: 'Line number in script' }),
    })
    .meta({ description: 'First appearance of this location in the script' }),
});

// ============================================================================
// Project Metadata Schema
// ============================================================================

export const projectMetadataSchema = z.object({
  title: z
    .string()
    .meta({ description: 'Project title extracted from the script' }),
  aspectRatio: z
    .string()
    .meta({ description: 'Video aspect ratio (e.g., "16:9", "9:16", "1:1")' }),
  generatedAt: z
    .string()
    .meta({ description: 'ISO 8601 timestamp of generation' }),
});

// ============================================================================
// Prompt Schemas
// ============================================================================

const visualPromptComponentsSchema = z.object({
  sceneDescription: z
    .string()
    .meta({ description: 'Overall scene action and composition description' }),
  subject: z.string().meta({ description: 'Main subject or character focus' }),
  environment: z
    .string()
    .meta({ description: 'Setting, location, and background details' }),
  lighting: z
    .string()
    .meta({ description: 'Light sources, quality, direction, and mood' }),
  camera: z
    .string()
    .meta({ description: 'Camera angle, lens choice, and framing' }),
  composition: z
    .string()
    .meta({ description: 'Visual arrangement and focal points' }),
  style: z
    .string()
    .meta({ description: 'Artistic style and visual treatment' }),
  technical: z.string().meta({
    description: 'Technical parameters: resolution, quality settings',
  }),
  atmosphere: z
    .string()
    .meta({ description: 'Mood, emotion, and ambient feeling' }),
});

const visualPromptSchema = z.object({
  fullPrompt: z.string().meta({
    description: 'Complete image generation prompt with all visual details',
  }),
  negativePrompt: z
    .string()
    .meta({ description: 'Elements to avoid in the generated image' }),
  components: visualPromptComponentsSchema.meta({
    description: 'Structured breakdown of the visual prompt components',
  }),
});

const motionPromptComponentsSchema = z.object({
  cameraMovement: z.string().meta({
    description:
      'The single primary camera motion for this shot (pan, tilt, dolly, truck, zoom) — exactly one move, never stacked',
  }),
  startPosition: z
    .string()
    .meta({ description: 'Camera starting position and framing' }),
  endPosition: z
    .string()
    .meta({ description: 'Camera ending position and framing' }),
  durationSeconds: z
    .number()
    .meta({ description: 'Shot duration in seconds (typically 3-15)' }),
  speed: z.string().meta({
    description:
      'Movement speed: slow, medium, or brisk — never "fast" (it triggers chaotic motion in video models)',
  }),
  smoothness: z.string().meta({
    description: 'Motion quality: jerky, natural, smooth, ultra-smooth',
  }),
  subjectTracking: z
    .string()
    .meta({ description: 'How camera follows subject movement' }),
  equipment: z.string().meta({
    description: 'Suggested equipment: handheld, gimbal, dolly, crane',
  }),
});

const motionPromptParametersSchema = z.object({
  durationSeconds: z
    .number()
    .meta({ description: 'Override duration in seconds' }),
  fps: z.number().meta({ description: 'Frames per second (24, 30, 60)' }),
  motionAmount: z
    .enum(['low', 'medium', 'high'])
    .meta({ description: 'Amount of motion: low, medium, high' }),
  cameraControl: z
    .object({
      pan: z.number().meta({ description: 'Horizontal rotation in degrees' }),
      tilt: z.number().meta({ description: 'Vertical rotation in degrees' }),
      zoom: z.number().meta({ description: 'Zoom factor (1.0 = no zoom)' }),
      movement: z
        .string()
        .meta({ description: 'Direction of camera movement' }),
    })
    .meta({ description: 'Precise camera control parameters' }),
});

export const dialogueLineSchema = z.object({
  character: z.string().meta({
    description: 'Character name speaking the line, or empty for narrator',
  }),
  line: z.string().meta({ description: 'The spoken dialogue text' }),
  tone: z.string().meta({
    description:
      'Voice tone and emotion for delivery (e.g., "calm serious", "trembling frustrated", "whispered urgent")',
  }),
});

const dialogueSchema = z.object({
  presence: z
    .boolean()
    .meta({ description: 'Whether dialogue is present in scene' }),
  lines: z
    .array(dialogueLineSchema)
    .meta({ description: 'Array of dialogue lines in the scene' }),
});

const motionAudioSchema = z.object({
  ambientSound: z.string().meta({
    description:
      'Background ambient sound (e.g., "quiet office hum", "rain against windows", "bustling street")',
  }),
  soundEffects: z.array(z.string()).meta({
    description:
      'Specific sound effects timed to actions (e.g., "door slam", "glass clinking", "footsteps on gravel")',
  }),
});

export const motionPromptSchema = z.object({
  fullPrompt: z.string().meta({
    description:
      'Complete motion prompt describing camera movement, action, and dialogue performance',
  }),
  components: motionPromptComponentsSchema.meta({
    description: 'Structured breakdown of motion prompt components',
  }),
  parameters: motionPromptParametersSchema.meta({
    description: 'Technical parameters for motion generation',
  }),
  // `.nullish()` (optional + nullable), not `.optional()`: under native strict
  // output the converter marks every property required and represents an
  // optional as `["T","null"]`, so the model emits `null` when there is no
  // dialogue/audio — `.nullish()` parses that cleanly while still letting
  // fixtures omit the field. Costs one union-typed param each (well under 16).
  dialogue: dialogueSchema.nullish().meta({
    description:
      'Dialogue lines from the scene to inform audio/motion models (null when none)',
  }),
  audio: motionAudioSchema.nullish().meta({
    description:
      'Audio direction for models that generate sound alongside video (null when none)',
  }),
});

// ============================================================================
// Music Design Schema (replaces audioDesign for new shots)
// ============================================================================

export const musicDesignSchema = z.object({
  presence: z.enum(['none', 'minimal', 'moderate', 'full']).meta({
    description:
      'How prominent the music should be: none, minimal, moderate, full',
  }),
  style: z.string().meta({
    description:
      'Music genre or style (e.g., "orchestral", "electronic ambient")',
  }),
  mood: z.string().meta({
    description: 'Emotional quality of the music (e.g., "tense", "uplifting")',
  }),
  atmosphere: z.string().meta({
    description: 'Environmental atmosphere (e.g., "busy city street")',
  }),
});

// ============================================================================
// Audio Design Schemas (deprecated — kept for backward compat with old shots)
// ============================================================================

const musicSchema = z.object({
  presence: z.enum(['none', 'minimal', 'moderate', 'full']).meta({
    description:
      'How prominent the music should be: none, minimal, moderate, full',
  }),
  style: z.string().meta({
    description:
      'Music genre or style (e.g., "orchestral", "electronic ambient")',
  }),
  mood: z.string().meta({
    description: 'Emotional quality of the music (e.g., "tense", "uplifting")',
  }),
  rationale: z
    .string()
    .meta({ description: 'Explanation for the music choices' }),
});

const soundEffectSchema = z.object({
  sfxId: z
    .string()
    .meta({ description: 'Unique identifier for this sound effect' }),
  type: z.string().meta({
    description: 'Sound effect category (e.g., "ambient", "foley", "impact")',
  }),
  description: z.string().meta({
    description: 'Description of the sound (e.g., "distant thunder rumble")',
  }),
  timing: z.string().meta({
    description: 'When the sound plays (e.g., "scene start", "on action")',
  }),
  volume: z
    .enum(['low', 'medium', 'high'])
    .meta({ description: 'Relative volume level: low, medium, high' }),
  spatialPosition: z
    .string()
    .meta({ description: 'Audio positioning: left, center, right, surround' }),
});

const ambientSchema = z.object({
  roomTone: z.string().meta({
    description: 'Background room ambience (e.g., "quiet office hum")',
  }),
  atmosphere: z.string().meta({
    description: 'Environmental atmosphere (e.g., "busy city street")',
  }),
});

const audioDesignSchema = z.object({
  music: musicSchema.meta({ description: 'Background music specifications' }),
  soundEffects: z
    .array(soundEffectSchema)
    .meta({ description: 'Array of sound effects for the scene' }),
  dialogue: dialogueSchema.meta({
    description: 'Dialogue and speech specifications',
  }),
  ambient: ambientSchema.meta({ description: 'Ambient sound design' }),
});

// ============================================================================
// Continuity Schema
// ============================================================================

export const continuitySchema = z.object({
  characterTags: z.array(z.string()).meta({
    description:
      "Snake_case slug of each character's name as written in the script (e.g., 'GIRL ONE' → 'girl_one'). Optional descriptive context may be appended after the name slug (e.g., 'girl_one_bathroom_morning'). One entry per character appearing in the scene.",
  }),
  environmentTag: z
    .string()
    .meta({ description: 'Location/setting tag for environment consistency' }),
  // `.nullish()` (not `.optional()`) so native strict output can emit `null`
  // when no elements are referenced; see the matching note on motion
  // dialogue/audio. Consumers already read this as `?.elementTags ?? []`.
  elementTags: z.array(z.string()).nullish().meta({
    description:
      'UPPERCASE tokens for user-uploaded elements referenced in this scene (null when none)',
  }),
  colorPalette: z
    .string()
    .meta({ description: 'Dominant colors for visual continuity' }),
  lightingSetup: z.string().meta({
    description: 'Lighting configuration for consistency across shots',
  }),
  styleTag: z
    .string()
    .meta({ description: 'Visual style reference for consistent look' }),
});

/**
 * Visual prompt generation response. Scene `continuity` (membership) is produced
 * upstream by scene-split, so the visual-prompt LLM only authors the image
 * prompt and no longer emits continuity. See #867.
 */
export const visualPromptResultSchema = z.object({
  visual: visualPromptSchema.meta({
    description: 'Image generation prompt data',
  }),
});
export type VisualPromptResult = z.infer<typeof visualPromptResultSchema>;

// ============================================================================
// Original Script Schema
// ============================================================================

export const originalScriptSchema = z.object({
  extract: z
    .string()
    .meta({ description: 'Original script text for this scene' }),
  dialogue: z
    .array(dialogueLineSchema)
    .meta({ description: 'Dialogue lines extracted from the script' }),
});

// ============================================================================
// Scene Metadata Schema
// ============================================================================

export const sceneMetadataSchema = z.object({
  title: z.string().meta({ description: 'Short descriptive scene title' }),
  durationSeconds: z.number().meta({
    description: 'Estimated scene duration in seconds (typically 3-15)',
  }),
  location: z
    .string()
    .meta({ description: 'Scene location (e.g., "INT. OFFICE - DAY")' }),
  timeOfDay: z
    .string()
    .meta({ description: 'Time of day: day, night, dawn, dusk, etc.' }),
  storyBeat: z
    .string()
    .meta({ description: 'Narrative purpose of this scene in the story' }),
});

// ============================================================================
// Scene Schema
// ============================================================================

export const sceneSchema = z.object({
  sceneId: z
    .string()
    .meta({ description: 'Unique identifier for this scene (required)' }),
  sceneNumber: z
    .number()
    .meta({ description: 'Scene order number starting from 1 (required)' }),
  originalScript: originalScriptSchema.meta({
    description: 'Original script content for this scene',
  }),
  metadata: sceneMetadataSchema
    .optional()
    .meta({ description: 'Scene metadata and context' }),
  // `prompts` removed (#713): visual prompts live in `frame_prompt_versions`
  // (mirrored on `frame.imagePrompt`) and motion prompts in
  // `shot_prompt_versions` (mirrored on `shot.motionPrompt` + dialogue/audio
  // columns). The Scene metadata no longer carries generated prompts.
  musicDesign: musicDesignSchema
    .optional()
    .meta({ description: 'Music classification for this scene (new shots)' }),
  /** @deprecated Kept for backward compat with old shots — use musicDesign */
  audioDesign: audioDesignSchema
    .optional()
    .meta({ description: 'Audio and sound design specs (deprecated)' }),
  continuity: continuitySchema
    .optional()
    .meta({ description: 'Continuity tracking for scene consistency' }),
  sourceImageUrl: z
    .string()
    .optional()
    .meta({ description: 'URL of generated or uploaded source image' }),
});

// ============================================================================
// Top-Level Scene Analysis Schema
// ============================================================================

export const sceneAnalysisSchema = z.object({
  status: z
    .enum(['success', 'error', 'rejected'])
    .meta({ description: 'Processing status: success, error, or rejected' }),
  projectMetadata: projectMetadataSchema.meta({
    description: 'Project-level metadata extracted from script',
  }),
  characterBible: z
    .array(characterBibleEntrySchema)
    .meta({ description: 'Character descriptions for visual consistency' }),
  locationBible: z
    .array(locationBibleEntrySchema)
    .meta({ description: 'Location descriptions for visual consistency' }),
  elementBible: z.array(elementBibleEntrySchema).optional().meta({
    description:
      'Element descriptions (logos, products, recurring objects) with UPPERCASE script tokens — user-uploaded or detected recurring products',
  }),
  scenes: z
    .array(sceneSchema)
    .meta({ description: 'Array of analyzed scenes from the script' }),
});

// ============================================================================
// TypeScript Type Export
// ============================================================================

export type SceneAnalysis = z.infer<typeof sceneAnalysisSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type CharacterBibleEntry = z.infer<typeof characterBibleEntrySchema>;
export type LocationBibleEntry = z.infer<typeof locationBibleEntrySchema>;
export type ElementBibleEntry = z.infer<typeof elementBibleEntrySchema>;
export type VisualPrompt = z.infer<typeof visualPromptSchema>;
export type VisualPromptComponents = z.infer<
  typeof visualPromptComponentsSchema
>;
export type MotionPrompt = z.infer<typeof motionPromptSchema>;
export type MotionDialogue = NonNullable<MotionPrompt['dialogue']>;
export type MotionAudio = NonNullable<MotionPrompt['audio']>;
/**
 * The fields model-specific assembly (`assembleMotionPrompt`) actually consumes:
 * the narrative base plus the dialogue/audio direction appended for audio-capable
 * video models. This is what a `shot_prompt_versions` motion row reconstructs to
 * at resolution time (#713) — `components`/`parameters` are stored for history
 * but are not part of the rendered prompt.
 */
export type AssemblableMotionPrompt = Pick<
  MotionPrompt,
  'fullPrompt' | 'dialogue' | 'audio'
>;
export type MotionPromptComponents = z.infer<
  typeof motionPromptComponentsSchema
>;
export type MotionPromptParameters = z.infer<
  typeof motionPromptParametersSchema
>;
export type DialogueLine = z.infer<typeof dialogueLineSchema>;
export type Continuity = z.infer<typeof continuitySchema>;
