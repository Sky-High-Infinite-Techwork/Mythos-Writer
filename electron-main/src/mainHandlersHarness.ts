/**
 * IPC handler harness for main.ts scene / vault / settings channels.
 * Test files must register the Electron/db mocks (see main.handlers.*.test.ts)
 * before importing this module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { handlers } from './main.js';
import { IPC_CHANNELS } from './ipc.js';
import { sanitizeIpcError } from './ipcErrors.js';
import { SETTINGS_DEFAULTS } from './appSettingsLoad.js';
import { createMythosVault, type CreateMythosVaultResult } from './mythosFormat/createVault.js';
import { closeDb } from './db.js';
import { readSceneFile } from './vault.js';
import { scanMythosStoryVault } from './mythosFormat/v2Manifest.js';
import { resolveManifestPath } from './mythosFormat/mythosJson.js';
import type { AppSettings, ProjectEntry } from './ipc.js';

const require = createRequire(import.meta.url);
const { makeTestTmp, cleanupTestTmp } = require('../test-utils/tmpdir.mjs') as {
  makeTestTmp: (name: string) => string;
  cleanupTestTmp: () => void;
};

export { handlers, IPC_CHANNELS, makeTestTmp, cleanupTestTmp, closeDb };

/** Close SQLite before temp teardown — Windows notes-windows holds state.db open otherwise. */
export function teardownHandlerHarnessSuite(): void {
  closeDb();
}

/** Call handlers the way setupIpcMain does for map-based handlers (try/catch → sanitize). */
export async function invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const handler = handlers[channel as keyof typeof handlers] as ((p: unknown) => unknown) | undefined;
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  try {
    return (await handler(payload)) as T;
  } catch (err) {
    return sanitizeIpcError(channel, err) as T;
  }
}

export interface SeededVaultBundle {
  parentDir: string;
  userData: string;
  mythosRoot: string;
  storyVaultPath: string;
  notesVaultPath: string;
  created: Extract<CreateMythosVaultResult, { ok: true }>;
}

export function writeVaultSettingsFile(
  userData: string,
  body: {
    vaultRoot: string;
    notesVaultRoot?: string;
    layoutMode?: 'default' | 'blank';
    recentProjects?: ProjectEntry[];
  },
): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'vault-settings.json'), JSON.stringify(body, null, 2), 'utf-8');
}

export function writeAppSettingsFile(userData: string, settings: AppSettings = SETTINGS_DEFAULTS): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({ ...SETTINGS_DEFAULTS, ...settings, onboardingComplete: true }, null, 2),
    'utf-8',
  );
}

/** Real Mythos v2 bundle on disk + userData paths wired for main.ts getters. */
export function seedMythosVaultBundle(options?: { seedDemo?: boolean; name?: string }): SeededVaultBundle {
  const parentDir = makeTestTmp('mh-parent');
  const created = createMythosVault(parentDir, {
    name: options?.name ?? 'HandlerHarness',
    exactName: true,
    seedDemo: options?.seedDemo ?? true,
  });
  if (!created.ok) {
    throw new Error(`createMythosVault failed: ${created.error}`);
  }
  const userData = makeTestTmp('mh-ud');
  writeAppSettingsFile(userData);
  writeVaultSettingsFile(userData, {
    vaultRoot: created.storyVaultPath,
    notesVaultRoot: created.notesVaultPath,
    layoutMode: 'default',
    recentProjects: [
      {
        name: 'HandlerHarness',
        vaultRoot: created.storyVaultPath,
        notesVaultRoot: created.notesVaultPath,
        openedAt: new Date().toISOString(),
      },
    ],
  });
  return {
    parentDir,
    userData,
    mythosRoot: created.mythosRoot,
    storyVaultPath: created.storyVaultPath,
    notesVaultPath: created.notesVaultPath,
    created,
  };
}

export function storySceneFromManifest(storyVaultPath: string, mythosRoot: string): {
  storyId: string;
  chapterId: string;
  sceneId: string;
  sceneRelPath: string;
} {
  const manifest = scanMythosStoryVault(mythosRoot);
  const story = manifest.stories[0];
  if (!story) throw new Error('seed manifest has no story');
  const chapter = story.chapters[0];
  if (!chapter) throw new Error('seed manifest has no chapter');
  const scene = chapter.scenes[0];
  if (!scene) throw new Error('seed manifest has no scene');
  void storyVaultPath;
  return {
    storyId: story.id,
    chapterId: chapter.id,
    sceneId: scene.id,
    sceneRelPath: scene.path,
  };
}

export function readBytesUnderVault(vaultRoot: string, rel: string): Buffer {
  return fs.readFileSync(path.join(vaultRoot, rel));
}

export function manifestCachePath(storyVaultPath: string): string {
  return resolveManifestPath(storyVaultPath);
}

export function sceneProseOnDisk(storyVaultPath: string, sceneRelPath: string): string {
  return readSceneFile(storyVaultPath, sceneRelPath).prose;
}

export function manifestBytesExcludeProse(manifestPath: string, proseNeedle: string): boolean {
  const bytes = fs.readFileSync(manifestPath, 'utf-8');
  return !bytes.includes(proseNeedle);
}

/** Probe that `dir` refuses a direct write (POSIX). Fails the test if root/chmod noop bypasses. */
export function assertDirectoryWriteDenied(dir: string): void {
  const probe = path.join(dir, `.mythos-ro-probe-${process.pid}-${Date.now()}`);
  let denied = false;
  try {
    fs.writeFileSync(probe, 'probe');
  } catch {
    denied = true;
  }
  if (fs.existsSync(probe)) {
    try {
      fs.unlinkSync(probe);
    } catch {
      /* left for caller cleanup */
    }
  }
  if (!denied) {
    throw new Error(`expected write to be denied under ${dir} (probe write succeeded — chmod ineffective or running as root)`);
  }
}