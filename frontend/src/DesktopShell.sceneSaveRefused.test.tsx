/**
 * #1919: refused scene write surfaces banner; snapshot still runs in-vault.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BlockEditorApi } from './BlockEditor';

let lastEditorApi: BlockEditorApi | null = null;

vi.mock('./BlockEditor', async () => {
  const actual = await vi.importActual<typeof import('./BlockEditor')>('./BlockEditor');
  function Wrapped(props: React.ComponentProps<typeof actual.default>) {
    return (
      <actual.default
        {...props}
        onEditorReady={(api) => {
          lastEditorApi = api;
          props.onEditorReady?.(api);
        }}
      />
    );
  }
  return { ...actual, default: Wrapped };
});

import App from './App';

const NOW = '2026-09-29T00:00:00.000Z';
const STORY_A = 'story-a';
const CH_A = 'ch-a';
const SCENE_A = 'scene-a';

function makeScene(storyId: string, chapterId: string, id: string, title: string, content: string) {
  return {
    id,
    title,
    path: `stories/${storyId}/chapters/${chapterId}/scenes/${id}.md`,
    order: 0,
    chapterId,
    storyId,
    createdAt: NOW,
    updatedAt: NOW,
    blocks: [{ id: `${id}-b0`, type: 'prose', content, order: 0, updatedAt: NOW }],
  };
}

function makeSingleStoryManifest() {
  const scene = makeScene(STORY_A, CH_A, SCENE_A, 'Scene One', 'Seed prose.');
  const chapter = {
    id: CH_A,
    title: 'Chapter One',
    path: `stories/${STORY_A}/chapters/${CH_A}`,
    order: 0,
    scenes: [scene],
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    version: '1',
    vaultRoot: '/tmp/story-vault',
    stories: [{
      id: STORY_A,
      title: 'Story',
      path: `stories/${STORY_A}`,
      createdAt: NOW,
      updatedAt: NOW,
      chapters: [chapter],
      parts: [{
        id: 'part-1',
        title: '',
        order: 0,
        note: [],
        chapters: [chapter],
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }],
    entities: [],
    suggestions: [],
    scenes: [],
    chapters: [],
  };
}

function makeMockApi(
  manifest: ReturnType<typeof makeSingleStoryManifest>,
  writeVault: ReturnType<typeof vi.fn>,
  snapshotSave: ReturnType<typeof vi.fn>,
) {
  const scenePath = `stories/${STORY_A}/chapters/${CH_A}/scenes/${SCENE_A}.md`;
  return {
    settingsGet: () => Promise.resolve({
      onboardingComplete: true,
      lastOpenedScene: { sceneId: SCENE_A, scenePath, scrollTop: 0, cursorLine: 0 },
    }),
    vaultGetPaths: () => Promise.resolve({
      storyVaultPath: '/tmp/mythos-story-vault',
      notesVaultPath: '/tmp/mythos-notes-vault',
    }),
    validatePath: () => Promise.resolve({ exists: true, isEmpty: false, writable: true }),
    settingsSet: vi.fn().mockResolvedValue({}),
    readManifest: () => Promise.resolve(structuredClone(manifest)),
    writeManifest: vi.fn().mockResolvedValue({}),
    writeVault,
    deleteVault: vi.fn().mockResolvedValue({}),
    onVaultFileChanged: () => () => {},
    onNavigatorManifestChanged: () => () => {},
    entityList: vi.fn().mockResolvedValue({ entities: [] }),
    sessionSaveScene: vi.fn().mockResolvedValue({ saved: true }),
    archiveListContinuity: () => Promise.resolve({ items: [] }),
    onArchiveContScanStart: () => () => {},
    onArchiveContScanResult: () => () => {},
    onArchiveContScanError: () => () => {},
    snapshotSave,
    listNotesVault: vi.fn().mockResolvedValue({ items: [] }),
    readNotesVault: vi.fn().mockResolvedValue({ path: 'x', content: '' }),
    writeNotesVault: vi.fn().mockResolvedValue({ path: 'x', bytes: 1 }),
    notesVaultReadIcons: vi.fn().mockResolvedValue({}),
    noteBacklinks: vi.fn().mockResolvedValue({ backlinks: [] }),
    notesTagList: vi.fn().mockResolvedValue({ tags: [] }),
    projectList: vi.fn().mockResolvedValue({
      projects: [{ vaultRoot: '/tmp/story-vault', name: 'Story Vault', notesVaultRoot: '/tmp/mythos-notes-vault' }],
      activeNotesVaultRoot: '/tmp/mythos-notes-vault',
    }),
    continuitySearch: vi.fn().mockResolvedValue({ results: [] }),
    continuityMatchSelection: vi.fn().mockResolvedValue({ match: null }),
    getVaultRoot: () => Promise.resolve({ vaultRoot: '/tmp/story-vault' }),
    readVault: vi.fn().mockResolvedValue({ content: '---\ntitle: Scene One\n---\n\nSeed prose.' }),
    projectSwitch: vi.fn().mockResolvedValue({ switched: true }),
    onProjectSwitched: () => () => {},
    vaultList: vi.fn().mockResolvedValue({ vaults: [] }),
  };
}

async function mountSceneEditor(api: ReturnType<typeof makeMockApi>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).api = api;
  render(<App />);
  lastEditorApi = null;
  await screen.findByRole('navigation', { name: 'Main navigation' });
  await screen.findByTestId('msv-root');
  fireEvent.click(screen.getByTestId('msv-zoom-scene'));
  await waitFor(() => expect(lastEditorApi).toBeTruthy(), { timeout: 5000 });
  await act(async () => { await Promise.resolve(); });
  return lastEditorApi!;
}

describe('DesktopShell refused scene save (#1919)', () => {
  beforeEach(() => {
    document.elementFromPoint = () => document.body;
    lastEditorApi = null;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows scene-save-warning and still snapshots after writeVault refuses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const scenePath = `stories/${STORY_A}/chapters/${CH_A}/scenes/${SCENE_A}.md`;
    const writeVault = vi.fn().mockResolvedValue({ path: scenePath, bytes: 0, error: 'read-only' });
    const snapshotSave = vi.fn().mockResolvedValue({});
    const api = makeMockApi(makeSingleStoryManifest(), writeVault, snapshotSave);
    const editor = await mountSceneEditor(api);

    await act(async () => {
      editor.insertText('More prose.');
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();

    await waitFor(() => expect(writeVault).toHaveBeenCalled(), { timeout: 10000 });
    await waitFor(() => {
      expect(screen.getAllByTestId('scene-save-warning').length).toBeGreaterThan(0);
    }, { timeout: 10000 });
    expect(snapshotSave).toHaveBeenCalledWith(SCENE_A, expect.stringContaining('More prose'));
  });
});