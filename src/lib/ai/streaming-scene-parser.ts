/**
 * Streaming boundary-scene parser (#1035).
 *
 * Incrementally consumes the scenes-call output — `{ projectMetadata,
 * boundaries[], sceneMeta[] }` — from a partial JSON stream. The LLM never
 * authors script text: as soon as boundary k+1 has fully streamed, scene k's
 * text is a local verbatim slice of the ORIGINAL script (see
 * `boundary-split.ts`), so scene cards appear with real script text while the
 * (much longer) `sceneMeta` tail is still streaming. Metadata arriving later
 * upgrades already-emitted scenes via `scene:updated` — at most one per scene,
 * and only if meta arrived after the initial `'scene'` emit. If meta rode in
 * the `'scene'` event, no upgrade is sent.
 *
 * Scene ids/numbers are minted here (server-side), never by the LLM.
 */

import { parsePartialJSON } from '@tanstack/ai';
import { z } from 'zod';
import {
  type BoundaryAnnotation,
  repairDialogueLines,
  resolveBoundaries,
  sliceScenes,
} from './boundary-split';
import { sceneBoundarySchema, sceneMetaEntrySchema } from './response-schemas';
import type {
  Continuity,
  DialogueLine,
  SceneMetadata,
} from './scene-analysis.schema';

/**
 * The per-scene shape the scene-split workflow persists and emits mid-stream.
 * Matches the slice of `Scene` that `buildSceneInsert` + eventing consume,
 * with every field required (placeholder-filled until `sceneMeta` streams in).
 */
export type SceneSplittingScene = {
  sceneId: string;
  sceneNumber: number;
  originalScript: { extract: string; dialogue: DialogueLine[] };
  metadata: SceneMetadata;
  continuity: Continuity;
};

export type StreamedSceneEvent =
  | { type: 'title'; title: string }
  | { type: 'scene'; scene: SceneSplittingScene; index: number }
  | { type: 'scene:updated'; scene: SceneSplittingScene; index: number };

/**
 * Strip markdown code fences that some models wrap around JSON output.
 * Handles ```json, ```, and leading/trailing whitespace.
 */
export function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

type SceneMetaEntry = z.infer<typeof sceneMetaEntrySchema>;

function placeholderMetadata(sceneNumber: number): SceneMetadata {
  return {
    title: `Scene ${sceneNumber}`,
    durationSeconds: 3,
    location: '',
    timeOfDay: '',
    storyBeat: '',
  };
}

const EMPTY_CONTINUITY: Continuity = {
  characterTags: [],
  environmentTag: '',
  elementTags: null,
  colorPalette: '',
  lightingSetup: '',
  styleTag: '',
};

/** Assemble the emitted scene object from a verbatim slice + optional meta. */
function buildScene(
  sceneId: string,
  index: number,
  slice: string,
  meta: SceneMetaEntry | undefined
): SceneSplittingScene {
  return {
    sceneId,
    sceneNumber: index + 1,
    originalScript: {
      extract: slice,
      dialogue: meta ? repairDialogueLines(slice, meta.dialogue) : [],
    },
    metadata: meta
      ? {
          title: meta.title,
          durationSeconds: meta.durationSeconds,
          location: meta.location,
          timeOfDay: meta.timeOfDay,
          storyBeat: meta.storyBeat,
        }
      : placeholderMetadata(index + 1),
    continuity: meta ? meta.continuity : EMPTY_CONTINUITY,
  };
}

/**
 * Assemble the final scene array from a complete scenes-call result: resolve
 * boundaries, slice the script, and attach index-aligned metadata. Pure — the
 * workflow uses it for the post-stream (and retry/fallback) build, with
 * `sceneIdFor` reusing ids the streaming parser already minted so mid-stream
 * rows and the final result agree.
 */
export function assembleScenes(
  script: string,
  result: {
    boundaries: BoundaryAnnotation[];
    sceneMeta: SceneMetaEntry[];
  },
  sceneIdFor: (index: number) => string
): {
  scenes: SceneSplittingScene[];
  resolution: ReturnType<typeof resolveBoundaries>;
  slices: string[];
} {
  const resolution = resolveBoundaries(script, result.boundaries);
  const slices = sliceScenes(script, resolution.offsets);
  const scenes = slices.map((slice, i) => {
    const boundaryIndex = resolution.kept[i];
    const meta =
      boundaryIndex === undefined ? undefined : result.sceneMeta[boundaryIndex];
    return buildScene(sceneIdFor(i), i, slice, meta);
  });
  return { scenes, resolution, slices };
}

/**
 * Create a parser bound to the raw script. `mintSceneId` is called once per
 * scene index (inject `generateId` in production, a counter in tests).
 *
 * Boundary resolution is a pure function of (script, boundary prefix) with a
 * monotonic cursor, so incremental resolution mid-stream and the workflow's
 * final full-payload resolution agree on every prefix.
 */
export function createStreamingSceneParser(
  script: string,
  mintSceneId: () => string
) {
  let titleEmitted = false;
  let emittedScenes = 0;
  /** Scene indices whose settled meta has been emitted (in 'scene' or 'scene:updated'). */
  const metaEmitted = new Set<number>();
  const sceneIds = new Map<number, string>();

  const idFor = (index: number): string => {
    const existing = sceneIds.get(index);
    if (existing !== undefined) return existing;
    const id = mintSceneId();
    sceneIds.set(index, id);
    return id;
  };

  return {
    /**
     * Feed the full accumulated LLM text; returns events new since last feed.
     * Pass `done: true` on the final feed so the last scene (whose end is the
     * script end) and trailing sceneMeta upgrades are emitted.
     */
    feed(accumulated: string, done = false): StreamedSceneEvent[] {
      const events: StreamedSceneEvent[] = [];

      const raw = parsePartialJSON(stripCodeFences(accumulated));
      if (!isRecord(raw)) return events;

      if (!titleEmitted) {
        const pm = raw.projectMetadata;
        if (
          isRecord(pm) &&
          typeof pm.title === 'string' &&
          pm.title.length > 0
        ) {
          titleEmitted = true;
          events.push({ type: 'title', title: pm.title });
        }
      }

      // A partially-streamed trailing array entry parses as a truncated
      // object (parsePartialJSON completes a mid-string quote with partial
      // content), so an entry has settled only once something follows it: a
      // later entry, the next top-level key, or the stream's end.
      const settledPrefix = <T>(
        value: unknown,
        schema: z.ZodType<T>,
        closed: boolean
      ): T[] => {
        if (!Array.isArray(value)) return [];
        const settled = closed ? value.length : value.length - 1;
        const out: T[] = [];
        for (let i = 0; i < settled; i++) {
          const parsed = schema.safeParse(value[i]);
          if (!parsed.success) break;
          out.push(parsed.data);
        }
        return out;
      };

      // `sceneMeta` streams after `boundaries` (schema property order), so
      // its key appearing means the boundaries array closed.
      const boundariesClosed = done || raw.sceneMeta !== undefined;
      const boundaries: BoundaryAnnotation[] = settledPrefix(
        raw.boundaries,
        sceneBoundarySchema,
        boundariesClosed
      );
      const sceneMeta: SceneMetaEntry[] = settledPrefix(
        raw.sceneMeta,
        sceneMetaEntrySchema,
        done
      );

      const resolution = resolveBoundaries(script, boundaries);
      const slices = sliceScenes(script, resolution.offsets);
      // Scene i ends where boundary i+1 begins. Once the boundaries array has
      // closed, every scene's end is known (the last ends at script end).
      const finalized = boundariesClosed
        ? slices.length
        : Math.max(0, slices.length - 1);

      const metaFor = (sceneIndex: number): SceneMetaEntry | undefined => {
        const boundaryIndex = resolution.kept[sceneIndex];
        return boundaryIndex === undefined
          ? undefined
          : sceneMeta[boundaryIndex];
      };

      // Upgrades for already-emitted scenes whose meta has since settled.
      for (let i = 0; i < emittedScenes && i < finalized; i++) {
        const slice = slices[i];
        if (slice === undefined || metaEmitted.has(i)) continue;
        const meta = metaFor(i);
        if (!meta) continue;
        metaEmitted.add(i);
        events.push({
          type: 'scene:updated',
          scene: buildScene(idFor(i), i, slice, meta),
          index: i,
        });
      }

      // Newly finalized scenes.
      for (let i = emittedScenes; i < finalized; i++) {
        const slice = slices[i];
        if (slice === undefined) break;
        const meta = metaFor(i);
        if (meta) metaEmitted.add(i);
        events.push({
          type: 'scene',
          scene: buildScene(idFor(i), i, slice, meta),
          index: i,
        });
        emittedScenes = i + 1;
      }

      return events;
    },

    /** Scene ids minted so far, keyed by scene index. */
    mintedSceneIds(): ReadonlyMap<number, string> {
      return sceneIds;
    },
  };
}
