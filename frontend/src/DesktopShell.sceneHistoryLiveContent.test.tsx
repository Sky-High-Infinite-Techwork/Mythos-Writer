// The History restore path must send the live editor text, not the last
// saved blocks. Swapping the showSceneHistory branches drops unsaved words.
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

const STORY_ID = 'story-1';
const CHAPTER_ID = 'chapter-1';
const SCENE_ID = 'scene-1';
const NOW = '2026-07-01T00:00:00.000Z';
const SCENE_PATH = `stories/${STORY_ID}/chapters/${CHAPTER_ID}/scenes/${SCENE_ID}.md`;

const draftsList = vi.fn();
const draftsPreview = vi.fn();
const draftsRestore = vi.fn();

function makeMockApi() {
  return {
    settingsGet: () => Promise.resolve({
      onboardingComplete: true,
      lastOpenedScene: { sceneId: SCENE_ID, scenePath: SCENE_PATH, scrollTop: 0, cursorLine: 0 },
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
        chapters: [{
          id: CHAPTER_ID,
          title: 'Chapter One',
          path: `stories/${STORY_ID}/chapters/${CHAPTER_ID}`,
          order: 0,
          createdAt: NOW,
          updatedAt: NOW,
          scenes: [{
            id: SCENE_ID,
            title: 'Scene One',
            path: SCENE_PATH,
            order: 0,
            createdAt: NOW,
            updatedAt: NOW,
            blocks: [{ id: 'block-a', type: 'prose', content: 'Saved body.', order: 0, updatedAt: NOW }],
          }],
        }],
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
    draftsList,
    draftsPreview,
    draftsRestore,
    draftsDelete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DesktopShell scene history live content', () => {
  it('sends the unsaved editor text to draftsRestore', async () => {
    draftsList.mockResolvedValue({ snapshots: [{ id: 'snap-1', createdAt: 1_700_000_000_000, label: 'draft one' }] });
    draftsPreview.mockResolvedValue({ content: 'older draft' });
    draftsRestore.mockResolvedValue({ content: 'older draft', preRestoreSnapshotId: 'pre-1' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).api = makeMockApi();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('navigation', { name: 'Main navigation' });
    fireEvent.click(await screen.findByTestId('msv-zoom-scene'));
    const editor = await waitFor(() => {
      const el = document.querySelector('.ProseMirror');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await user.click(editor);
    await user.keyboard(' UNSAVEDWORD');
    await waitFor(() => expect(editor.textContent).toContain('UNSAVEDWORD'));

    fireEvent.click(await screen.findByTestId('msv-title-menu-btn'));
    fireEvent.click(await screen.findByTestId('msv-title-menu-history'));
    fireEvent.click(await screen.findByLabelText(/Draft from/));
    fireEvent.click(await screen.findByRole('button', { name: /^Restore/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm restore' }));

    await waitFor(() => expect(draftsRestore).toHaveBeenCalled());
    const current = draftsRestore.mock.calls[0]?.[2] as string;
    expect(current).toContain('UNSAVEDWORD');
    expect(current).toContain('Saved body.');
  });
});
