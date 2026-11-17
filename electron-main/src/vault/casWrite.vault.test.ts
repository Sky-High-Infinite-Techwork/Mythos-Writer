import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { mapVaultWriteError } from './writeErrors.js';
import { ipcMain } from 'electron';
import { IPC_CHANNELS, setupIpcMain } from '../ipc.js';
import { readVaultFileBounded } from './boundedRead.js';
import { writeVaultFileCas } from './casWrite.js';
import { installNoFollowTestHooks, resetVolumeProbeCache, VaultWriteRefusedError } from './noFollowWrite.js';
import { resetNoFollowHooksForTests, setNoFollowHooksForTests } from './noFollowWrite.testing.js';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

describe('writeVaultFileCas', () => {
  let tmp: string;
  let root: string;
  const rel = 'stories/s1/comments.json';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-cas-write-'));
    root = path.join(tmp, 'vault');
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    resetVolumeProbeCache();
    resetNoFollowHooksForTests();
  });

  afterEach(() => {
    resetNoFollowHooksForTests();
    installNoFollowTestHooks(null);
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function sha(content: string): string {
    return crypto.createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
  }

  it('writes on hash match and returns sha256 of new bytes', () => {
    const initial = '{"v":1}';
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), initial);
    const seen = readVaultFileBounded(root, rel);
    const next = '{"v":2}';
    const result = writeVaultFileCas(root, rel, next, seen.sha256);
    expect(result.sha256).toBe(sha(next));
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe(next);
  });

  it('STALE when the file changed after the caller hashed it', () => {
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"v":1}');
    const seen = readVaultFileBounded(root, rel);
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"note":"user"}');
    expect(() => writeVaultFileCas(root, rel, '{"v":2}', seen.sha256)).toThrow(VaultWriteRefusedError);
    try {
      writeVaultFileCas(root, rel, '{"v":2}', seen.sha256);
    } catch (err) {
      expect((err as VaultWriteRefusedError).code).toBe('STALE');
    }
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"note":"user"}');
    const leftovers = fs.readdirSync(path.join(root, 'stories', 's1')).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toHaveLength(0);
  });

  it('STALE when the target changes during write before rename', () => {
    const payload = '{"v":1}';
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), payload);
    const seen = readVaultFileBounded(root, rel);
    setNoFollowHooksForTests({
      afterOpen() {},
      beforeRename(absPath) {
        fs.writeFileSync(absPath, '{"race":true}');
      },
    });
    expect(() => writeVaultFileCas(root, rel, '{"v":2}', seen.sha256)).toThrow(VaultWriteRefusedError);
    try {
      writeVaultFileCas(root, rel, '{"v":2}', seen.sha256);
    } catch (err) {
      expect((err as VaultWriteRefusedError).code).toBe('STALE');
    }
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"race":true}');
  });

  it('CAS_MISSING when expected hash is set but the file is gone', () => {
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{}');
    const seen = readVaultFileBounded(root, rel);
    fs.unlinkSync(path.join(root, 'stories', 's1', 'comments.json'));
    expect(() => writeVaultFileCas(root, rel, '{"v":2}', seen.sha256)).toThrow(VaultWriteRefusedError);
    try {
      writeVaultFileCas(root, rel, '{"v":2}', seen.sha256);
    } catch (err) {
      expect((err as VaultWriteRefusedError).code).toBe('CAS_MISSING');
    }
    expect(fs.existsSync(path.join(root, 'stories', 's1', 'comments.json'))).toBe(false);
  });

  it('STALE when expected null but file exists', () => {
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'KEEP');
    expect(() => writeVaultFileCas(root, rel, 'NEW', null)).toThrow(VaultWriteRefusedError);
    try {
      writeVaultFileCas(root, rel, 'NEW', null);
    } catch (err) {
      expect((err as VaultWriteRefusedError).code).toBe('STALE');
    }
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('KEEP');
  });

  it('creates when expected null and file absent', () => {
    const out = writeVaultFileCas(root, rel, '{"created":true}', null);
    expect(out.sha256).toBe(sha('{"created":true}'));
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"created":true}');
  });

  it('refuses HARD_LINK when comments.json is hard-linked outside the vault', () => {
    const outsideDir = path.join(tmp, 'outside-link');
    fs.mkdirSync(outsideDir);
    const outside = path.join(outsideDir, 'outside.json');
    const inside = path.join(root, 'stories', 's1', 'comments.json');
    fs.writeFileSync(inside, '{"shared":1}');
    fs.linkSync(inside, outside);
    const seen = readVaultFileBounded(root, rel);
    expect(fs.statSync(inside).nlink).toBe(2);
    expect(() => writeVaultFileCas(root, rel, '{"v":2}', seen.sha256)).toThrow(VaultWriteRefusedError);
    try {
      writeVaultFileCas(root, rel, '{"v":2}', seen.sha256);
    } catch (err) {
      expect((err as VaultWriteRefusedError).code).toBe('HARD_LINK');
    }
    expect(fs.readFileSync(outside, 'utf8')).toBe('{"shared":1}');
    expect(fs.readFileSync(inside, 'utf8')).toBe('{"shared":1}');
    expect(fs.statSync(inside).nlink).toBe(2);
  });

  it('maps CAS refusal codes for IPC', () => {
    const stale = mapVaultWriteError(new VaultWriteRefusedError('STALE', rel), rel);
    expect(stale).toEqual({ error: 'File changed on disk.', code: 'STALE' });
    const missing = mapVaultWriteError(new VaultWriteRefusedError('CAS_MISSING', rel), rel);
    expect(missing).toEqual({ error: 'File no longer exists.', code: 'CAS_MISSING' });
    const hard = mapVaultWriteError(new VaultWriteRefusedError('HARD_LINK', rel), rel);
    expect(hard?.code).toBe('HARD_LINK');
  });
});

describe('writeVaultFileCas IPC helpers', () => {
  it('setupIpcMain registers vault handlers once', () => {
    vi.mocked(ipcMain.handle).mockClear();
    const handlers = {
      [IPC_CHANNELS.VAULT_READ]: vi.fn(),
      [IPC_CHANNELS.VAULT_WRITE]: vi.fn(),
    };
    setupIpcMain(handlers as never);
    expect(ipcMain.handle).toHaveBeenCalledTimes(2);
  });
});