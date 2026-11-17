import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { mapVaultWriteError } from './writeErrors.js';
import { readVaultFileBounded } from './boundedRead.js';
import { vaultWriteForIpc, writeVaultFileCas } from './casWrite.js';
import { defaultDeps, resetVolumeProbeCache, VaultWriteRefusedError, type VolumeKind } from './noFollowWrite.js';
import { resetNoFollowHooksForTests, setNoFollowHooksForTests } from './noFollowWrite.testing.js';
import { installNoFollowTestHooks } from './noFollowWrite.js';

const PLATFORM_MARK = Symbol.for('mythos.noFollowPlatform');

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

  function zeroInoFs(): typeof fs {
    return new Proxy(fs, {
      get(target, prop, receiver) {
        if (prop === 'fstatSync' || prop === 'lstatSync' || prop === 'statSync') {
          const real = target[prop as 'fstatSync'] as (
            p: never,
            opts?: { bigint?: boolean },
          ) => fs.Stats | fs.BigIntStats;
          return (p: never, opts?: { bigint?: boolean }) => {
            const st = real.call(target, p, opts);
            if (!opts?.bigint) return st;
            return new Proxy(st, {
              get(stats, key, statsReceiver) {
                if (key === 'ino') return 0n;
                const value = Reflect.get(stats, key, statsReceiver);
                return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(stats) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  function withProbe(kind: VolumeKind) {
    const marked = zeroInoFs();
    (marked as Record<symbol, string>)[PLATFORM_MARK] = 'win32';
    return {
      deps: { ...defaultDeps, fs: marked, platform: 'win32' as const, probeVolume: () => kind },
      cleanup() {
        Reflect.deleteProperty(marked, PLATFORM_MARK);
      },
    };
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

  describe('C1 forced-win32 zero file IDs on CAS write', () => {
    it('accepts zero ino on FAT for CAS create', () => {
      const probe = withProbe('fat');
      try {
        const out = writeVaultFileCas(root, rel, '{"fat":true}', null, { deps: probe.deps });
        expect(out.bytes).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(root, 'stories', 's1', 'comments.json'))).toBe(true);
      } finally {
        probe.cleanup();
      }
    });

    it('refuses zero ino on local volumes during CAS write', () => {
      fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"v":0}');
      const probe = withProbe('local');
      const hash = sha('{"v":0}');
      try {
        expect(() => writeVaultFileCas(root, rel, '{"v":1}', hash, { deps: probe.deps })).toThrow();
        try {
          writeVaultFileCas(root, rel, '{"v":1}', hash, { deps: probe.deps });
        } catch (err) {
          expect((err as Error).message).toMatch(/zero file index unsupported/);
        }
        expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"v":0}');
      } finally {
        probe.cleanup();
      }
    });

    it('refuses zero ino on unknown volumes during CAS write', () => {
      fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"v":0}');
      const probe = withProbe('unknown');
      const hash = sha('{"v":0}');
      try {
        expect(() => writeVaultFileCas(root, rel, '{"v":1}', hash, { deps: probe.deps })).toThrow();
        try {
          writeVaultFileCas(root, rel, '{"v":1}', hash, { deps: probe.deps });
        } catch (err) {
          expect((err as Error).message).toMatch(/zero file index unsupported/);
        }
      } finally {
        probe.cleanup();
      }
    });
  });
});

describe('vaultWriteForIpc', () => {
  let tmp: string;
  let root: string;
  const rel = 'stories/s1/comments.json';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-vault-ipc-'));
    root = path.join(tmp, 'vault');
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    resetVolumeProbeCache();
    resetNoFollowHooksForTests();
  });

  afterEach(() => {
    resetNoFollowHooksForTests();
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function sha(content: string): string {
    return crypto.createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
  }

  it('plain write without expectedSha256 writes and returns sha256', () => {
    const reply = vaultWriteForIpc(root, rel, '{"plain":1}');
    expect(reply.bytes).toBeGreaterThan(0);
    expect(reply.sha256).toBe(sha('{"plain":1}'));
    expect(reply.error).toBeUndefined();
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"plain":1}');
  });

  it('expectedSha256 null creates only when absent', () => {
    const created = vaultWriteForIpc(root, rel, '{"new":1}', null);
    expect(created.bytes).toBeGreaterThan(0);
    expect(created.sha256).toBe(sha('{"new":1}'));

    const stale = vaultWriteForIpc(root, rel, '{"other":1}', null);
    expect(stale.bytes).toBe(0);
    expect(stale.code).toBe('STALE');
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"new":1}');
  });

  it('matching hash writes; wrong hash returns STALE and leaves disk unchanged', () => {
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"v":1}');
    const seen = readVaultFileBounded(root, rel);
    const ok = vaultWriteForIpc(root, rel, '{"v":2}', seen.sha256);
    expect(ok.bytes).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"v":2}');

    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"v":3}');
    const bad = vaultWriteForIpc(root, rel, '{"v":4}', seen.sha256);
    expect(bad.bytes).toBe(0);
    expect(bad.code).toBe('STALE');
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"v":3}');
  });

  it('rejects invalid expectedSha256 without writing', () => {
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'KEEP');
    const before = fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8');

    for (const bad of ['abc', 'G'.repeat(64), '0123456789abcdef'] as const) {
      const reply = vaultWriteForIpc(root, rel, 'NOPE', bad);
      expect(reply.bytes).toBe(0);
      expect(reply.error).toBe('Invalid input.');
    }
    const numeric = vaultWriteForIpc(root, rel, 'NOPE', 42 as unknown as string);
    expect(numeric.bytes).toBe(0);
    expect(numeric.error).toBe('Invalid input.');

    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe(before);
  });

  it('refuses nlink>1 through IPC mapping', () => {
    const outsideDir = path.join(tmp, 'outside-ipc');
    fs.mkdirSync(outsideDir);
    const inside = path.join(root, 'stories', 's1', 'comments.json');
    fs.writeFileSync(inside, '{"x":1}');
    fs.linkSync(inside, path.join(outsideDir, 'outside.json'));
    const seen = readVaultFileBounded(root, rel);
    const reply = vaultWriteForIpc(root, rel, '{"y":2}', seen.sha256);
    expect(reply.bytes).toBe(0);
    expect(reply.code).toBe('HARD_LINK');
    expect(fs.readFileSync(inside, 'utf8')).toBe('{"x":1}');
  });
});