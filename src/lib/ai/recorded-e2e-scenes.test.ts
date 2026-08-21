import { describe, expect, it } from 'vitest';
import { getChatPrompt } from '@/lib/prompts';
import { StyleConfigSchema } from '@/lib/style/style-config';
import { narrowShotPromptContext } from './prompt-context';
import {
  extractTaggedJson,
  loadOpenrouterStage,
  recordedCurrentSceneSchema,
  recordedStyleConfig,
  replayRecordedE2eScenes,
} from './recorded-e2e-scenes';
import type { SceneSplittingScene } from './streaming-scene-parser';

function comparableScene(scene: SceneSplittingScene) {
  return {
    sceneNumber: scene.sceneNumber,
    extract: scene.originalScript.extract,
    dialogue: scene.originalScript.dialogue,
    metadata: scene.metadata,
    continuity: scene.continuity,
  };
}

describe('recorded e2e scene replay', () => {
  it('visual-prompt CURRENT_SCENE JSON matches slice-derived scenes', () => {
    const { scenes } = replayRecordedE2eScenes();
    expect(scenes).toHaveLength(11);

    const fixtures = loadOpenrouterStage('visual-prompts');
    expect(fixtures.length).toBeGreaterThan(0);

    for (const file of fixtures) {
      const userMessage = file.fixtures[0]?.match.userMessage;
      if (!userMessage) throw new Error('visual fixture missing userMessage');
      const recorded = extractTaggedJson(
        userMessage,
        'CURRENT_SCENE',
        recordedCurrentSceneSchema
      );
      const live = scenes[recorded.sceneNumber - 1];
      if (!live) throw new Error(`No live scene ${recorded.sceneNumber}`);
      expect(comparableScene(live)).toEqual(comparableScene(recorded));
    }
  });

  it('visual-prompt user messages match the live getChatPrompt reconstruction', async () => {
    const { scenes, characterBible, locationBible, elementBible } =
      replayRecordedE2eScenes();
    const styleConfig = StyleConfigSchema.parse(recordedStyleConfig());
    const aspectRatio = '16:9';

    for (const file of loadOpenrouterStage('visual-prompts')) {
      const recordedMessage = file.fixtures[0]?.match.userMessage;
      if (!recordedMessage)
        throw new Error('visual fixture missing userMessage');
      const recorded = extractTaggedJson(
        recordedMessage,
        'CURRENT_SCENE',
        recordedCurrentSceneSchema
      );
      const index = recorded.sceneNumber - 1;
      const scene = scenes[index];
      if (!scene) throw new Error(`No live scene ${recorded.sceneNumber}`);
      const narrowed = narrowShotPromptContext({
        scene,
        styleConfig,
        characterBible,
        locationBible,
        elementBible,
        aspectRatio,
        analysisModel: 'anthropic/claude-opus-5',
      });
      const { messages } = await getChatPrompt(
        'phase/visual-prompt-scene-generation-chat',
        {
          sceneBefore:
            index > 0 ? JSON.stringify(scenes[index - 1], null, 2) : '(none)',
          sceneAfter:
            index < scenes.length - 1
              ? JSON.stringify(scenes[index + 1], null, 2)
              : '(none)',
          scene: JSON.stringify(scene, null, 2),
          characterBible: JSON.stringify(narrowed.characterBible, null, 2),
          locationBible: JSON.stringify(narrowed.locationBible, null, 2),
          elementBible: JSON.stringify(narrowed.elementBible, null, 2),
          styleConfig: JSON.stringify(styleConfig, null, 2),
          aspectRatio,
        }
      );
      const user = messages.find((m) => m.role === 'user');
      expect(user?.content).toBe(recordedMessage);
    }
  });

  it('motion-prompt user messages match the live getChatPrompt reconstruction', async () => {
    const { scenes, characterBible, locationBible, elementBible } =
      replayRecordedE2eScenes();
    const styleConfig = StyleConfigSchema.parse(recordedStyleConfig());
    const aspectRatio = '16:9';

    for (const file of loadOpenrouterStage('motion-prompts')) {
      const recordedMessage = file.fixtures[0]?.match.userMessage;
      if (!recordedMessage)
        throw new Error('motion fixture missing userMessage');
      const recorded = extractTaggedJson(
        recordedMessage,
        'CURRENT_SCENE',
        recordedCurrentSceneSchema
      );
      const index = recorded.sceneNumber - 1;
      const scene = scenes[index];
      if (!scene) throw new Error(`No live scene ${recorded.sceneNumber}`);
      const narrowed = narrowShotPromptContext({
        scene,
        styleConfig,
        characterBible,
        locationBible,
        elementBible,
        aspectRatio,
        analysisModel: 'anthropic/claude-opus-5',
        startingFrameImageUrl: 'https://example.invalid/frame.jpg',
      });
      const { messages } = await getChatPrompt(
        'phase/motion-prompt-scene-generation-chat',
        {
          startingFrameNote:
            'The rendered starting frame is attached below as an image — animate strictly from it.',
          sceneBefore:
            index > 0 ? JSON.stringify(scenes[index - 1], null, 2) : '(none)',
          sceneAfter:
            index < scenes.length - 1
              ? JSON.stringify(scenes[index + 1], null, 2)
              : '(none)',
          scene: JSON.stringify(scene, null, 2),
          characterBible: JSON.stringify(narrowed.characterBible, null, 2),
          locationBible: JSON.stringify(narrowed.locationBible, null, 2),
          elementBible: JSON.stringify(narrowed.elementBible, null, 2),
          styleConfig: JSON.stringify(styleConfig, null, 2),
          aspectRatio,
        }
      );
      const user = messages.find((m) => m.role === 'user');
      expect(user?.content).toBe(recordedMessage);
    }
  });
});
