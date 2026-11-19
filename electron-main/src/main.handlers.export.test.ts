// Test gap 05 — export, backup, restore and snapshot handlers via the real
// handlers map (main.testConnection harness pattern; Slice 04 harness N/A on main).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { dialog, safeStorage } from 'electron';
import { handlers } from './main.js';
import { IPC_CHANNELS } from './ipc.js';
import { SETTINGS_DEFAULTS } from './appSettingsLoad.js';
import { initSecretsStore, _resetSecretsStoreForTest } from './secrets/index.js';
import { saveSnapshot } from './snapshots.js';
import { writeSceneFile, defaultManifest, writeManifest } from './vault.js';
import type { ChapterEntry, Manifest, SceneEntry, StoryEntry } from './ipc.js';

const sqliteStub = vi.hoisted(() => {
  const stmt = {
    run: vi.fn().mockReturnValue({ changes: 0 }),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
  };
  return {
    prepare: vi.fn(() => stmt),
  };
});

const paths = vi.hoisted(() => ({ userData: '' }));

const browserWindowMock = vi.hoisted(() => ({
  instances: [] as Array<{
    lastHtmlPath: string;
    lastHtmlContent: string;
    webContents: { printToPDF: ReturnType<typeof vi.fn> };
  }>,
}));

async function epubSceneXhtmlBodies(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const bodies: string[] = [];
  for (let i = 0; i < 32; i++) {
    const file = zip.file(`OEBPS/scene-${i}.xhtml`);
    if (!file) break;
    bodies.push(await file.async('string'));
  }
  return bodies;
}

function assertDirectoryNotWritable(dir: string): void {
  try {
    fs.writeFileSync(path.join(dir, 'mythos-write-probe.txt'), 'probe');
    throw new Error(`directory is writable: ${dir}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('directory is writable')) {
      throw err;
    }
  }
}

vi.mock('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    lastHtmlPath = '';
    lastHtmlContent = '';
    loadFile = vi.fn().mockImplementation(async (htmlPath: string) => {
      this.lastHtmlPath = htmlPath;
      this.lastHtmlContent = fs.readFileSync(htmlPath, 'utf-8');
    });
    webContents = {
      printToPDF: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4\n% fake pdf for tests\n')),
    };
    destroy = vi.fn();
    constructor() {
      browserWindowMock.instances.push(this);
    }
  },
  app: {
    isPackaged: false,
    disableHardwareAcceleration: vi.fn(),
    whenReady: () => new Promise(() => {}),
    on: vi.fn(),
    once: vi.fn(),
    getPath: (name: string) => (name === 'userData' ? paths.userData : `/tmp/mythos-export-handlers-${name}`),
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
  dialog: {
    showErrorBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
  },
  shell: { openExternal: vi.fn(), trashItem: vi.fn(), showItemInFolder: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }) },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
}));
vi.mock('./jobs/jobWorker?nodeWorker', () => ({
  default: () => ({ postMessage() {}, terminate() {}, on() {}, once() {} }),
}));
vi.mock('./db.js', () => ({
  getDb: () => sqliteStub,
  openDb: vi.fn(),
  closeDb: vi.fn(),
  insertAuditLog: vi.fn(),
  insertManifestMigrationLog: vi.fn(),
}));

const CREATED_AT = '2026-01-01T00:00:00.000Z';

let vaultRoot: string;
let notesRoot: string;
let outDir: string;

function makeScene(id: string, order: number): SceneEntry {
  return {
    id,
    title: `Scene ${id}`,
    path: `scenes/${id}.md`,
    order,
    blocks: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function seedExportVault(): { manifest: Manifest; storyId: string; sceneIds: string[] } {
  const scene1 = makeScene('exp-sc-1', 0);
  const scene2 = makeScene('exp-sc-2', 1);
  const chapter: ChapterEntry = {
    id: 'exp-ch-1',
    title: 'Export Chapter',
    path: 'chapters/exp-ch-1',
    order: 0,
    scenes: [scene1, scene2],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const story: StoryEntry = {
    id: 'exp-story-1',
    title: 'Export Handler Story',
    path: 'stories/exp-story-1',
    chapters: [chapter],
    parts: [],
    synopsis: 'Synopsis for export options.',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const manifest: Manifest = { ...defaultManifest(vaultRoot), stories: [story] };
  writeManifest(path.join(vaultRoot, 'manifest.json'), manifest);
  writeSceneFile(vaultRoot, scene1.path, { id: scene1.id, title: scene1.title, prose: 'First scene export prose.' });
  writeSceneFile(vaultRoot, scene2.path, { id: scene2.id, title: scene2.title, prose: 'Second scene export prose.' });
  fs.writeFileSync(path.join(vaultRoot, '.mythos-seeded'), CREATED_AT, 'utf-8');
  return { manifest, storyId: story.id, sceneIds: [scene1.id, scene2.id] };
}

function seedUserDataLayout(): void {
  fs.mkdirSync(paths.userData, { recursive: true });
  fs.writeFileSync(
    path.join(paths.userData, 'app-settings.json'),
    JSON.stringify({ ...SETTINGS_DEFAULTS, onboardingComplete: true }, null, 2),
  );
  fs.writeFileSync(
    path.join(paths.userData, 'vault-settings.json'),
    JSON.stringify({ vaultRoot, notesVaultRoot: notesRoot, layoutMode: 'imported' }, null, 2),
  );
  initSecretsStore({ userDataDir: paths.userData, safeStorage });
}

beforeEach(() => {
  vi.clearAllMocks();
  browserWindowMock.instances.length = 0;
  _resetSecretsStoreForTest();

  paths.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-export-ud-'));
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-export-vault-'));
  notesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-export-notes-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-export-out-'));

  seedUserDataLayout();
  seedExportVault();
});

afterEach(() => {
  _resetSecretsStoreForTest();
  for (const dir of [paths.userData, vaultRoot, notesRoot, outDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

const exportMarkdown = handlers[IPC_CHANNELS.EXPORT_MARKDOWN];
const exportPlaintext = handlers[IPC_CHANNELS.EXPORT_PLAINTEXT];
const exportDocx = handlers[IPC_CHANNELS.EXPORT_DOCX];
const exportPdf = handlers[IPC_CHANNELS.EXPORT_PDF];
const exportEpub = handlers[IPC_CHANNELS.EXPORT_EPUB];
const backupHandler = handlers[IPC_CHANNELS.APP_BACKUP_APP_DATA];
const restoreHandler = handlers[IPC_CHANNELS.APP_RESTORE_APP_DATA];
const snapshotRestore = handlers[IPC_CHANNELS.SNAPSHOT_RESTORE];

describe('export handlers write real files with ordered prose', () => {
  it('export:markdown writes .md bytes containing scene prose in order', async () => {
    const target = path.join(outDir, 'story.md');
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target });
    const result = await exportMarkdown({ scope: { kind: 'story', storyId: 'exp-story-1' } });
    expect(result.cancelled).toBe(false);
    expect(result.path).toBe(target);
    const text = fs.readFileSync(target, 'utf-8');
    const first = text.indexOf('First scene export prose.');
    const second = text.indexOf('Second scene export prose.');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
    expect(result.bytes).toBe(Buffer.byteLength(text, 'utf-8'));
  });

  it('export:plaintext writes .txt bytes with scene prose', async () => {
    const target = path.join(outDir, 'chapter.txt');
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target });
    const result = await exportPlaintext({
      scope: { kind: 'chapter', storyId: 'exp-story-1', chapterId: 'exp-ch-1' },
    });
    expect(result.cancelled).toBe(false);
    const text = fs.readFileSync(target, 'utf-8');
    const first = text.indexOf('First scene export prose.');
    const second = text.indexOf('Second scene export prose.');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
  });

  it('export:docx writes a ZIP docx containing both scene prose strings', async () => {
    const target = path.join(outDir, 'book.docx');
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target });
    const result = await exportDocx({
      scope: { kind: 'story', storyId: 'exp-story-1' },
      options: { includeSynopsis: true, sceneSeparators: true },
    });
    expect(result.cancelled).toBe(false);
    const buf = fs.readFileSync(target);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    const zip = await JSZip.loadAsync(buf);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('First scene export prose.');
    expect(docXml).toContain('Second scene export prose.');
    expect(docXml).toContain('Synopsis for export options.');
    expect(docXml).toContain('◆ ◆ ◆');
  });

  it('export:pdf runs printToPDF and writes %PDF bytes with prose in HTML source path', async () => {
    const target = path.join(outDir, 'book.pdf');
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target });
    const result = await exportPdf({
      scope: { kind: 'story', storyId: 'exp-story-1' },
      options: { sceneSeparators: true },
    });
    expect(result.cancelled).toBe(false);
    expect(browserWindowMock.instances.length).toBeGreaterThan(0);
    const win = browserWindowMock.instances.at(-1)!;
    expect(win.lastHtmlContent).toBeTruthy();
    const html = win.lastHtmlContent;
    const first = html.indexOf('First scene export prose.');
    const second = html.indexOf('Second scene export prose.');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
    const pdf = fs.readFileSync(target);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('export:epub via save dialog writes a real epub zip', async () => {
    const target = path.join(outDir, 'dialog.epub');
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target });
    const result = await exportEpub({ storyId: 'exp-story-1', options: { sceneSeparators: false } });
    expect(result.cancelled).toBe(false);
    expect(result.path).toBe(target);
    const buf = fs.readFileSync(target);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(result.bytes).toBeGreaterThan(100);
    const bodies = await epubSceneXhtmlBodies(buf);
    const combined = bodies.join('\n');
    const first = combined.indexOf('First scene export prose.');
    const second = combined.indexOf('Second scene export prose.');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
  });

  it('export:epub with vault targetPath writes a real epub zip', async () => {
    const rel = 'exports/smoke.epub';
    fs.mkdirSync(path.join(vaultRoot, 'exports'), { recursive: true });
    const result = await exportEpub({
      storyId: 'exp-story-1',
      targetPath: rel,
      options: { includeSynopsis: true },
    });
    expect(result.cancelled).toBe(false);
    const abs = path.join(vaultRoot, rel);
    expect(fs.existsSync(abs)).toBe(true);
    const buf = fs.readFileSync(abs);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(buf.toString('latin1')).toContain('application/epub+zip');
    const bodies = await epubSceneXhtmlBodies(buf);
    const combined = bodies.join('\n');
    expect(combined).toContain('First scene export prose.');
    expect(combined).toContain('Second scene export prose.');
    expect(combined.indexOf('First scene export prose.')).toBeLessThan(
      combined.indexOf('Second scene export prose.'),
    );
  });
});

describe('export handlers — read-only target', () => {
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'export:markdown rejects a non-writable directory without leaving a file',
    async () => {
    const lockedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-export-ro-'));
    const target = path.join(lockedDir, 'blocked.md');
    try {
      fs.chmodSync(lockedDir, 0o555);
      assertDirectoryNotWritable(lockedDir);

      vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target });
      await expect(
        exportMarkdown({ scope: { kind: 'story', storyId: 'exp-story-1' } }),
      ).rejects.toThrow();
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.chmodSync(lockedDir, 0o700);
      fs.rmSync(lockedDir, { recursive: true, force: true });
    }
    },
  );
});

describe('app:backupAppData → change → app:restoreAppData', () => {
  it('round-trips app-settings through backup and confirmed restore', async () => {
    const settingsPath = path.join(paths.userData, 'app-settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ ...SETTINGS_DEFAULTS, onboardingComplete: true, theme: 'before-backup' }, null, 2),
    );

    const backupPath = path.join(outDir, 'roundtrip.mwbackup');
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: backupPath });

    const backupRes = await backupHandler({});
    expect(backupRes.cancelled).toBe(false);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(backupRes.bytes).toBeGreaterThan(0);

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ ...SETTINGS_DEFAULTS, onboardingComplete: true, theme: 'mutated-after-backup' }, null, 2),
    );

    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [backupPath],
    });
    const restoreRes = await restoreHandler({ confirmed: true });
    expect(restoreRes.restored).toBe(true);
    const restored = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { theme: string };
    expect(restored.theme).toBe('before-backup');
  });

  it('refuses a corrupt backup and leaves current userData intact', async () => {
    const markerPath = path.join(paths.userData, 'corrupt-marker.txt');
    fs.writeFileSync(markerPath, 'still-here');

    const badArchive = path.join(outDir, 'corrupt.mwbackup');
    const zip = new JSZip();
    zip.file('readme.txt', 'no header');
    fs.writeFileSync(badArchive, await zip.generateAsync({ type: 'nodebuffer' }));

    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [badArchive],
    });

    await expect(restoreHandler({ confirmed: true })).rejects.toThrow(/header\.json/);
    expect(fs.readFileSync(markerPath, 'utf-8')).toBe('still-here');
  });
});

describe('snapshot:restore', () => {
  it('writes snapshot prose back into the vault scene file', () => {
    const scenePath = 'scenes/exp-sc-1.md';
    const sceneId = 'exp-sc-1';
    fs.writeFileSync(
      path.join(vaultRoot, scenePath),
      `---\nid: ${sceneId}\ntitle: Scene\n---\nCurrent live prose.\n`,
      'utf-8',
    );
    const snap = saveSnapshot(vaultRoot, sceneId, 'Snapshot prose to restore.');

    const result = snapshotRestore({
      sceneId,
      snapshotId: snap.id,
      scenePath,
    });

    expect(result.restored.content).toBe('Snapshot prose to restore.');
    const onDisk = fs.readFileSync(path.join(vaultRoot, scenePath), 'utf-8');
    expect(onDisk).toContain('Snapshot prose to restore.');
    expect(result.preRestoreSnapshot).toBeTruthy();
  });
});