// A scene link must resolve once the manifest arrives. Dropping the title
// signature from the index memo leaves [[Scene Two]] unresolved.
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

const STORY_ID = 'story-1';
const CHAPTER_ID = 'chapter-1';
const CHAPTER_2_ID = 'chapter-2';
const SCENE_ID = 'scene-1';
const SCENE_2_ID = 'scene-2';
const NOW = '2026-07-01T00:00:00.000Z';

function makeMockApi() {
  return {
    settingsGet: () => Promise.resolve({
      onboardingComplete: true,
      lastOpenedScene: {
        sceneId: SCENE_ID,
        scenePath: `stories/${STORY_ID}/chapters/${CHAPTER_ID}/scenes/${SCENE_ID}.md`,
        scrollTop: 0,
        cursorLine: 0,
      },
    }),
    vaultGetPaths: () => Promise.resolve({
      storyVaultPath: '/tmp/mythos-story-vault',
      notesVaultPath: '/tmp/mythos-notes-vault',
    }),
    validatePath: () => Promise.resolve({ exists: true, isEmpty: false, writable: true }),
    settingsSet: vi.fn().mockResolvedValue({}),
    readManifest: () => Promise.resolve({
      version: '1',
      vaultRoot: '/tmp',
      stories: [{
        id: STORY_ID,
        title: 'Regression Story',
        path: `stories/${STORY_ID}`,
        createdAt: NOW,
        updatedAt: NOW,
        chapters: [
          {
            id: CHAPTER_ID,
            title: 'Chapter One',
            path: `stories/${STORY_ID}/chapters/${CHAPTER_ID}`,
            order: 0,
            createdAt: NOW,
            updatedAt: NOW,
            scenes: [{
              id: SCENE_ID,
              title: 'Scene One',
              path: `stories/${STORY_ID}/chapters/${CHAPTER_ID}/scenes/${SCENE_ID}.md`,
              order: 0,
              createdAt: NOW,
              updatedAt: NOW,
              blocks: [{
                id: 'block-a',
                type: 'prose',
                content: 'Body text with a [[Scene Two]] link.',
                order: 0,
                updatedAt: NOW,
              }],
            }],
          },
          {
            id: CHAPTER_2_ID,
            title: 'Chapter Two',
            path: `stories/${STORY_ID}/chapters/${CHAPTER_2_ID}`,
            order: 1,
            createdAt: NOW,
            updatedAt: NOW,
            scenes: [{
              id: SCENE_2_ID,
              title: 'Scene Two',
              path: `stories/${STORY_ID}/chapters/${CHAPTER_2_ID}/scenes/${SCENE_2_ID}.md`,
              order: 0,
              createdAt: NOW,
              updatedAt: NOW,
              blocks: [{ id: 'block-b', type: 'prose', content: 'Scene Two body text.', order: 0, updatedAt: NOW }],
            }],
          },
        ],
      }],
      entities: [],
      suggestions: [],
      scenes: [],
      chapters: [],
    }),
    writeManifest: vi.fn().mockResolvedValue({}),
    writeVault: vi.fn().mockResolvedValue({ path: 'x.md', bytes: 10 }),
    onVaultFileChanged: () => () => {},
    entityList: vi.fn().mockResolvedValue({ entities: [] }),
    sessionSaveScene: vi.fn().mockResolvedValue({}),
    archiveListContinuity: () => Promise.resolve({ items: [] }),
    onArchiveContScanStart: () => () => {},
    onArchiveContScanResult: () => () => {},
    onArchiveContScanError: () => () => {},
  };
}

describe('DesktopShell wiki link after stories load', () => {
  it('resolves [[Scene Two]] once the manifest is in', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).api = makeMockApi();
    render(<App />);
    await screen.findByRole('navigation', { name: 'Main navigation' });
    fireEvent.click(await screen.findByTestId('msv-zoom-scene'));
    const link = await waitFor(() => {
      const el = document.querySelector('[data-wiki-link="Scene Two"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(link.classList.contains('wiki-link-unresolved')).toBe(false);
  });
});
