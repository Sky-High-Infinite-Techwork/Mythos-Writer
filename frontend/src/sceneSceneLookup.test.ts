import { describe, expect, it } from 'vitest';
import type { Scene, Story } from './types';
import { findSceneInStories, resolveStoryIdForScene, UNKNOWN_STORY_ID } from './sceneSceneLookup';

const sceneInPart: Scene = {
  id: 'sc-part',
  title: 'Part scene',
  path: 'x.md',
  order: 0,
  chapterId: 'ch-1',
  storyId: 'story-1',
  blocks: [],
  createdAt: 't',
  updatedAt: 't',
};

const storyWithParts: Story = {
  id: 'story-1',
  title: 'S',
  path: 'stories/story-1',
  chapters: [],
  parts: [
    {
      id: 'p1',
      title: '',
      order: 0,
      note: [],
      chapters: [{ id: 'ch-1', title: 'C', path: 'c', order: 0, scenes: [sceneInPart], createdAt: 't', updatedAt: 't' }],
      createdAt: 't',
      updatedAt: 't',
    },
  ],
  createdAt: 't',
  updatedAt: 't',
};

describe('resolveStoryIdForScene', () => {
  it('finds a scene that only lives under parts[].chapters', () => {
    expect(resolveStoryIdForScene([storyWithParts], { ...sceneInPart, storyId: undefined })).toBe('story-1');
    expect(findSceneInStories([storyWithParts], 'story-1', 'sc-part')?.title).toBe('Part scene');
  });

  it('returns UNKNOWN when the scene is not in the manifest yet but keeps sceneId for failure UI', () => {
    const orphan: Scene = {
      id: 'new-sc',
      title: 'New',
      path: 'stories/x/scenes/new-sc.md',
      order: 0,
      blocks: [],
      createdAt: 't',
      updatedAt: 't',
    };
    expect(resolveStoryIdForScene([], orphan)).toBe(UNKNOWN_STORY_ID);
  });
});