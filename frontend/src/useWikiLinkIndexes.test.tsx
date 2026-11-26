import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { render, renderHook, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { WikiLink } from './WikiLinkExtension';
import { WikiLinkResolutionExtension, WIKI_LINK_RESOLUTION_META } from './WikiLinkResolutionExtension';
import { useWikiLinkIndexes } from './useWikiLinkIndexes';
import type { EntityEntry, Story } from './types';

const NO_ENTITIES: EntityEntry[] = [];
const NO_PATHS: string[] = [];

const now = '2026-06-17T00:00:00.000Z';

function sceneTwo(title = 'Scene Two'): Story {
  return {
    id: 'story-1',
    title: 'Test Story',
    path: 'Test Story',
    createdAt: now,
    updatedAt: now,
    chapters: [{
      id: 'chapter-1',
      title: 'Chapter One',
      path: 'Test Story/Chapter One',
      order: 0,
      createdAt: now,
      updatedAt: now,
      scenes: [{
        id: 'scene-2',
        title,
        path: 'Test Story/Chapter One/Scene Two.md',
        order: 0,
        blocks: [{ id: 'b', type: 'prose', content: 'saved body', order: 0, updatedAt: now }],
        createdAt: now,
        updatedAt: now,
      }],
    }],
  };
}

function Probe({ stories, editor }: { stories: Story[]; editor: Editor }) {
  const { wikiLinkTitleIndex } = useWikiLinkIndexes(stories, NO_ENTITIES, NO_PATHS);
  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(WIKI_LINK_RESOLUTION_META, {
      resolvedTitles: wikiLinkTitleIndex,
    }));
  }, [editor, wikiLinkTitleIndex]);
  return null;
}

describe('useWikiLinkIndexes', () => {
  it('keeps the index across a body edit and rebuilds when a scene is renamed', () => {
    const { result, rerender } = renderHook(
      ({ stories }: { stories: Story[] }) => useWikiLinkIndexes(stories, NO_ENTITIES, NO_PATHS),
      { initialProps: { stories: [] as Story[] } },
    );
    expect(result.current.wikiLinkTitleIndex.has('scene two')).toBe(false);

    rerender({ stories: [sceneTwo()] });
    expect(result.current.wikiLinkTitleIndex.has('scene two')).toBe(true);
    const loaded = result.current.wikiLinkTitleIndex;

    const edited = sceneTwo();
    edited.chapters[0]!.scenes[0]!.blocks = [{
      id: 'b2', type: 'prose', content: 'a different paragraph', order: 0, updatedAt: now,
    }];
    rerender({ stories: [edited] });
    expect(result.current.wikiLinkTitleIndex).toBe(loaded);

    const renamed = sceneTwo('Scene Three');
    renamed.chapters[0]!.scenes[0]!.path = 'Test Story/Chapter One/Scene Three.md';
    rerender({ stories: [renamed] });
    expect(result.current.wikiLinkTitleIndex).not.toBe(loaded);
    expect(result.current.wikiLinkTitleIndex.has('scene three')).toBe(true);
    expect(result.current.wikiLinkTitleIndex.has('scene two')).toBe(false);
  });

  it('resolves a scene link after stories arrive and drops it after a rename', async () => {
    const editor = new Editor({
      extensions: [StarterKit, WikiLink, WikiLinkResolutionExtension, Markdown],
      content: '[[Scene Two]]',
    });
    const view = render(<Probe stories={[]} editor={editor} />);
    await waitFor(() => {
      expect(editor.view.dom.querySelector('span[data-wiki-link]')?.classList.contains('wiki-link-unresolved')).toBe(true);
    });

    view.rerender(<Probe stories={[sceneTwo()]} editor={editor} />);
    await waitFor(() => {
      expect(editor.view.dom.querySelector('span[data-wiki-link]')?.classList.contains('wiki-link-unresolved')).toBe(false);
    });

    const renamed = sceneTwo('Scene Three');
    renamed.chapters[0]!.scenes[0]!.path = 'Test Story/Chapter One/Scene Three.md';
    view.rerender(<Probe stories={[renamed]} editor={editor} />);
    await waitFor(() => {
      expect(editor.view.dom.querySelector('span[data-wiki-link]')?.classList.contains('wiki-link-unresolved')).toBe(true);
    });
    editor.destroy();
  });
});
