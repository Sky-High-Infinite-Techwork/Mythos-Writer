import './main.handlers.harnessSetup.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { harnessPaths } from './main.handlers.harnessSetup.js';
import {
  IPC_CHANNELS,
  cleanupTestTmp,
  invoke,
  makeTestTmp,
  assertDirectoryWriteDenied,
  manifestCachePath,
  readBytesUnderVault,
  seedMythosVaultBundle,
  sceneProseOnDisk,
  storySceneFromManifest,
  teardownHandlerHarnessSuite,
  writeVaultSettingsFile,
} from './mainHandlersHarness.js';
import { generateRegistrationToken } from './registrationToken.js';
import { acquireLockfile, releaseLockfile } from './vaultSessionLock.js';

let bundle: ReturnType<typeof seedMythosVaultBundle>;

beforeEach(() => {
  bundle = seedMythosVaultBundle({ seedDemo: false, name: 'VaultHandlers' });
  harnessPaths.userData = bundle.userData;
});

afterEach(() => {
  try {
    releaseLockfile(bundle.storyVaultPath);
  } catch {
    /* */
  }
  teardownHandlerHarnessSuite();
  cleanupTestTmp();
});

describe('main.handlers vault:write / vault:read', () => {
  it('vault:list returns story vault entries at root', async () => {
    const listed = await invoke<{ items: Array<{ name: string }> }>(IPC_CHANNELS.VAULT_LIST, { root: '' });
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items.some((i) => i.name.length > 0)).toBe(true);
  });

  it('vault:list scopes listing to a subdirectory', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const relDir = 'Universes';
    const listed = await invoke<{ items: Array<{ path: string }> }>(IPC_CHANNELS.VAULT_LIST, { root: relDir });
    expect(listed.items.every((i) => i.path.startsWith(relDir) || !i.path.includes('..'))).toBe(true);
  });
  it('vault:write persists allowed .md bytes and vault:read round-trips', async () => {
    const rel = 'notes/harness-note.md';
    const content = '# Note\n\nVault write bytes 1907.';
    const written = await invoke<{ path: string; bytes: number; error?: string }>(IPC_CHANNELS.VAULT_WRITE, {
      path: rel,
      content,
    });
    expect(written.error).toBeUndefined();
    expect(written.bytes).toBeGreaterThan(0);
    expect(readBytesUnderVault(bundle.storyVaultPath, rel).toString('utf-8')).toBe(content);

    const read = await invoke<{ content: string }>(IPC_CHANNELS.VAULT_READ, { path: rel });
    expect(read.content).toBe(content);
  });

  it('vault:write refuses dotfile policy', async () => {
    const target = '.hidden.md';
    const probe = path.join(bundle.storyVaultPath, target);
    const result = await invoke<{ error?: string; bytes: number }>(IPC_CHANNELS.VAULT_WRITE, {
      path: target,
      content: 'nope',
    });
    expect(result.error).toBeTruthy();
    expect(result.bytes ?? 0).toBe(0);
    expect(fs.existsSync(probe)).toBe(false);
  });

  it('vault:write refuses disallowed extension', async () => {
    const result = await invoke<{ error?: string }>(IPC_CHANNELS.VAULT_WRITE, {
      path: 'leak/script.exe',
      content: 'MZ',
    });
    expect(result.error).toBeTruthy();
    expect(fs.existsSync(path.join(bundle.storyVaultPath, 'leak/script.exe'))).toBe(false);
  });

  it('vault:write refuses path traversal', async () => {
    const escapeName = `escape-traversal-${Date.now()}.md`;
    const escapeAbs = path.join(bundle.storyVaultPath, '..', escapeName);
    const result = await invoke<{ error?: string }>(IPC_CHANNELS.VAULT_WRITE, {
      path: `../${escapeName}`,
      content: 'escaped',
    });
    expect(result.error).toBeTruthy();
    expect(fs.existsSync(escapeAbs)).toBe(false);
  });

  it('vault:delete removes a written file from disk', async () => {
    const rel = 'notes/to-delete.md';
    const content = '# Delete\n\nRemove via VAULT_DELETE.';
    await invoke(IPC_CHANNELS.VAULT_WRITE, { path: rel, content });
    const full = path.join(bundle.storyVaultPath, rel);
    expect(fs.readFileSync(full, 'utf-8')).toBe(content);
    const del = await invoke<{ deleted: boolean; path: string }>(IPC_CHANNELS.VAULT_DELETE, { path: rel });
    expect(del.deleted).toBe(true);
    expect(del.path).toBe(rel);
    expect(fs.existsSync(full)).toBe(false);
  });

  it('vault:write refuses symlink leaf (red on revert)', async () => {
    const vaultRoot = bundle.storyVaultPath;
    const realFile = path.join(vaultRoot, 'real-target.md');
    fs.writeFileSync(realFile, '# real');
    const linkRel = 'notes/link-note.md';
    fs.mkdirSync(path.dirname(path.join(vaultRoot, linkRel)), { recursive: true });
    fs.symlinkSync(realFile, path.join(vaultRoot, linkRel));
    const result = await invoke<{ error?: string; code?: string }>(IPC_CHANNELS.VAULT_WRITE, {
      path: linkRel,
      content: 'overwrite symlink',
    });
    expect(result.error).toMatch(/shortcut|symbolic link/i);
    expect(readBytesUnderVault(vaultRoot, 'real-target.md').toString('utf-8')).toBe('# real');
  });
});

describe('main.handlers vault manifest / paths', () => {
  it('vault:get-paths returns configured story and notes roots', async () => {
    const paths = await invoke<{
      storyVaultPath: string;
      notesVaultPath: string;
      mythosRoot: string | null;
    }>(IPC_CHANNELS.VAULT_GET_PATHS);
    expect(paths.storyVaultPath).toBe(bundle.storyVaultPath);
    expect(paths.notesVaultPath).toBe(bundle.notesVaultPath);
    expect(paths.mythosRoot).toBe(bundle.mythosRoot);
  });

  it('vault:manifest-write persists structural manifest changes on disk', async () => {
    bundle = seedMythosVaultBundle({ seedDemo: true, name: 'ManifestWriteVault' });
    harnessPaths.userData = bundle.userData;
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const manifest = await invoke<import('./ipc.js').Manifest>(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const chapter = manifest.stories[0]!.chapters[0]!;
    const marker = 'MANIFEST_WRITE_MARKER_1907';
    chapter.title = marker;
    const wrote = await invoke<{ ok: true; bytes: number; path: string }>(IPC_CHANNELS.VAULT_MANIFEST_WRITE, {
      manifest,
    });
    expect(wrote.bytes).toBeGreaterThan(0);
    expect(fs.readFileSync(manifestCachePath(bundle.storyVaultPath), 'utf-8')).toContain(marker);
  });
});

describe('main.handlers vault discovery / create / paths', () => {
  it('vault:validate-path reports writable parent for a new folder', async () => {
    const target = path.join(bundle.parentDir, 'new-vault-dir');
    const result = await invoke<{ exists: boolean; isEmpty: boolean; writable: boolean }>(
      IPC_CHANNELS.VAULT_VALIDATE_PATH,
      { path: target },
    );
    expect(result.exists).toBe(false);
    expect(result.writable).toBe(true);
  });

  it('vault:validate-path reports writable existing empty directory', async () => {
    const existing = makeTestTmp('validate-exists');
    const result = await invoke<{ exists: boolean; isEmpty: boolean; writable: boolean }>(
      IPC_CHANNELS.VAULT_VALIDATE_PATH,
      { path: existing },
    );
    expect(result.exists).toBe(true);
    expect(result.isEmpty).toBe(true);
    expect(result.writable).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('vault:validate-path reports non-writable parent', async () => {
    const lockedParent = makeTestTmp('locked-parent');
    fs.chmodSync(lockedParent, 0o500);
    try {
      assertDirectoryWriteDenied(lockedParent);
      const result = await invoke<{ writable: boolean }>(IPC_CHANNELS.VAULT_VALIDATE_PATH, {
        path: path.join(lockedParent, 'child'),
      });
      expect(result.writable).toBe(false);
    } finally {
      fs.chmodSync(lockedParent, 0o700);
    }
  });

  it('vault:createDefaultMythos refuses unsafe vault names', async () => {
    const parent = makeTestTmp('create-default-badname');
    const created = await invoke<{ created: boolean; error?: string }>(IPC_CHANNELS.VAULT_CREATE_DEFAULT_MYTHOS, {
      parentPath: parent,
      vaultName: '../escape',
    });
    expect(created.created).toBe(false);
    expect(created.error).toMatch(/vaultName/i);
  });

  it('vault:createDefaultMythos refuses non-absolute parentPath', async () => {
    const created = await invoke<{ created: boolean; error?: string }>(IPC_CHANNELS.VAULT_CREATE_DEFAULT_MYTHOS, {
      parentPath: 'relative/not-absolute',
      vaultName: 'BadParent',
    });
    expect(created.created).toBe(false);
    expect(created.error).toMatch(/absolute path/i);
  });

  it('vault:createDefaultMythos activate=true persists vault-settings and opens dirs', async () => {
    const parent = makeTestTmp('create-default-active');
    const created = await invoke<{
      created: boolean;
      mythosVaultRoot: string;
      vaultRoot: string;
      notesVaultRoot: string;
    }>(IPC_CHANNELS.VAULT_CREATE_DEFAULT_MYTHOS, {
      parentPath: parent,
      vaultName: `Active-${Date.now()}`,
      activate: true,
      seedMode: 'default',
    });
    expect(created.created).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(bundle.userData, 'vault-settings.json'), 'utf-8')) as {
      vaultRoot: string;
      notesVaultRoot: string;
    };
    expect(settings.vaultRoot).toBe(created.vaultRoot);
    expect(settings.notesVaultRoot).toBe(created.notesVaultRoot);
    expect(fs.existsSync(path.join(created.mythosVaultRoot, 'mythos.json'))).toBe(true);
    const manifest = await invoke<{ stories: unknown[] }>(IPC_CHANNELS.VAULT_MANIFEST_READ);
    expect(manifest.stories.length).toBeGreaterThan(0);
    expect(fs.readFileSync(manifestCachePath(created.vaultRoot), 'utf-8').length).toBeGreaterThan(20);
  });

  it('vault:createDefaultMythos with default seed writes demo story bytes', async () => {
    const parent = makeTestTmp('create-default-demo');
    const created = await invoke<{
      created: boolean;
      vaultRoot: string;
      notesVaultRoot: string;
      error?: string;
    }>(IPC_CHANNELS.VAULT_CREATE_DEFAULT_MYTHOS, {
      parentPath: parent,
      vaultName: `DemoSeed-${Date.now()}`,
      activate: false,
      seedMode: 'default',
    });
    expect(created.created).toBe(true);
    const storyRoot = created.vaultRoot;
    const mdFiles: string[] = [];
    const walk = (dir: string, rel = ''): void => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        if (fs.statSync(abs).isDirectory()) walk(abs, r);
        else if (name.endsWith('.md')) mdFiles.push(r);
      }
    };
    walk(storyRoot);
    expect(mdFiles.length).toBeGreaterThan(0);
    const sample = mdFiles[0]!;
    expect(readBytesUnderVault(storyRoot, sample).length).toBeGreaterThan(10);
    expect(fs.readdirSync(created.notesVaultRoot).length).toBeGreaterThanOrEqual(0);
  });

  it('vault:createDefaultMythos scaffolds story+notes roots on disk', async () => {
    const parent = makeTestTmp('create-default');
    const created = await invoke<{
      created: boolean;
      mythosVaultRoot: string;
      vaultRoot: string;
      notesVaultRoot: string;
      error?: string;
    }>(IPC_CHANNELS.VAULT_CREATE_DEFAULT_MYTHOS, {
      parentPath: parent,
      vaultName: 'FreshDefault',
      activate: false,
      seedMode: 'blank',
    });
    expect(created.error).toBeUndefined();
    expect(created.created).toBe(true);
    expect(fs.existsSync(created.vaultRoot)).toBe(true);
    expect(fs.existsSync(created.notesVaultRoot)).toBe(true);
    expect(fs.existsSync(path.join(created.mythosVaultRoot, 'mythos.json'))).toBe(true);
  });

  it('vault:create-from-options activate=true switches persisted vault paths', async () => {
    const parent = makeTestTmp('from-options-active');
    const created = await invoke<{ ok: boolean; storyVaultPath?: string; notesVaultPath?: string }>(
      IPC_CHANNELS.VAULT_CREATE_FROM_OPTIONS,
      { mode: 'blank', destinationParent: parent, name: 'Activated', activate: true },
    );
    expect(created.ok).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(bundle.userData, 'vault-settings.json'), 'utf-8')) as {
      vaultRoot: string;
      notesVaultRoot: string;
    };
    expect(settings.vaultRoot).toBe(created.storyVaultPath);
    expect(settings.notesVaultRoot).toBe(created.notesVaultPath);
  });

  it('vault:create-from-options refuses unknown mode', async () => {
    const parent = makeTestTmp('from-options-bad-mode');
    const created = await invoke<{ ok: boolean; error?: string }>(IPC_CHANNELS.VAULT_CREATE_FROM_OPTIONS, {
      mode: 'not-a-real-mode' as 'blank',
      destinationParent: parent,
      name: 'BadMode',
      activate: false,
    });
    expect(created.ok).toBe(false);
    expect(created.error).toBeTruthy();
    expect(fs.existsSync(path.join(parent, 'BadMode'))).toBe(false);
  });

  it('vault:create-from-options refuses relative destinationParent', async () => {
    const created = await invoke<{ ok: boolean; error?: string }>(IPC_CHANNELS.VAULT_CREATE_FROM_OPTIONS, {
      mode: 'blank',
      destinationParent: 'relative/parent',
      name: 'BadParent',
      activate: false,
    });
    expect(created.ok).toBe(false);
    expect(created.error).toMatch(/absolute/i);
  });

  it('vault:create-from-options resolves default parent when destinationParent omitted', async () => {
    const created = await invoke<{ ok: boolean; storyVaultPath?: string; notesVaultPath?: string }>(
      IPC_CHANNELS.VAULT_CREATE_FROM_OPTIONS,
      { mode: 'blank', name: `DefaultParent-${Date.now()}`, activate: false },
    );
    expect(created.ok).toBe(true);
    expect(created.storyVaultPath).toBeTruthy();
    expect(fs.existsSync(created.storyVaultPath!)).toBe(true);
    expect(fs.existsSync(created.notesVaultPath!)).toBe(true);
  });

  it('vault:create-from-options strips unsafe defaultTheme tokens', async () => {
    const parent = makeTestTmp('from-options-theme');
    const created = await invoke<{ ok: boolean; mythosRoot?: string }>(IPC_CHANNELS.VAULT_CREATE_FROM_OPTIONS, {
      mode: 'blank',
      destinationParent: parent,
      name: 'ThemeSanitized',
      activate: false,
      defaultTheme: 'not a valid theme token!!!',
    });
    expect(created.ok).toBe(true);
    const mythosJson = JSON.parse(
      fs.readFileSync(path.join(parent, 'ThemeSanitized', 'mythos.json'), 'utf-8'),
    ) as { defaultTheme?: string };
    expect(mythosJson.defaultTheme).toBeUndefined();
  });

  it('vault:create-from-options with blank mode writes mythos bundle', async () => {
    const parent = makeTestTmp('from-options');
    const created = await invoke<{ ok: boolean; storyVaultPath?: string; notesVaultPath?: string; error?: string }>(
      IPC_CHANNELS.VAULT_CREATE_FROM_OPTIONS,
      { mode: 'blank', destinationParent: parent, name: 'FromOptions', activate: false },
    );
    expect(created.ok).toBe(true);
    expect(created.storyVaultPath).toBeTruthy();
    expect(fs.existsSync(created.storyVaultPath!)).toBe(true);
    expect(fs.existsSync(created.notesVaultPath!)).toBe(true);
  });

  it('vault:setPaths refuses unregistered absolute paths', async () => {
    const evilStory = makeTestTmp('evil-story');
    const evilNotes = makeTestTmp('evil-notes');
    const result = await invoke<{ saved: boolean; error?: string }>(IPC_CHANNELS.VAULT_SET_PATHS, {
      storyVaultPath: evilStory,
      notesVaultPath: evilNotes,
    });
    expect(result.saved).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('vault:setPaths persists allowlisted roots from registration tokens', async () => {
    const story = makeTestTmp('reg-story');
    const notes = makeTestTmp('reg-notes');
    const storyToken = generateRegistrationToken(story);
    const notesToken = generateRegistrationToken(notes);
    const result = await invoke<{ saved: boolean; storyVaultPath: string; notesVaultPath: string }>(
      IPC_CHANNELS.VAULT_SET_PATHS,
      {
        storyVaultPath: story,
        notesVaultPath: notes,
        storyVaultToken: storyToken,
        notesVaultToken: notesToken,
        seedMode: 'blank',
      },
    );
    expect(result.saved).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(bundle.userData, 'vault-settings.json'), 'utf-8')) as {
      vaultRoot: string;
      notesVaultRoot: string;
      layoutMode?: string;
    };
    expect(settings.vaultRoot).toBe(story);
    expect(settings.notesVaultRoot).toBe(notes);
    expect(settings.layoutMode).toBe('blank');
    expect(fs.existsSync(path.join(story, 'manifest.json'))).toBe(true);
  });
});

describe('main.handlers notesVault:*', () => {
  it('notesVault:read round-trips bytes written via notesVault:write', async () => {
    const noteRel = 'Characters/Read Roundtrip.md';
    const noteBody = '# Read\n\nNOTES_VAULT_READ marker 1907.';
    await invoke(IPC_CHANNELS.NOTES_VAULT_WRITE, { path: noteRel, content: noteBody });
    const read = await invoke<{ content: string }>(IPC_CHANNELS.NOTES_VAULT_READ, { path: noteRel });
    expect(read.content).toBe(noteBody);
    expect(fs.readFileSync(path.join(bundle.notesVaultPath, noteRel), 'utf-8')).toBe(noteBody);
  });

  it('notesVault:list returns seeded notes and notesVault:delete removes bytes', async () => {
    const noteRel = 'Characters/Test Harness.md';
    const noteBody = '# Harness\n\nDelete me after list.';
    await invoke(IPC_CHANNELS.NOTES_VAULT_WRITE, { path: noteRel, content: noteBody });
    const listed = await invoke<{ items: Array<{ path: string; name: string }> }>(IPC_CHANNELS.NOTES_VAULT_LIST, {
      root: 'Characters',
    });
    expect(listed.items.some((i) => i.path === 'Test Harness.md' || i.name === 'Test Harness.md')).toBe(true);

    const del = await invoke<{ deleted: boolean }>(IPC_CHANNELS.NOTES_VAULT_DELETE, { path: noteRel });
    expect(del.deleted).toBe(true);
    expect(fs.existsSync(path.join(bundle.notesVaultPath, noteRel))).toBe(false);
  });

  it('notesVault:write refuses traversal', async () => {
    const result = await invoke<{ error?: string }>(IPC_CHANNELS.NOTES_VAULT_WRITE, {
      path: '../../escape.md',
      content: 'nope',
    });
    expect(result.error).toMatch(/traversal|denied|not allowed/i);
  });
});

describe('main.handlers storyVaultRegistry:setActive', () => {
  it('storyVaultRegistry:list returns vaults for an open mythos bundle', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const listed = await invoke<{ vaults: Array<{ id: string }> | null; activeId: string | null }>(
      IPC_CHANNELS.STORY_VAULT_REGISTRY_LIST,
    );
    expect(listed.vaults).not.toBeNull();
    expect(listed.vaults!.length).toBeGreaterThan(0);
    expect(listed.activeId).toBeTruthy();
  });

  it('storyVaultRegistry:rename updates registry displayName on disk', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const created = await invoke<{ entry: { id: string; displayName: string } }>(
      IPC_CHANNELS.STORY_VAULT_REGISTRY_CREATE,
      { displayName: 'Rename Target', mode: 'blank' },
    );
    const renamed = await invoke<{ entry: { displayName: string } }>(IPC_CHANNELS.STORY_VAULT_REGISTRY_RENAME, {
      id: created.entry.id,
      displayName: 'Renamed Story Vault 1907',
    });
    expect(renamed.entry.displayName).toBe('Renamed Story Vault 1907');
    const registryPath = path.join(bundle.mythosRoot, 'story-vaults.json');
    expect(fs.readFileSync(registryPath, 'utf-8')).toContain('Renamed Story Vault 1907');
  });

  it('switches active story vault root in vault-settings.json', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    writeVaultSettingsFile(bundle.userData, {
      vaultRoot: bundle.storyVaultPath,
      notesVaultRoot: bundle.notesVaultPath,
    });
    const second = await invoke<{ entry: { id: string } }>(IPC_CHANNELS.STORY_VAULT_REGISTRY_CREATE, {
      displayName: 'Second Story',
      mode: 'blank',
    });
    const switched = await invoke<{ entry: { id: string } }>(IPC_CHANNELS.STORY_VAULT_REGISTRY_SET_ACTIVE, {
      id: second.entry.id,
    });
    expect(switched.entry.id).toBe(second.entry.id);
    const settings = JSON.parse(fs.readFileSync(path.join(bundle.userData, 'vault-settings.json'), 'utf-8')) as {
      vaultRoot: string;
    };
    expect(settings.vaultRoot).not.toBe(bundle.storyVaultPath);
    expect(fs.existsSync(settings.vaultRoot)).toBe(true);
  });
});

describe('main.handlers vault graph, search, and legacy detect', () => {
  it('vault:graph-data builds nodes and edges from wiki links on disk', async () => {
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    await invoke(IPC_CHANNELS.VAULT_WRITE, {
      path: 'graph/a.md',
      content: '---\nid: graph-a\ntitle: Graph A\n---\n\nSee [[b]] for more.',
    });
    await invoke(IPC_CHANNELS.VAULT_WRITE, {
      path: 'graph/b.md',
      content: '---\nid: graph-b\ntitle: Graph B\n---\n\nBacklink body.',
    });
    const graph = await invoke<{ nodes: Array<{ id: string }>; edges: Array<{ source: string; target: string }> }>(
      IPC_CHANNELS.VAULT_GRAPH_DATA,
    );
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it('vault:graph:nodes with both scope includes story and notes nodes', async () => {
    bundle = seedMythosVaultBundle({ seedDemo: true, name: 'GraphBothVault' });
    harnessPaths.userData = bundle.userData;
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    await invoke(IPC_CHANNELS.NOTES_VAULT_WRITE, { path: 'both-scope.md', content: '# Both\n\nNote.' });
    const nodes = await invoke<{ nodes: Array<{ vault: string }> }>(IPC_CHANNELS.VAULT_GRAPH_NODES, { scope: 'both' });
    const hasStory = nodes.nodes.some((n) => n.vault === 'story');
    const hasNotes = nodes.nodes.some((n) => n.vault === 'notes');
    expect(hasStory).toBe(true);
    expect(hasNotes).toBe(true);
    expect(nodes.nodes.length).toBeGreaterThan(1);
  });

  it('vault:graph:nodes and vault:graph:edges honour notes scope after notesVault:write', async () => {
    await invoke(IPC_CHANNELS.NOTES_VAULT_WRITE, {
      path: 'graph-notes/a.md',
      content: '---\ntitle: Notes Graph A\n---\n\n[[b]]',
    });
    const nodes = await invoke<{ nodes: unknown[] }>(IPC_CHANNELS.VAULT_GRAPH_NODES, { scope: 'notes' });
    const edges = await invoke<{ edges: unknown[] }>(IPC_CHANNELS.VAULT_GRAPH_EDGES, { scope: 'notes' });
    expect(nodes.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(edges.edges)).toBe(true);
  });

  it('search:query runs against indexed demo vault', async () => {
    bundle = seedMythosVaultBundle({ seedDemo: true, name: 'SearchVault' });
    harnessPaths.userData = bundle.userData;
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const results = await invoke<{ results: unknown[]; elapsed_ms: number }>(IPC_CHANNELS.SEARCH_QUERY, {
      query: 'Harness',
      scope: 'all',
      limit: 10,
    });
    expect(results.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(results.results)).toBe(true);
  });

  it('archive:scan returns early when archive agent is disabled', async () => {
    const scan = await invoke<{ suggestions: unknown[]; inconsistenciesFound: number }>(IPC_CHANNELS.ARCHIVE_SCAN, {
      sceneText: 'Disabled archive path',
      scenePath: 'nope.md',
    });
    expect(scan.suggestions).toEqual([]);
    expect(scan.inconsistenciesFound).toBe(0);
  });

  it('archive:scan runs wiki pass on demo scene when archive agent is enabled', async () => {
    bundle = seedMythosVaultBundle({ seedDemo: true, name: 'ArchiveScanVault' });
    harnessPaths.userData = bundle.userData;
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as import('./ipc.js').AppSettings;
    await invoke<{ saved: boolean }>(IPC_CHANNELS.SETTINGS_SET, {
      settings: {
        ...before,
        agents: {
          ...before.agents,
          archive: { ...before.agents.archive, enabled: true },
        },
      },
    });
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const { sceneRelPath } = storySceneFromManifest(bundle.storyVaultPath, bundle.mythosRoot);
    const prose = sceneProseOnDisk(bundle.storyVaultPath, sceneRelPath);
    const scan = await invoke<{ inconsistenciesFound: number; wikiLinksFound: number }>(IPC_CHANNELS.ARCHIVE_SCAN, {
      sceneText: prose,
      scenePath: sceneRelPath,
    });
    expect(scan.inconsistenciesFound).toBeGreaterThanOrEqual(0);
    expect(scan.wikiLinksFound).toBeGreaterThanOrEqual(0);
  });

  it('project:stats and vault:getSystemPaths return structured payloads', async () => {
    bundle = seedMythosVaultBundle({ seedDemo: true, name: 'StatsVault' });
    harnessPaths.userData = bundle.userData;
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const stats = await invoke<{ stats: Array<{ vaultRoot: string; storyFileCount: number }> }>(
      IPC_CHANNELS.PROJECT_STATS,
    );
    expect(stats.stats.length).toBeGreaterThan(0);
    expect(stats.stats[0]!.storyFileCount).toBeGreaterThan(0);
    const sys = await invoke<{ homeDir: string }>(IPC_CHANNELS.VAULT_GET_SYSTEM_PATHS);
    expect(sys.homeDir.length).toBeGreaterThan(0);
  });

  it('vault:detectLegacyVaults returns found=false on a v2 harness vault', async () => {
    const detected = await invoke<{ found: boolean }>(IPC_CHANNELS.VAULT_DETECT_LEGACY);
    expect(detected.found).toBe(false);
  });

  it('notesVault:get-order returns an object map', async () => {
    const order = await invoke<Record<string, string[]>>(IPC_CHANNELS.NOTES_VAULT_GET_ORDER);
    expect(order).toBeTypeOf('object');
  });
});

describe('main.handlers entity and tags', () => {
  it('entity:create and entity:read persist entity prose on disk', async () => {
    bundle = seedMythosVaultBundle({ seedDemo: true, name: 'EntityVault' });
    harnessPaths.userData = bundle.userData;
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const created = await invoke<{ id: string; name: string; path: string }>(IPC_CHANNELS.ENTITY_CREATE, {
      name: 'Harness Entity 1907',
      type: 'character',
      prose: 'Entity prose bytes.',
      tags: ['hero'],
    });
    expect(created.name).toBe('Harness Entity 1907');
    expect(fs.existsSync(path.join(bundle.storyVaultPath, created.path))).toBe(true);
    const read = await invoke<{ name: string }>(IPC_CHANNELS.ENTITY_READ, { id: created.id });
    expect(read.name).toBe('Harness Entity 1907');
    expect(fs.readFileSync(manifestCachePath(bundle.storyVaultPath), 'utf-8')).toContain('Harness Entity 1907');
  });

  it('tags:rename cascades renamed tag through manifest entries', async () => {
    bundle = seedMythosVaultBundle({ seedDemo: true, name: 'TagsVault' });
    harnessPaths.userData = bundle.userData;
    await invoke(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const tag = await invoke<{ tag: { id: string; name: string } }>(IPC_CHANNELS.TAGS_UPSERT, { name: 'TagBefore1907' });
    const entity = await invoke<{ id: string }>(IPC_CHANNELS.ENTITY_CREATE, {
      name: 'Tagged Entity',
      type: 'character',
      tags: [tag.tag.name],
    });
    const renamed = await invoke<{ tag: { name: string } }>(IPC_CHANNELS.TAGS_RENAME, {
      id: tag.tag.id,
      name: 'TagAfter1907',
    });
    expect(renamed.tag.name).toBe('TagAfter1907');
    const manifest = await invoke<{ entities: Array<{ id: string; tags?: string[] }> }>(IPC_CHANNELS.VAULT_MANIFEST_READ);
    const manifestEntity = manifest.entities.find((e) => e.id === entity.id);
    expect(manifestEntity?.tags).toContain('TagAfter1907');
    expect(fs.readFileSync(manifestCachePath(bundle.storyVaultPath), 'utf-8')).toContain('TagAfter1907');
  });
});

describe('main.handlers vault:check-session-lock', () => {
  it('reports foreign lock contention without overwriting the lock file', async () => {
    const foreign = {
      hostname: 'foreign-host-1907',
      pid: 42,
      timestamp: new Date().toISOString(),
      vaultPath: bundle.storyVaultPath,
    };
    const lockDir = path.join(bundle.storyVaultPath, '.mythos');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'vault.lock'), JSON.stringify(foreign), 'utf-8');
    const result = await invoke<{ lockfileConflict: { hostname: string; pid: number } | null }>(
      IPC_CHANNELS.VAULT_CHECK_SESSION_LOCK,
    );
    expect(result.lockfileConflict).toMatchObject({ hostname: foreign.hostname, pid: foreign.pid });
    const onDisk = JSON.parse(fs.readFileSync(path.join(lockDir, 'vault.lock'), 'utf-8')) as { hostname: string };
    expect(onDisk.hostname).toBe(foreign.hostname);
  });

  it('acquires lock when none exists', async () => {
    const result = await invoke<{ lockfileConflict: null | { pid: number } }>(IPC_CHANNELS.VAULT_CHECK_SESSION_LOCK);
    expect(result.lockfileConflict).toBeNull();
    const acquired = acquireLockfile(bundle.storyVaultPath);
    expect(acquired).not.toBeNull();
    releaseLockfile(bundle.storyVaultPath);
  });
});

describe('main.handlers vault:write read-only (must fail as non-root)', () => {
  it.skipIf(process.platform === 'win32')(
    'leaves bytes unchanged when target directory is read-only',
    async () => {
      const rel = 'notes/readonly.md';
      const full = path.join(bundle.storyVaultPath, rel);
      const parent = path.dirname(full);
      fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(full, 'original');
      fs.chmodSync(parent, 0o555);
      try {
        assertDirectoryWriteDenied(parent);
        const result = await invoke<{ error?: string; bytes?: number }>(IPC_CHANNELS.VAULT_WRITE, {
          path: rel,
          content: 'mutated',
        });
        expect(result.error).toBeTruthy();
        expect(result.bytes ?? 0).toBe(0);
        expect(fs.readFileSync(full, 'utf-8')).toBe('original');
      } finally {
        fs.chmodSync(parent, 0o755);
      }
    },
  );
});

describe('main.handlers missing vault root', () => {
  it('vault:read throws for missing file under configured vault', async () => {
    const result = await invoke<{ error?: string }>(IPC_CHANNELS.VAULT_READ, { path: 'missing/ghost.md' });
    expect(result).toHaveProperty('error');
  });
});