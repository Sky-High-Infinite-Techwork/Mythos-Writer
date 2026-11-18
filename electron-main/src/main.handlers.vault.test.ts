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
  readBytesUnderVault,
  seedMythosVaultBundle,
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
      seedMode: 'blank',
    });
    expect(created.created).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(bundle.userData, 'vault-settings.json'), 'utf-8')) as {
      vaultRoot: string;
      notesVaultRoot: string;
    };
    expect(settings.vaultRoot).toBe(created.vaultRoot);
    expect(settings.notesVaultRoot).toBe(created.notesVaultRoot);
    expect(fs.existsSync(path.join(created.mythosVaultRoot, 'mythos.json'))).toBe(true);
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
    };
    expect(settings.vaultRoot).toBe(story);
    expect(settings.notesVaultRoot).toBe(notes);
  });
});

describe('main.handlers notesVault:*', () => {
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