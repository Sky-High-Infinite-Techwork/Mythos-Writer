// Handler-level tests for VAULT_SURFACE_TRASH active-vault fallout (gate #1918 / Probe).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shell } from 'electron';
import { handlers, setMainWindowForTests } from './main.js';
import * as storyVaultRegistryModule from './mythosFormat/storyVaultRegistry.js';
import { IPC_CHANNELS } from './ipc.js';
import { createMythosFile, writeMythosFile } from './mythosFormat/mythosJson.js';
import {
  ensureNotesVaultRegistry,
  readNotesVaultRegistry,
  notesVaultAbsPath,
} from './mythosFormat/notesVaultRegistry.js';
import {
  ensureStoryVaultRegistry,
  readStoryVaultRegistry,
  storyVaultAbsPath,
} from './mythosFormat/storyVaultRegistry.js';

const paths = vi.hoisted(() => ({ userData: '' }));

const mainWindowMock = vi.hoisted(() => ({
  webContents: { send: vi.fn() },
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = mainWindowMock.webContents;
    destroy = vi.fn();
  },
  app: {
    isPackaged: false,
    disableHardwareAcceleration: vi.fn(),
    whenReady: () => new Promise(() => {}),
    on: vi.fn(),
    once: vi.fn(),
    getPath: (name: string) => (name === 'userData' ? paths.userData : `/tmp/mythos-vault-trash-handlers-${name}`),
    getAppPath: () => '/agent/repos/Mythos-Writer',
    getVersion: () => '0.0.0-test',
    getName: () => 'Mythos Writer',
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    exit: vi.fn(),
    setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: {
    openExternal: vi.fn(),
    trashItem: vi.fn(async (p: string) => {
      fs.rmSync(p, { recursive: true, force: true });
    }),
    showItemInFolder: vi.fn(),
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }) },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
}));
vi.mock('./jobs/jobWorker?nodeWorker', () => ({
  default: () => ({ postMessage() {}, terminate() {}, on() {}, once() {} }),
}));
vi.mock('./db.js', () => ({
  getDb: () => ({
    prepare: () => ({
      run: vi.fn().mockReturnValue({ changes: 0 }),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    exec: vi.fn(),
    pragma: vi.fn(),
  }),
  openDb: vi.fn(),
  closeDb: vi.fn(),
  insertAuditLog: vi.fn(),
  insertManifestMigrationLog: vi.fn(),
}));
vi.mock('./searchIndex.js', () => ({
  buildFullIndex: vi.fn(),
}));

const OPENED = '2026-01-01T00:00:00.000Z';

function seedMythosBundle(root: string, name: string): { mythos: string; story: string; notes: string } {
  const mythos = path.join(root, name);
  const story = path.join(mythos, 'Story Vault');
  const notes = path.join(mythos, 'Notes Vault');
  fs.mkdirSync(story, { recursive: true });
  fs.mkdirSync(notes, { recursive: true });
  writeMythosFile(mythos, createMythosFile(name));
  ensureStoryVaultRegistry(mythos);
  ensureNotesVaultRegistry(mythos);
  return { mythos, story, notes };
}

function writeVaultSettings(data: {
  vaultRoot: string;
  notesVaultRoot: string;
  recentProjects: Array<{ name: string; vaultRoot: string; notesVaultRoot: string; openedAt: string }>;
}): void {
  fs.mkdirSync(paths.userData, { recursive: true });
  fs.writeFileSync(path.join(paths.userData, 'vault-settings.json'), JSON.stringify(data, null, 2));
}

function readVaultSettings(): {
  vaultRoot?: string;
  notesVaultRoot?: string;
  recentProjects?: unknown[];
} {
  return JSON.parse(fs.readFileSync(path.join(paths.userData, 'vault-settings.json'), 'utf-8'));
}

describe('handlers[VAULT_SURFACE_TRASH] — active vault fallout', () => {
  let tmpRoot: string;
  const trash = handlers[IPC_CHANNELS.VAULT_SURFACE_TRASH] as (p: {
    vaultPath: string;
    level: 'mythos' | 'notes' | 'story';
  }) => Promise<{ trashed: boolean }>;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-handler-trash-'));
    paths.userData = path.join(tmpRoot, 'userData');
    setMainWindowForTests({
      webContents: mainWindowMock.webContents,
      isDestroyed: () => false,
    } as unknown as import('electron').BrowserWindow);
  });

  afterEach(() => {
    setMainWindowForTests(null);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('active story trash switches vaultRoot to a validated survivor and cleans the trashed story registry', async () => {
    const a = seedMythosBundle(tmpRoot, 'Alpha');
    const b = seedMythosBundle(tmpRoot, 'Beta');
    writeVaultSettings({
      vaultRoot: a.story,
      notesVaultRoot: a.notes,
      recentProjects: [
        { name: 'Alpha', vaultRoot: a.story, notesVaultRoot: a.notes, openedAt: OPENED },
        { name: 'Beta', vaultRoot: b.story, notesVaultRoot: b.notes, openedAt: OPENED },
      ],
    });
    const storyEntry = readStoryVaultRegistry(a.mythos)?.vaults[0];
    expect(storyEntry).toBeDefined();
    const storyPath = storyVaultAbsPath(a.mythos, storyEntry!);

    const result = await trash({ vaultPath: storyPath, level: 'story' });
    expect(result.trashed).toBe(true);
    expect(readVaultSettings().vaultRoot).toBe(b.story);
    expect(readStoryVaultRegistry(a.mythos)?.vaults.find((v) => v.id === storyEntry!.id)).toBeUndefined();
  });

  it('active notes trash clears notesVaultRoot only and leaves vaultRoot on the same mythos', async () => {
    const a = seedMythosBundle(tmpRoot, 'Alpha');
    const b = seedMythosBundle(tmpRoot, 'Beta');
    writeVaultSettings({
      vaultRoot: a.story,
      notesVaultRoot: a.notes,
      recentProjects: [
        { name: 'Beta', vaultRoot: b.story, notesVaultRoot: b.notes, openedAt: OPENED },
        { name: 'Alpha', vaultRoot: a.story, notesVaultRoot: a.notes, openedAt: OPENED },
      ],
    });
    const notesEntry = readNotesVaultRegistry(a.mythos)?.vaults[0];
    expect(notesEntry).toBeDefined();
    const notesPath = notesVaultAbsPath(a.mythos, notesEntry!);

    const result = await trash({ vaultPath: notesPath, level: 'notes' });
    expect(result.trashed).toBe(true);
    expect(readVaultSettings().vaultRoot).toBe(a.story);
    expect(readVaultSettings().notesVaultRoot).toBeUndefined();
    expect(readNotesVaultRegistry(a.mythos)?.vaults.find((v) => v.id === notesEntry!.id)).toBeUndefined();
  });

  it('sole active story trash clears settings, returns null from VAULT_GET_ROOT, and broadcasts empty project:switched', async () => {
    const only = seedMythosBundle(tmpRoot, 'Only');
    writeVaultSettings({
      vaultRoot: only.story,
      notesVaultRoot: only.notes,
      recentProjects: [{ name: 'Only', vaultRoot: only.story, notesVaultRoot: only.notes, openedAt: OPENED }],
    });
    const storyEntry = readStoryVaultRegistry(only.mythos)?.vaults[0]!;
    const storyPath = storyVaultAbsPath(only.mythos, storyEntry);

    const result = await trash({ vaultPath: storyPath, level: 'story' });
    expect(result.trashed).toBe(true);
    expect(readVaultSettings().vaultRoot).toBeUndefined();
    expect(readVaultSettings().notesVaultRoot).toBeUndefined();
    expect(readStoryVaultRegistry(only.mythos)?.vaults).toHaveLength(0);
    const getRoot = handlers[IPC_CHANNELS.VAULT_GET_ROOT] as () => { vaultRoot: string | null };
    expect(getRoot().vaultRoot).toBeNull();
    expect(mainWindowMock.webContents.send).toHaveBeenCalledWith('project:switched', {
      vaultRoot: null,
      notesVaultRoot: null,
    });
  });

  it('active mythos trash with survivor broadcasts project:switched to the survivor roots', async () => {
    const a = seedMythosBundle(tmpRoot, 'Alpha');
    const b = seedMythosBundle(tmpRoot, 'Beta');
    writeVaultSettings({
      vaultRoot: a.story,
      notesVaultRoot: a.notes,
      recentProjects: [
        { name: 'Alpha', vaultRoot: a.story, notesVaultRoot: a.notes, openedAt: OPENED },
        { name: 'Beta', vaultRoot: b.story, notesVaultRoot: b.notes, openedAt: OPENED },
      ],
    });
    mainWindowMock.webContents.send.mockClear();
    const result = await trash({ vaultPath: a.mythos, level: 'mythos' });
    expect(result.trashed).toBe(true);
    expect(readVaultSettings().vaultRoot).toBe(b.story);
    expect(mainWindowMock.webContents.send).toHaveBeenCalledWith('project:switched', {
      vaultRoot: b.story,
      notesVaultRoot: b.notes,
    });
  });

  it('still reconciles settings when inner registry cleanup throws', async () => {
    const a = seedMythosBundle(tmpRoot, 'Alpha');
    const b = seedMythosBundle(tmpRoot, 'Beta');
    writeVaultSettings({
      vaultRoot: a.story,
      notesVaultRoot: a.notes,
      recentProjects: [
        { name: 'Alpha', vaultRoot: a.story, notesVaultRoot: a.notes, openedAt: OPENED },
        { name: 'Beta', vaultRoot: b.story, notesVaultRoot: b.notes, openedAt: OPENED },
      ],
    });
    const storyEntry = readStoryVaultRegistry(a.mythos)?.vaults[0]!;
    const storyPath = storyVaultAbsPath(a.mythos, storyEntry);
    const removeSpy = vi.spyOn(storyVaultRegistryModule, 'removeStoryVault').mockImplementation(() => {
      throw new Error('injected registry write failure');
    });
  try {
    const result = await trash({ vaultPath: storyPath, level: 'story' });
    expect(result.trashed).toBe(true);
    expect(readVaultSettings().vaultRoot).toBe(b.story);
  } finally {
    removeSpy.mockRestore();
  }
  });

  it('non-active mythos trash does not change the active vaultRoot', async () => {
    const a = seedMythosBundle(tmpRoot, 'Alpha');
    const b = seedMythosBundle(tmpRoot, 'Beta');
    writeVaultSettings({
      vaultRoot: a.story,
      notesVaultRoot: a.notes,
      recentProjects: [
        { name: 'Alpha', vaultRoot: a.story, notesVaultRoot: a.notes, openedAt: OPENED },
        { name: 'Beta', vaultRoot: b.story, notesVaultRoot: b.notes, openedAt: OPENED },
      ],
    });

    const result = await trash({ vaultPath: b.mythos, level: 'mythos' });
    expect(result.trashed).toBe(true);
    expect(readVaultSettings().vaultRoot).toBe(a.story);
    expect(readVaultSettings().notesVaultRoot).toBe(a.notes);
  });
});