import { describe, expect, it } from 'vitest';
import {
  createStreamingSceneParser,
  stripCodeFences,
} from './streaming-scene-parser';

const script = [
  'INT. OFFICE - DAY',
  '',
  'Sarah sits at her desk, typing furiously.',
  '',
  'SARAH',
  "I can't believe this is happening.",
  '',
  'EXT. PARKING LOT - NIGHT',
  '',
  'Sarah walks to her car, looking over her shoulder.',
  '',
  'INT. CAR - CONTINUOUS',
  '',
  'She locks the doors and starts the engine.',
].join('\n');

const boundaries = [
  { hintLine: 1, quote: 'INT. OFFICE - DAY' },
  { hintLine: 8, quote: 'EXT. PARKING LOT - NIGHT' },
  { hintLine: 12, quote: 'INT. CAR - CONTINUOUS' },
];

function makeMeta(n: number) {
  return {
    title: `Scene ${n} Title`,
    durationSeconds: 4,
    location: 'INT. SOMEWHERE - DAY',
    timeOfDay: 'day',
    storyBeat: `beat ${n}`,
    continuity: {
      characterTags: ['sarah'],
      environmentTag: 'office_modern',
      elementTags: null,
      colorPalette: 'cool blues',
      lightingSetup: 'fluorescent',
      styleTag: 'neo_noir',
    },
    dialogue:
      n === 1
        ? [
            {
              character: 'SARAH',
              line: "I can't believe this is happening.",
              tone: 'anxious',
            },
          ]
        : [],
  };
}

const fullResponse = {
  projectMetadata: { title: 'Test Film' },
  boundaries,
  sceneMeta: [makeMeta(1), makeMeta(2), makeMeta(3)],
};

function makeParser() {
  let n = 0;
  return createStreamingSceneParser(script, () => `scene-id-${++n}`);
}

describe('createStreamingSceneParser', () => {
  it('emits the title once, as soon as it appears', () => {
    const parser = makeParser();
    const partial = '{"projectMetadata": {"title": "Test Film"}, "bound';
    const events = parser.feed(partial);
    expect(events).toEqual([{ type: 'title', title: 'Test Film' }]);
    // Same text again — no duplicate.
    expect(parser.feed(partial)).toEqual([]);
  });

  it('finalizes scene k when boundary k+1 has settled', () => {
    const parser = makeParser();
    const json = JSON.stringify(fullResponse);
    // Cut mid-way through the third boundary's quote: boundaries 1-2 settled.
    const cut = json.indexOf('INT. CAR') + 4;
    const events = parser.feed(json.slice(0, cut));
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents).toHaveLength(1);
    const [first] = sceneEvents;
    expect(first?.scene.sceneId).toBe('scene-id-1');
    expect(first?.scene.sceneNumber).toBe(1);
    // Verbatim slice: from script start up to (not including) boundary 2.
    expect(first?.scene.originalScript.extract).toBe(
      script.slice(0, script.indexOf('EXT. PARKING LOT'))
    );
    // Meta hasn't streamed yet — placeholder title.
    expect(first?.scene.metadata.title).toBe('Scene 1');
  });

  it('finalizes all scenes once the boundaries array closes (sceneMeta key appears)', () => {
    const parser = makeParser();
    const json = JSON.stringify(fullResponse);
    const cut = json.indexOf('"sceneMeta"') + '"sceneMeta"'.length + 2;
    const events = parser.feed(json.slice(0, cut));
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents).toHaveLength(3);
    const extracts = sceneEvents.map((e) => e.scene.originalScript.extract);
    // Adjacent verbatim slices reassemble the script exactly.
    expect(extracts.join('')).toBe(script);
  });

  it('upgrades an emitted scene via scene:updated when its meta settles, once', () => {
    const parser = makeParser();
    const json = JSON.stringify(fullResponse);
    const boundariesDone =
      json.indexOf('"sceneMeta"') + '"sceneMeta"'.length + 2;
    parser.feed(json.slice(0, boundariesDone));
    // Meta 1 settles when meta 2 appears.
    const metaTwoStart = json.indexOf('"Scene 2 Title"');
    const events = parser.feed(json.slice(0, metaTwoStart));
    const updates = events.filter((e) => e.type === 'scene:updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.index).toBe(0);
    expect(updates[0]?.scene.metadata.title).toBe('Scene 1 Title');
    expect(updates[0]?.scene.metadata.durationSeconds).toBe(4);
    expect(updates[0]?.scene.continuity.characterTags).toEqual(['sarah']);
    // Dialogue verified against the slice.
    expect(updates[0]?.scene.originalScript.dialogue).toEqual([
      {
        character: 'SARAH',
        line: "I can't believe this is happening.",
        tone: 'anxious',
      },
    ]);
    // Feeding more of the same meta does not re-emit.
    expect(
      parser
        .feed(json.slice(0, metaTwoStart + 20))
        .filter((e) => e.type === 'scene:updated')
    ).toEqual([]);
  });

  it('emits the last scene’s meta upgrade on the final done feed', () => {
    const parser = makeParser();
    const json = JSON.stringify(fullResponse);
    const early = parser.feed(json.slice(0, json.indexOf('"Scene 3 Title"')));
    // Metas 1 and 2 had already settled within this single feed, so they ride
    // in the 'scene' events directly — no separate upgrade needed.
    expect(early.filter((e) => e.type === 'scene:updated')).toEqual([]);
    expect(
      early.filter((e) => e.type === 'scene').map((e) => e.scene.metadata.title)
    ).toEqual(['Scene 1 Title', 'Scene 2 Title', 'Scene 3']);
    // Meta 3 settles only at done — nothing streams after it.
    const events = parser.feed(json, true);
    const updates = events.filter((e) => e.type === 'scene:updated');
    expect(updates.map((u) => u.index)).toEqual([2]);
    expect(updates[0]?.scene.metadata.title).toBe('Scene 3 Title');
  });

  it('drops an unresolvable boundary — the scene merges into its predecessor', () => {
    const parser = makeParser();
    const response = {
      ...fullResponse,
      boundaries: [
        boundaries[0],
        { hintLine: 8, quote: 'THIS TEXT EXISTS NOWHERE IN THE SCRIPT' },
        boundaries[2],
      ],
    };
    const events = parser.feed(JSON.stringify(response), true);
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents).toHaveLength(2);
    expect(
      sceneEvents.map((e) => e.scene.originalScript.extract).join('')
    ).toBe(script);
    // Scene 2 (index 1) starts at the third boundary; its meta is the
    // index-aligned third entry.
    expect(sceneEvents[1]?.scene.originalScript.extract).toBe(
      script.slice(script.indexOf('INT. CAR'))
    );
    expect(sceneEvents[1]?.scene.metadata.title).toBe('Scene 3 Title');
  });

  it('anchors quotes tolerantly (smart quotes / whitespace drift)', () => {
    const parser = makeParser();
    const response = {
      ...fullResponse,
      boundaries: [
        boundaries[0],
        // Model normalized the whitespace + dash — still anchors.
        { hintLine: 8, quote: 'EXT. PARKING LOT – NIGHT' },
        boundaries[2],
      ],
    };
    const events = parser.feed(JSON.stringify(response), true);
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents).toHaveLength(3);
    expect(
      sceneEvents.map((e) => e.scene.originalScript.extract).join('')
    ).toBe(script);
  });

  it('handles responses wrapped in code fences', () => {
    const parser = makeParser();
    const fenced = '```json\n' + JSON.stringify(fullResponse) + '\n```';
    const events = parser.feed(fenced, true);
    expect(events.filter((e) => e.type === 'scene')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'title')).toHaveLength(1);
  });

  it('returns no events for non-JSON garbage', () => {
    const parser = makeParser();
    expect(parser.feed('The scenes are as follows:')).toEqual([]);
  });
});

describe('stripCodeFences', () => {
  it('strips ```json fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips bare ``` fences', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('leaves unfenced text alone', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});
