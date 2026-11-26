import { useMemo, useRef } from 'react';
import {
  buildSceneWikiLinkTitleIndex,
  buildWikiLinkCandidates,
  buildWikiLinkTitleIndex,
  projectStoryLinkFields,
  storyLinkTitleSignature,
  type StoryLinkIndexStory,
} from './crossTabLinkResolver';
import type { EntityEntry } from './types';
import type { WikiLinkCandidate } from './crossTabLinkResolver';

/**
 * Wiki title indexes for the open editors. The memo inputs are a projection
 * of the fields those builders read (ids, titles, paths), so a body-only
 * edit keeps the same Set and a rename builds a new one. Builders never see
 * block content, folders, or other story fields.
 */
export function useWikiLinkIndexes(
  stories: readonly StoryLinkIndexStory[],
  entities: EntityEntry[],
  notePaths: string[],
): {
  wikiLinkTitleIndex: Set<string>;
  wikiLinkCandidates: WikiLinkCandidate[];
  sceneWikiLinkTitleIndex: Set<string>;
} {
  const sig = storyLinkTitleSignature(stories);
  const projected = useRef<{ sig: string; stories: StoryLinkIndexStory[] } | null>(null);
  if (!projected.current || projected.current.sig !== sig) {
    projected.current = { sig, stories: projectStoryLinkFields(stories) };
  }
  const indexedStories = projected.current.stories;

  const wikiLinkTitleIndex = useMemo(
    () => buildWikiLinkTitleIndex({ stories: indexedStories, entities, notePaths }),
    [indexedStories, entities, notePaths],
  );
  const wikiLinkCandidates = useMemo(
    () => buildWikiLinkCandidates({ stories: indexedStories, entities, notePaths }),
    [indexedStories, entities, notePaths],
  );
  const sceneWikiLinkTitleIndex = useMemo(
    () => buildSceneWikiLinkTitleIndex(indexedStories),
    [indexedStories],
  );

  return { wikiLinkTitleIndex, wikiLinkCandidates, sceneWikiLinkTitleIndex };
}
