import './main.handlers.harnessSetup.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { harnessPaths } from './main.handlers.harnessSetup.js';
import {
  IPC_CHANNELS,
  cleanupTestTmp,
  invoke,
  makeTestTmp,
  assertDirectoryWriteDenied,
  manifestBytesExcludeProse,
  manifestCachePath,
  readBytesUnderVault,
  sceneProseOnDisk,
  seedMythosVaultBundle,
  teardownHandlerHarnessSuite,
  storySceneFromManifest,
  writeAppSettingsFile,
  writeVaultSettingsFile,
} from './mainHandlersHarness.js';
import * as vaultModule from './vault.js';
import { defaultManifest, writeManifest, writeSceneFile } from './vault.js';
import { releaseLockfile } from './vaultSessionLock.js';

let bundle: ReturnType<typeof seedMythosVaultBundle>;

beforeEach(() => {
  bundle = seedMythosVaultBundle({ seedDemo: true });
  harnessPaths.userData = bundle.userData;
});

afterEach(() => {
  try {
    releaseLockfile(bundle.storyVaultPath);
  } catch {
    /* no lock */
  }
  teardownHandlerHarnessSuite();
  cleanupTestTmp();
});

describe('main.handlers scene:*', () => {
  it('chapter:get returns null for an unknown chapter id', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const got = await invoke<{ chapter: null | { id: string } }>(IPC_CHANNELS.CHAPTER_GET, {
      chapterId: '00000000-0000-4000-8000-000000000099',
    });
    expect(got.chapter).toBeNull();
  });

  it('scene:get returns null prose for unknown sceneId', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const got = await invoke<{ scene: null; prose: string }>(IPC_CHANNELS.SCENE_GET, {
      sceneId: '00000000-0000-4000-8000-000000000099',
    });
    expect(got.scene).toBeNull();
    expect(got.prose).toBe('');
  });

  it('scene:get returns empty prose when the scene file is missing on disk', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const { sceneId, sceneRelPath } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    fs.unlinkSync(path.join(bundle.storyVaultPath, sceneRelPath));
    const got = await invoke<{ scene: { id: string } | null; prose: string }>(IPC_CHANNELS.SCENE_GET, { sceneId });
    expect(got.scene?.id).toBe(sceneId);
    expect(got.prose).toBe('');
  });

  it('scene:get returns on-disk prose for a manifest scene', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const { sceneId } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    const got = await invoke<{ scene: { id: string; path: string } | null; prose: string }>(
      IPC_CHANNELS.SCENE_GET,
      { sceneId },
    );
    expect(got.scene?.id).toBe(sceneId);
    expect(got.prose.length).toBeGreaterThan(0);
    const scenePath = got.scene!.path;
    const disk = sceneProseOnDisk(bundle.storyVaultPath, scenePath);
    expect(got.prose).toBe(disk);
  });

  it('scene:get falls back to flat manifest.scenes on legacy vault layout', async () => {
    const legacyRoot = makeTestTmp('legacy-flat');
    const userData = makeTestTmp('legacy-flat-ud');
    harnessPaths.userData = userData;
    const now = new Date().toISOString();
    const scene = {
      id: 'flat-scene-1907',
      title: 'Flat Scene',
      path: 'flat-scene.md',
      order: 0,
      blocks: [],
      createdAt: now,
      updatedAt: now,
    };
    const manifest = defaultManifest(legacyRoot);
    manifest.scenes = [scene];
    writeManifest(path.join(legacyRoot, 'manifest.json'), manifest);
    writeSceneFile(legacyRoot, scene.path, {
      id: scene.id,
      title: scene.title,
      order: 0,
      prose: 'Flat manifest prose.',
    });
    writeAppSettingsFile(userData);
    writeVaultSettingsFile(userData, { vaultRoot: legacyRoot, layoutMode: 'blank' });
    const got = await invoke<{ scene: { id: string } | null; prose: string }>(IPC_CHANNELS.SCENE_GET, {
      sceneId: scene.id,
    });
    expect(got.scene?.id).toBe(scene.id);
    expect(got.prose).toBe('Flat manifest prose.');
  });

  it('scene:get can load a second seeded scene (additional branch coverage)', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const manifest = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    const listed = await invoke<{ scenes: Array<{ id: string }> }>(IPC_CHANNELS.SCENE_LIST, {
      chapterId: manifest.chapterId,
    });
    const secondId = listed.scenes[1]?.id;
    expect(secondId).toBeTruthy();
    const got = await invoke<{ scene: { id: string } | null; prose: string }>(IPC_CHANNELS.SCENE_GET, {
      sceneId: secondId!,
    });
    expect(got.scene?.id).toBe(secondId);
    expect(got.prose.length).toBeGreaterThan(0);
  });

  it('scene:save writes prose bytes, scene:get round-trips, manifest stays structure-only', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const { sceneId, sceneRelPath } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    const proseMarker = 'UNIQUE_PROSE_MARKER_1907';
    const newProse = `Harness save prose.\n\nSecond paragraph with ${proseMarker}.`;
    const saved = await invoke<{ scene: { id: string; path: string } }>(IPC_CHANNELS.SCENE_SAVE, {
      sceneId,
      prose: newProse,
      intent: 'save',
    });
    expect(saved).toMatchObject({ scene: { id: sceneId } });
    const mdBytes = readBytesUnderVault(bundle.storyVaultPath, sceneRelPath).toString('utf-8');
    expect(mdBytes).toContain(newProse);

    const roundTrip = await invoke<{ prose: string }>(IPC_CHANNELS.SCENE_GET, { sceneId });
    expect(roundTrip.prose).toBe(newProse);

    const cachePath = manifestCachePath(bundle.storyVaultPath);
    expect(fs.existsSync(cachePath)).toBe(true);
    expect(manifestBytesExcludeProse(cachePath, proseMarker)).toBe(true);
  });

  it('scene:save reuses in-memory manifest cache across rapid back-to-back saves', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const { sceneId, sceneRelPath } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    const title = 'Harness Scene Title 1907';
    const marker = 'CACHE_BACK_TO_BACK_1907';
    const firstProse = `Initial prose.\n\n${marker}`;
    const readSpy = vi.spyOn(vaultModule, 'readManifest');
    try {
      const first = await invoke<{ scene?: { title: string }; error?: string }>(IPC_CHANNELS.SCENE_SAVE, {
        sceneId,
        prose: firstProse,
        title,
        customFields: { harness1907: 'alpha' },
      });
      expect(first.error).toBeUndefined();
      expect(first.scene?.title).toBe(title);
      expect(readSpy).toHaveBeenCalledTimes(1);
      readSpy.mockClear();

      const secondProse = `${firstProse}\n\nSecond paragraph ${marker}-2`;
      const second = await invoke<{ error?: string }>(IPC_CHANNELS.SCENE_SAVE, {
        sceneId,
        prose: secondProse,
        intent: 'auto',
      });
      expect(second.error).toBeUndefined();
      expect(readSpy).toHaveBeenCalledTimes(0);
    } finally {
      readSpy.mockRestore();
    }
    const afterSecond = readBytesUnderVault(bundle.storyVaultPath, sceneRelPath).toString('utf-8');
    expect(afterSecond).toContain(`${marker}-2`);
    expect(afterSecond).toContain('harness1907');
  });

  it('scene:save syncs entity:// markdown links into scene_entity_links rows', async () => {
    const mentionEntityId = 'ent_harness1907';
    await invoke(IPC_CHANNELS.VAULT_WRITE, {
      path: 'entities/characters/ent_harness1907.md',
      content: `---\nid: ${mentionEntityId}\nname: Harness Mention Entity\ntype: character\n---\n\nCast.`,
    });
    const listed = await invoke<{ entities: Array<{ id: string }> }>(IPC_CHANNELS.ENTITY_LIST, {});
    const { sceneId } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    expect(listed.entities.some((e) => e.id === mentionEntityId)).toBe(true);
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    await invoke(IPC_CHANNELS.ENTITY_UPDATE, { id: mentionEntityId, name: 'Harness Mention Entity' });
    const proseWithMention = `Opening with mention. [Elara](entity://${mentionEntityId}) continues here.`;
    const saved = await invoke<{ error?: string }>(IPC_CHANNELS.SCENE_SAVE, {
      sceneId,
      prose: proseWithMention,
      intent: 'save',
    });
    expect(saved.error).toBeUndefined();
    const links = await invoke<{ links: Array<{ sceneId: string; entityId: string; linkKind: string }> }>(
      IPC_CHANNELS.SCENE_ENTITY_LINKS_LIST,
      { sceneId },
    );
    expect(links.links.some((l) => l.entityId === mentionEntityId && l.linkKind === 'mention')).toBe(true);
  });

  it('scene:save refuses unknown scene id without mutating disk', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const { sceneRelPath } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    const before = readBytesUnderVault(bundle.storyVaultPath, sceneRelPath);
    const result = await invoke<{ error?: string }>(IPC_CHANNELS.SCENE_SAVE, {
      sceneId: '00000000-0000-4000-8000-000000000000',
      prose: 'must not land',
    });
    expect(result).toHaveProperty('error');
    const after = readBytesUnderVault(bundle.storyVaultPath, sceneRelPath);
    expect(after.equals(before)).toBe(true);
  });

  it('chapter:list, chapter:get, and chapter:save persist title bytes in manifest', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const { storyId, chapterId } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    const listed = await invoke<{ chapters: Array<{ id: string; title: string }> }>(IPC_CHANNELS.CHAPTER_LIST, {
      storyId,
    });
    expect(listed.chapters.some((c) => c.id === chapterId)).toBe(true);
    const got = await invoke<{ chapter: { id: string; title: string; order: number } | null }>(
      IPC_CHANNELS.CHAPTER_GET,
      { chapterId },
    );
    expect(got.chapter?.id).toBe(chapterId);
    const manifestPath = manifestCachePath(bundle.storyVaultPath);
    const title = 'Harness Chapter Title 1907';
    const saved = await invoke<{ chapter: { title: string } }>(IPC_CHANNELS.CHAPTER_SAVE, {
      chapterId,
      title,
      order: got.chapter!.order,
    });
    expect(saved.chapter.title).toBe(title);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toContain(title);
  });

  it('chapter:create adds a chapter directory and manifest entry', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const { storyId } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    const title = 'Harness Created Chapter 1907';
    const created = await invoke<{ id: string; title: string; path: string }>(IPC_CHANNELS.CHAPTER_CREATE, {
      storyId,
      title,
      order: 50,
    });
    expect(created.title).toBe(title);
    expect(fs.existsSync(path.join(bundle.storyVaultPath, created.path))).toBe(true);
    expect(fs.readFileSync(manifestCachePath(bundle.storyVaultPath), 'utf-8')).toContain(title);
  });

  it('scene:rename updates manifest title without changing scene prose file', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const { sceneId, sceneRelPath } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    const proseBefore = readBytesUnderVault(bundle.storyVaultPath, sceneRelPath);
    const renamed = 'Renamed Scene Harness 1907';
    const result = await invoke<{ scene: { title: string } }>(IPC_CHANNELS.SCENE_RENAME, {
      sceneId,
      title: renamed,
    });
    expect(result.scene.title).toBe(renamed);
    expect(fs.readFileSync(manifestCachePath(bundle.storyVaultPath), 'utf-8')).toContain(renamed);
    expect(readBytesUnderVault(bundle.storyVaultPath, sceneRelPath)).toEqual(proseBefore);
  });

  it('scene:create writes a new scene file and lists it', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const { storyId, chapterId } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    const created = await invoke<{ id: string; path: string; title: string }>(IPC_CHANNELS.SCENE_CREATE, {
      storyId,
      chapterId,
      title: 'Harness Created Scene',
      order: 99,
    });
    expect(created.title).toBe('Harness Created Scene');
    expect(created.path).toMatch(/\.md$/);
    const bytes = readBytesUnderVault(bundle.storyVaultPath, created.path);
    expect(bytes.length).toBeGreaterThan(10);
    expect(bytes.toString('utf-8')).toContain('Harness Created Scene');

    const listed = await invoke<{ scenes: Array<{ id: string }> }>(IPC_CHANNELS.SCENE_LIST, { chapterId });
    expect(listed.scenes.some((s) => s.id === created.id)).toBe(true);
  });

  it('scene:save rejects traversal via scene path in manifest (handler calls safePath)', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const manifestPath = manifestCachePath(bundle.storyVaultPath);
    const manifestBefore = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBefore.toString('utf-8')) as {
      stories: Array<{ chapters: Array<{ scenes: Array<{ id: string; path: string }> }> }>;
    };
    const evilScene = manifest.stories[0]!.chapters[0]!.scenes[0]!;
    const originalSceneRel = evilScene.path;
    const sceneBytesBefore = readBytesUnderVault(bundle.storyVaultPath, originalSceneRel);
    const escapeAbs = path.join(bundle.storyVaultPath, '..', 'outside-escape.md');
    evilScene.path = '../outside-escape.md';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    try {
      const result = await invoke<{ error?: string; scene?: unknown }>(IPC_CHANNELS.SCENE_SAVE, {
        sceneId: evilScene.id,
        prose: 'TRAVERSAL_ESCAPE_MARKER_1907',
      });
      expect(result.error).toBeTruthy();
      expect(result.scene).toBeUndefined();
      expect(readBytesUnderVault(bundle.storyVaultPath, originalSceneRel)).toEqual(sceneBytesBefore);
      expect(fs.existsSync(escapeAbs)).toBe(false);
    } finally {
      fs.writeFileSync(manifestPath, manifestBefore);
    }
  });
});

describe('main.handlers scene:* — read-only guard (must fail as non-root)', () => {
  it.skipIf(process.platform === 'win32')(
    'read-only scene file blocks save and leaves bytes unchanged',
    async () => {
      await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
      const { sceneId, sceneRelPath } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
      const full = path.join(bundle.storyVaultPath, sceneRelPath);
      const before = fs.readFileSync(full);
      const sceneDir = path.dirname(full);
      fs.chmodSync(sceneDir, 0o555);
      try {
        assertDirectoryWriteDenied(sceneDir);
        const result = await invoke<{ error?: string; scene?: unknown }>(IPC_CHANNELS.SCENE_SAVE, {
          sceneId,
          prose: 'SHOULD NOT PERSIST ON READONLY',
        });
        expect(result.error).toBeTruthy();
        expect(result.scene).toBeUndefined();
        expect(fs.readFileSync(full).equals(before)).toBe(true);
      } finally {
        fs.chmodSync(sceneDir, 0o755);
      }
    },
  );
});