import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const db = vi.hoisted(() => {
  const bag: Record<string, ReturnType<typeof vi.fn>> = {};
  const proxy = new Proxy(bag, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;
      if (!target[prop]) target[prop] = vi.fn();
      return target[prop];
    },
  });
  return proxy;
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    disableHardwareAcceleration: vi.fn(),
    whenReady: () => new Promise(() => {}),
    on: vi.fn(),
    once: vi.fn(),
    getPath: () => path.join(os.tmpdir(), 'mythos-cas-ipc-userdata'),
    getAppPath: () => '/workspace',
    getVersion: () => '0.0.0-test',
    getName: () => 'Mythos Writer',
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    exit: vi.fn(),
    setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn(), trashItem: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }) },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
}));

vi.mock('../jobs/jobWorker?nodeWorker', () => ({
  default: () => ({ postMessage() {}, terminate() {}, on() {}, once() {} }),
}));

vi.mock('../db.js', () => db);

import { ipcMain } from 'electron';
import { IPC_CHANNELS, setupIpcMain, type VaultReadPayload, type VaultWritePayload } from '../ipc.js';
import * as mainIpc from '../main.js';
import { BLANK_MODE_STAGING_DIR } from '../brainstormRouting.js';
import { safeVaultIpcJoin, safeVaultJoin, writeVaultFileAtomic } from '../vault.js';
import { mapVaultWriteError } from './writeErrors.js';
import { readVaultFileBounded } from './boundedRead.js';
import { vaultWriteForIpc, writeVaultFileCas } from './casWrite.js';
import * as noFollowWriteModule from './noFollowWrite.js';
import {
  defaultDeps,
  expectTargetMatches,
  resetVolumeProbeCache,
  VaultWriteRefusedError,
  writeNoFollowAtomic,
  type VolumeKind,
} from './noFollowWrite.js';
import { resetNoFollowHooksForTests, setNoFollowHooksForTests } from './noFollowWrite.testing.js';
import { installNoFollowTestHooks } from './noFollowWrite.js';
import { hardlinksWork, installVaultOsCapabilityProbes } from './vaultOsGuards.testing.js';

const PLATFORM_MARK = Symbol.for('mythos.noFollowPlatform');

beforeAll(() => {
  installVaultOsCapabilityProbes();
});

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

  it('F3a CAS STALE on same-size external content swap (sha compare)', () => {
    const a = '{"aaaa":1}';
    const b = '{"bbbb":1}';
    expect(Buffer.byteLength(a)).toBe(Buffer.byteLength(b));
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), a);
    const seen = readVaultFileBounded(root, rel);
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), b);
    expect(() => writeVaultFileCas(root, rel, '{"cccc":1}', seen.sha256)).toThrow(VaultWriteRefusedError);
    try {
      writeVaultFileCas(root, rel, '{"cccc":1}', seen.sha256);
    } catch (err) {
      expect((err as VaultWriteRefusedError).code).toBe('STALE');
    }
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe(b);
  });

  it('F3a CAS STALE when beforeRename rewrites same-size bytes and bumps mtimeNs', () => {
    const body = '{"aaaa":1}';
    const racer = '{"bbbb":1}';
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), body);
    const seen = readVaultFileBounded(root, rel);
    setNoFollowHooksForTests({
      afterOpen() {},
      beforeRename(absPath) {
        fs.writeFileSync(absPath, racer);
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(absPath, future, future);
      },
    });
    expect(() => writeVaultFileCas(root, rel, '{"cccc":1}', seen.sha256)).toThrow(VaultWriteRefusedError);
    try {
      writeVaultFileCas(root, rel, '{"cccc":1}', seen.sha256);
    } catch (err) {
      expect((err as VaultWriteRefusedError).code).toBe('STALE');
    }
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe(racer);
  });

  it.skipIf(process.platform === 'win32')(
    'F3b CAS STALE when beforeRename replaces the inode but keeps size and mtimeNs (skipped on win32: dev/ino inode identity differs from POSIX)',
    () => {
    const body = '{"inode":1}';
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), body);
    const seen = readVaultFileBounded(root, rel);
    setNoFollowHooksForTests({
      afterOpen() {},
      beforeRename(absPath) {
        const st = fs.lstatSync(absPath, { bigint: true });
        const staged = `${absPath}.inode-swap`;
        fs.writeFileSync(staged, body);
        fs.utimesSync(staged, Number(st.atimeMs), Number(st.mtimeMs));
        fs.unlinkSync(absPath);
        fs.renameSync(staged, absPath);
      },
    });
    expect(() => writeVaultFileCas(root, rel, '{"inode":2}', seen.sha256)).toThrow(VaultWriteRefusedError);
    try {
      writeVaultFileCas(root, rel, '{"inode":2}', seen.sha256);
    } catch (err) {
      expect((err as VaultWriteRefusedError).code).toBe('STALE');
    }
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe(body);
  },
  );

  it.skipIf(() => !hardlinksWork)('F5 HARD_LINK when an outside hard link appears just before rename', () => {
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"link":1}');
    const seen = readVaultFileBounded(root, rel);
    const outsideDir = path.join(tmp, 'f5-outside');
    fs.mkdirSync(outsideDir);
    setNoFollowHooksForTests({
      afterOpen() {},
      beforeRename(absPath) {
        fs.linkSync(absPath, path.join(outsideDir, 'sibling.json'));
      },
    });
    const reply = vaultWriteForIpc(root, rel, '{"link":2}', seen.sha256);
    expect(reply.bytes).toBe(0);
    expect(reply.code).toBe('HARD_LINK');
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"link":1}');
  });

  it('F6 expectedSha256 null STALE when the file appears before rename', () => {
    expect(fs.existsSync(path.join(root, 'stories', 's1', 'comments.json'))).toBe(false);
    setNoFollowHooksForTests({
      afterOpen() {},
      beforeRename(absPath) {
        fs.writeFileSync(absPath, '{"race":1}');
      },
    });
    const reply = vaultWriteForIpc(root, rel, '{"new":1}', null);
    expect(reply.bytes).toBe(0);
    expect(reply.code).toBe('STALE');
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"race":1}');
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

  it.skipIf(() => !hardlinksWork)('refuses HARD_LINK when comments.json is hard-linked outside the vault', () => {
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

  describe('C1 expectTargetMatches zero-ino at pre-rename (write path)', () => {
    it('expectTargetMatches FAT zero-ino accepts CAS when size+mtimeNs match', () => {
      fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"v":1}');
      const probe = withProbe('fat');
      try {
        const snap = readVaultFileBounded(root, rel, undefined, { deps: probe.deps });
        expect(snap.id.ino).toBe(0n);
        const out = writeVaultFileCas(root, rel, '{"v":2}', snap.sha256, { deps: probe.deps });
        expect(out.bytes).toBeGreaterThan(0);
        expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"v":2}');
      } finally {
        probe.cleanup();
      }
    });

    it('expectTargetMatches local zero-ino refuses with STALE', () => {
      fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"v":1}');
      const fat = withProbe('fat');
      let snap;
      try {
        snap = readVaultFileBounded(root, rel, undefined, { deps: fat.deps });
        expect(snap.id.ino).toBe(0n);
      } finally {
        fat.cleanup();
      }
      const abs = safeVaultJoin(root, rel, { writeMode: true });
      expect(() =>
        writeNoFollowAtomic(abs, Buffer.from('{"v":2}', 'utf-8'), {
          durable: false,
          mkdir: true,
          rel,
          expectTarget: snap!.id,
          deps: defaultDeps,
        }),
      ).toThrow(VaultWriteRefusedError);
      try {
        writeNoFollowAtomic(abs, Buffer.from('{"v":2}', 'utf-8'), {
          durable: false,
          mkdir: true,
          rel,
          expectTarget: snap!.id,
          deps: defaultDeps,
        });
      } catch (err) {
        expect((err as VaultWriteRefusedError).code).toBe('STALE');
      }
      expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"v":1}');
    });

    it('mutant: expectTargetMatches without zeroIndexPolicy gate would accept local zero-ino', () => {
      const local = withProbe('local');
      const expectId = { dev: 1n, ino: 0n, size: 12n, mtimeNs: 99n, nlink: 1n };
      const post = {
        dev: 2n,
        ino: 44n,
        size: 12n,
        mtimeNs: 99n,
        nlink: 1n,
        isFile: () => true,
      } as fs.BigIntStats;
      const mutantMatches = (
        got: fs.BigIntStats,
        want: typeof expectId,
      ): boolean => got.size === want.size && got.mtimeNs === want.mtimeNs;
      try {
        expect(noFollowWriteModule.expectTargetMatches(post, expectId, root, local.deps)).toBe(false);
        expect(mutantMatches(post, expectId)).toBe(true);
      } finally {
        local.cleanup();
      }
    });

    it('F4 network zero-ID CAS write accepts when post size matches expectTarget', () => {
      fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"net":1}');
      const probe = withProbe('network');
      try {
        const snap = readVaultFileBounded(root, rel, undefined, { deps: probe.deps });
        expect(snap.id.ino).toBe(0n);
        const out = writeVaultFileCas(root, rel, '{"net":2}', snap.sha256, { deps: probe.deps });
        expect(out.bytes).toBeGreaterThan(0);
        expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"net":2}');
      } finally {
        probe.cleanup();
      }
    });

    it('F4 network zero-ID CAS write STALE when post size drifts before rename', () => {
      fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"net":1}');
      const probe = withProbe('network');
      let snap;
      try {
        snap = readVaultFileBounded(root, rel, undefined, { deps: probe.deps });
      } finally {
        probe.cleanup();
      }
      const netAgain = withProbe('network');
      setNoFollowHooksForTests({
        afterOpen() {},
        beforeRename(absPath) {
          fs.appendFileSync(absPath, 'z');
        },
      });
      try {
        expect(() =>
          writeVaultFileCas(root, rel, '{"net":9}', snap!.sha256, { deps: netAgain.deps }),
        ).toThrow(VaultWriteRefusedError);
        try {
          writeVaultFileCas(root, rel, '{"net":9}', snap!.sha256, { deps: netAgain.deps });
        } catch (err) {
          expect((err as VaultWriteRefusedError).code).toBe('STALE');
        }
      } finally {
        netAgain.cleanup();
        resetNoFollowHooksForTests();
      }
    });

    it('expectTargetMatches unknown volume zero-ino refuses', () => {
      fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"v":1}');
      const fat = withProbe('fat');
      let snap;
      try {
        snap = readVaultFileBounded(root, rel, undefined, { deps: fat.deps });
      } finally {
        fat.cleanup();
      }
      const unknown = withProbe('unknown');
      const abs = safeVaultJoin(root, rel, { writeMode: true });
      const post = fs.lstatSync(abs, { bigint: true });
      try {
        expect(expectTargetMatches(post, snap!.id, path.dirname(abs), unknown.deps)).toBe(false);
      } finally {
        unknown.cleanup();
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

  it.skipIf(() => !hardlinksWork)('refuses nlink>1 through IPC mapping', () => {
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

  it('rejects path escape via writeStoryVaultForIpc without throwing', () => {
    const reply = mainIpc.writeStoryVaultForIpc(root, '../escape.md', 'nope');
    expect(reply.bytes).toBe(0);
    expect(reply.error).toBe('Path not allowed.');
    expect(reply.code).toBeUndefined();
  });
});

function topFrameEvent() {
  const frame: { top?: unknown } = {};
  frame.top = frame;
  return { senderFrame: frame };
}

describe('vault:read / vault:write via setupIpcMain', () => {
  let tmp: string;
  let root: string;
  let notesRoot: string;
  const rel = 'stories/s1/comments.json';
  let invokeRead: (payload: VaultReadPayload) => Promise<unknown>;
  let invokeWrite: (payload: VaultWritePayload) => Promise<unknown>;

  beforeAll(() => {
    vi.mocked(ipcMain.handle).mockClear();
    invokeRead = async () => ({ error: 'missing' });
    invokeWrite = async () => ({ error: 'missing' });
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-story-ipc-'));
    root = path.join(tmp, 'vault');
    notesRoot = path.join(tmp, 'notes-vault');
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    fs.mkdirSync(path.join(notesRoot, 'stories', 's1'), { recursive: true });
    resetVolumeProbeCache();
    vi.mocked(ipcMain.handle).mockClear();
    mainIpc.setStoryVaultIpcTestRoot(root);
    setupIpcMain({
      [IPC_CHANNELS.VAULT_READ]: mainIpc.handleStoryVaultReadIpc,
      [IPC_CHANNELS.VAULT_WRITE]: mainIpc.handleStoryVaultWriteIpc,
    } as never);
    const readReg = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC_CHANNELS.VAULT_READ);
    const writeReg = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC_CHANNELS.VAULT_WRITE);
    expect(readReg).toBeDefined();
    expect(writeReg).toBeDefined();
    invokeRead = async (payload) =>
      (readReg![1] as (event: unknown, p: VaultReadPayload) => Promise<unknown>)(topFrameEvent(), payload);
    invokeWrite = async (payload) =>
      (writeReg![1] as (event: unknown, p: VaultWritePayload) => Promise<unknown>)(topFrameEvent(), payload);
  });

  afterEach(() => {
    mainIpc.setStoryVaultIpcTestRoot(undefined);
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function sha(content: string): string {
    return crypto.createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
  }

  it('plain vault:write without expectedSha256 returns sha256', async () => {
    const reply = (await invokeWrite({ path: rel, content: '{"ipc":1}' })) as { bytes: number; sha256?: string };
    expect(reply.bytes).toBeGreaterThan(0);
    expect(reply.sha256).toBe(sha('{"ipc":1}'));
  });

  it('vault:read returns sha256 for a file', async () => {
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"r":1}');
    const reply = (await invokeRead({ path: rel })) as { sha256: string; content: string };
    expect(reply.sha256).toBe(sha('{"r":1}'));
    expect(reply.content).toBe('{"r":1}');
  });

  it('CAS stale via vault:write returns STALE and leaves disk', async () => {
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"v":1}');
    const seen = readVaultFileBounded(root, rel);
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"v":9}');
    const reply = (await invokeWrite({ path: rel, content: '{"v":2}', expectedSha256: seen.sha256 })) as {
      bytes: number;
      code?: string;
    };
    expect(reply.bytes).toBe(0);
    expect(reply.code).toBe('STALE');
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"v":9}');
  });

  it('invalid expectedSha256 via vault:write returns Invalid input', async () => {
    const reply = (await invokeWrite({ path: rel, content: 'X', expectedSha256: 'not-a-hash' })) as {
      bytes: number;
      error?: string;
    };
    expect(reply.bytes).toBe(0);
    expect(reply.error).toBe('Invalid input.');
  });

  it('path escape via vault:write returns Path not allowed object', async () => {
    const reply = (await invokeWrite({ path: '../escape.md', content: 'nope' })) as {
      bytes: number;
      error?: string;
    };
    expect(reply.bytes).toBe(0);
    expect(reply.error).toBe('Path not allowed.');
  });

  it('mutant: dropping sha256 from read handler fails sha256 contract', async () => {
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"probe":1}');
    const reply = (await invokeRead({ path: rel })) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(reply, 'sha256')).toBe(true);
    expect(typeof reply.sha256).toBe('string');
    const mutant = { content: reply.content, path: reply.path };
    expect(Object.prototype.hasOwnProperty.call(mutant, 'sha256')).toBe(false);
  });

  describe('F1 safeVaultIpcJoin through setupIpcMain', () => {
    const joinDeniedPaths = ['.mythos/a.json', '.hidden.md', 'a.txt'] as const;

    function countVaultFiles(): number {
      let n = 0;
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) walk(full);
          else n += 1;
        }
      };
      walk(root);
      return n;
    }

    function prepareTrapFiles(): void {
      fs.mkdirSync(path.join(root, '.mythos'), { recursive: true });
      fs.writeFileSync(path.join(root, '.mythos', 'a.json'), '{"trap":1}');
      fs.writeFileSync(path.join(root, '.hidden.md'), 'hide');
      fs.writeFileSync(path.join(root, 'a.txt'), 'txt');
    }

    it.each(joinDeniedPaths)('vault:read rejects %s with Path not allowed', async (relPath) => {
      prepareTrapFiles();
      const reply = (await invokeRead({ path: relPath })) as { error?: string; content?: string };
      expect(reply.error).toBe('Path not allowed.');
      expect(reply.content).toBeUndefined();
    });

    it.each(joinDeniedPaths)('vault:write rejects %s with Path not allowed and writes nothing', async (relPath) => {
      prepareTrapFiles();
      const before = countVaultFiles();
      const reply = (await invokeWrite({ path: relPath, content: '{"deny":1}' })) as {
        bytes: number;
        error?: string;
      };
      expect(reply.bytes).toBe(0);
      expect(reply.error).toBe('Path not allowed.');
      expect(countVaultFiles()).toBe(before);
    });

    it('mutant F1 C15: vault:read without handler join exposes .mythos/a.json', async () => {
      prepareTrapFiles();
      vi.mocked(ipcMain.handle).mockClear();
      const readWithoutJoin = (payload: VaultReadPayload) => {
        const { content, path: vaultPath, sha256 } = readVaultFileBounded(root, payload.path);
        return { content, path: vaultPath, sha256 };
      };
      setupIpcMain({ [IPC_CHANNELS.VAULT_READ]: readWithoutJoin } as never);
      const reg = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC_CHANNELS.VAULT_READ)!;
      const mutantReply = (await (reg[1] as (e: unknown, p: VaultReadPayload) => Promise<unknown>)(
        topFrameEvent(),
        { path: '.mythos/a.json' },
      )) as { content?: string; error?: string };
      expect(mutantReply.content).toBe('{"trap":1}');
      expect(mutantReply.error).toBeUndefined();
    });

    it('story vault write refuses dot-segment paths that notes may use (staging dir)', async () => {
      const stagedRel = `${BLANK_MODE_STAGING_DIR}/probe.md`;
      const reply = (await invokeWrite({ path: stagedRel, content: 'nope' })) as {
        bytes: number;
        error?: string;
      };
      expect(reply.bytes).toBe(0);
      expect(reply.error).toBe('Path not allowed.');
    });

    it('mutant F1 C14: vault:write without handler join allows a.txt', async () => {
      const before = countVaultFiles();
      vi.mocked(ipcMain.handle).mockClear();
      const writeWithoutJoin = (payload: VaultWritePayload) => {
        const written = writeVaultFileAtomic(root, payload.path, payload.content);
        return { path: written.path, bytes: written.bytes };
      };
      setupIpcMain({ [IPC_CHANNELS.VAULT_WRITE]: writeWithoutJoin } as never);
      const reg = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC_CHANNELS.VAULT_WRITE)!;
      const evil = (await (reg[1] as (e: unknown, p: VaultWritePayload) => Promise<unknown>)(
        topFrameEvent(),
        { path: 'a.txt', content: 'evil' },
      )) as { bytes: number; error?: string };
      expect(evil.bytes).toBeGreaterThan(0);
      expect(evil.error).toBeUndefined();
      expect(countVaultFiles()).toBe(before + 1);
    });
  });

  it('mutant: dropping hasOwn expectedSha256 wiring treats explicit null as plain write', async () => {
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"exists":1}');
    const stale = (await invokeWrite({
      path: rel,
      content: '{"overwrite":1}',
      expectedSha256: null,
    })) as { bytes: number; code?: string };
    expect(stale.bytes).toBe(0);
    expect(stale.code).toBe('STALE');

    vi.mocked(ipcMain.handle).mockClear();
    const mutantWrite = (payload: VaultWritePayload) =>
      mainIpc.writeStoryVaultForIpc(mainIpc.getVaultRootForStoryVaultIpc(), payload.path, payload.content);
    setupIpcMain({
      [IPC_CHANNELS.VAULT_WRITE]: mutantWrite,
    } as never);
  const writeReg = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC_CHANNELS.VAULT_WRITE)!;
    const invokeMutant = async (payload: VaultWritePayload) =>
      (writeReg[1] as (event: unknown, p: VaultWritePayload) => Promise<unknown>)(topFrameEvent(), payload);
    const evil = (await invokeMutant({
      path: rel,
      content: '{"overwrite":1}',
      expectedSha256: null,
    })) as { bytes: number; code?: string };
    expect(evil.bytes).toBeGreaterThan(0);
    expect(evil.code).toBeUndefined();
    expect(fs.readFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'utf8')).toBe('{"overwrite":1}');
  });
});

describe('notesVault:write via main handler', () => {
  let tmp: string;
  let notesRoot: string;
  const rel = 'stories/s1/note.md';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-notes-ipc-'));
    notesRoot = path.join(tmp, 'notes-vault');
    fs.mkdirSync(path.join(notesRoot, 'stories', 's1'), { recursive: true });
    mainIpc.setNotesVaultIpcTestRoot(notesRoot);
  });

  afterEach(() => {
    mainIpc.setNotesVaultIpcTestRoot(undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('notesVault:write reply has no sha256 key', () => {
    const reply = mainIpc.handleNotesVaultWriteIpc({ path: rel, content: '# Note\n' });
    expect(reply.bytes).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(reply, 'sha256')).toBe(false);
    expect(Object.keys(reply).sort()).toEqual(['bytes', 'path']);
    expect(fs.readFileSync(path.join(notesRoot, 'stories', 's1', 'note.md'), 'utf8')).toBe('# Note\n');
  });

  it('writeVaultForIpc notes path matches main shape without sha256', () => {
    const reply = mainIpc.writeVaultForIpc(notesRoot, rel, '{"plain":true}');
    expect(Object.prototype.hasOwnProperty.call(reply, 'sha256')).toBe(false);
    expect(reply).toEqual({ path: rel, bytes: Buffer.byteLength('{"plain":true}', 'utf-8') });
  });

  it('notes vault write allows brainstorm blank-mode staging under dot directory', () => {
    const stagedRel = `${BLANK_MODE_STAGING_DIR}/id__Test Note.md`;
    expect(() => safeVaultIpcJoin(notesRoot, stagedRel, true)).not.toThrow();
    const reply = mainIpc.handleNotesVaultWriteIpc({ path: stagedRel, content: '# staged\n' });
    expect(reply.bytes).toBeGreaterThan(0);
    expect(
      fs.readFileSync(path.join(notesRoot, BLANK_MODE_STAGING_DIR, 'id__Test Note.md'), 'utf8'),
    ).toBe('# staged\n');
  });
});