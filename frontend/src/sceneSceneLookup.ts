import type { SceneSaveFailureEntry } from './scenePersist';
import type { Scene, Story } from './types';

/** Placeholder story id when the scene cannot be located in the manifest yet. */
export const UNKNOWN_STORY_ID = '?';

export function findSceneInStories(stories: Story[], storyId: string, sceneId: string): Scene | undefined {
  const story = stories.find((s) => s.id === storyId);
  if (!story) return undefined;
  for (const ch of story.chapters) {
    const sc = ch.scenes.find((s) => s.id === sceneId);
    if (sc) return sc;
  }
  for (const part of story.parts ?? []) {
    for (const ch of part.chapters) {
      const sc = ch.scenes.find((s) => s.id === sceneId);
      if (sc) return sc;
    }
  }
  return undefined;
}

/** Match `findSceneInStories` scope — includes `parts[].chapters`. */
export function resolveStoryIdForScene(stories: Story[], scene: Scene): string {
  if (scene.storyId) return scene.storyId;
  for (const st of stories) {
    if (findSceneInStories(stories, st.id, scene.id)) return st.id;
  }
  return UNKNOWN_STORY_ID;
}

export function findSceneForFailureEntry(
  stories: Story[],
  entry: Pick<SceneSaveFailureEntry, 'storyId' | 'sceneId'>,
): Scene | undefined {
  if (entry.storyId !== UNKNOWN_STORY_ID) {
    return findSceneInStories(stories, entry.storyId, entry.sceneId);
  }
  for (const st of stories) {
    const sc = findSceneInStories(stories, st.id, entry.sceneId);
    if (sc) return sc;
  }
  return undefined;
}