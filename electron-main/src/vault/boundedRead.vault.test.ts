import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { sanitizeIpcError } from '../ipcErrors.js';
import {
  installBoundedReadHooks,
  readVaultFileBounded,
} from './boundedRead.js';
import { VaultFileTooLargeError } from './limits.js';
import * as noFollowWriteModule from './noFollowWrite.js';
import {
  defaultDeps,
  resetVolumeProbeCache,
  type VolumeKind,
} from './noFollowWrite.js';

const PLATFORM_MARK = Symbol.for('mythos.noFollowPlatform');

describe('readVaultFileBounded', () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-bounded-read-'));
    root = path.join(tmp, 'vault');
    fs.mkdirSync(root, { recursive: true });
    resetVolumeProbeCache();
    installBoundedReadHooks(null);
  });

  afterEach(() => {
    installBoundedReadHooks(null);
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

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

  function networkZeroInoFs(sizeMatch: boolean): typeof fs {
    const base = zeroInoFs();
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'fstatSync') {
          const realFstat = fs.fstatSync.bind(fs);
          return (fd: number, opts?: { bigint?: boolean }) => {
            const st = realFstat(fd, opts);
            if (!opts?.bigint) return st;
            const rawSize = typeof st.size === 'bigint' ? st.size : BigInt(st.size);
            const size = sizeMatch ? rawSize : rawSize + 1n;
            return new Proxy(st, {
              get(stats, key, statsReceiver) {
                if (key === 'ino') return 0n;
                if (key === 'size') return size;
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

  function withProbe(kind: VolumeKind): NoFollowDepsWithCleanup {
    const marked = zeroInoFs();
    (marked as Record<symbol, string>)[PLATFORM_MARK] = 'win32';
    const deps = { ...defaultDeps, fs: marked, platform: 'win32' as const, probeVolume: () => kind };
    return {
      deps,
      cleanup() {
        Reflect.deleteProperty(marked, PLATFORM_MARK);
      },
    };
  }

  type NoFollowDepsWithCleanup = { deps: typeof defaultDeps; cleanup: () => void };

  function sha(text: string): string {
    return crypto.createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
  }

  it('preserves content and sha256 across several short readSync calls', () => {
    const rel = 'stories/s1/comments.json';
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    const body = 'abcdefghijklmnopqrstuvwxyz';
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), body);
    const realRead = fs.readSync.bind(fs);
    const shortFs = new Proxy(fs, {
      get(target, prop, receiver) {
        if (prop === 'readSync') {
          return (fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) =>
            realRead(fd, buf as Buffer, offset, Math.min(3, length), position);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const read = readVaultFileBounded(root, rel, undefined, { deps: { ...defaultDeps, fs: shortFs } });
    expect(read.content).toBe(body);
    expect(read.sha256).toBe(sha(body));
  });

  it('refuses an in-vault symlinked .md leaf', () => {
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'stories', 's1', 'real.md'), 'REAL');
    fs.symlinkSync(path.join(root, 'stories', 's1', 'real.md'), path.join(root, 'stories', 's1', 'link.md'));
    const err = (() => {
      try {
        readVaultFileBounded(root, 'stories/s1/link.md');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as Error).message).toMatch(/symlink escape detected/);
    expect(sanitizeIpcError('vault:read', err).error).toBe('Path not allowed.');
  });

  it('refuses a symlink leaf with Path not allowed and does not return outside bytes', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    const secret = 'OUTSIDE-SECRET';
    fs.writeFileSync(path.join(outside, 'comments.json'), secret);
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'comments.json'), path.join(root, 'stories', 's1', 'comments.json'));
    const err = (() => {
      try {
        readVaultFileBounded(root, 'stories/s1/comments.json');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeTruthy();
    expect((err as Error).message).toMatch(/symlink escape detected/);
    expect(sanitizeIpcError('vault:read', err).error).toBe('Path not allowed.');
    expect(sanitizeIpcError('vault:read', err).error).not.toBe('File not found.');
  });

  it('refuses a symlink leaf when the platform is forced win32', () => {
    const outside = path.join(tmp, 'outside-win');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'comments.json'), 'SECRET');
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'comments.json'), path.join(root, 'stories', 's1', 'comments.json'));
    const deps = { ...defaultDeps, platform: 'win32' as const };
    const err = (() => {
      try {
        readVaultFileBounded(root, 'stories/s1/comments.json', undefined, { deps });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as Error).message).toMatch(/symlink escape detected/);
    expect(sanitizeIpcError('vault:read', err).error).toBe('Path not allowed.');
  });

  it('R3 dev/ino: refuses parent symlink swap between pre-open lstat and open', () => {
    const outside = path.join(tmp, 'outside-parent');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'comments.json'), 'LEAKED');
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'SAFE');
    installBoundedReadHooks({
      afterJoin() {
        fs.rmSync(path.join(root, 'stories', 's1'), { recursive: true, force: true });
        fs.symlinkSync(outside, path.join(root, 'stories', 's1'), 'dir');
      },
    });
    const err = (() => {
      try {
        readVaultFileBounded(root, 'stories/s1/comments.json');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(sanitizeIpcError('vault:read', err).error).toBe('Path not allowed.');
    expect(fs.readFileSync(path.join(outside, 'comments.json'), 'utf8')).toBe('LEAKED');
  });

  it('R3 dev/ino: refuses when parent is swapped then restored but the fd is stale', () => {
    const outside = path.join(tmp, 'outside-parent');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'comments.json'), 'LEAKED');
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'SAFE');
    installBoundedReadHooks({
      afterJoin() {
        fs.rmSync(path.join(root, 'stories', 's1'), { recursive: true, force: true });
        fs.symlinkSync(outside, path.join(root, 'stories', 's1'), 'dir');
      },
      afterFstat() {
        fs.rmSync(path.join(root, 'stories', 's1'), { force: true });
        fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
        fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'SAFE');
      },
    });
    const err = (() => {
      try {
        readVaultFileBounded(root, 'stories/s1/comments.json');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(sanitizeIpcError('vault:read', err).error).toBe('Path not allowed.');
    expect(fs.readFileSync(path.join(outside, 'comments.json'), 'utf8')).toBe('LEAKED');
  });

  it('reads a 1024-byte file and rejects 1025 bytes from fstat without reading', () => {
    const rel = 'stories/s1/comments.json';
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    const ok = 'x'.repeat(1024);
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), ok);
    const read = readVaultFileBounded(root, rel, 1024);
    expect(read.content.length).toBe(1024);

    const big = 'y'.repeat(1025);
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), big);
    const spy = vi.spyOn(fs, 'readSync');
    try {
      expect(() => readVaultFileBounded(root, rel, 1024)).toThrow(VaultFileTooLargeError);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects when the file grows after fstat beyond maxBytes', () => {
    const rel = 'stories/s1/comments.json';
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'x'.repeat(1020));
    installBoundedReadHooks({
      afterFstat() {
        fs.appendFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'y'.repeat(10));
      },
    });
    expect(() => readVaultFileBounded(root, rel, 1024)).toThrow(VaultFileTooLargeError);
  });

  it('C2: returns 1023 bytes when the file grows after fstat but stays within maxBytes', () => {
    const rel = 'stories/s1/comments.json';
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    const initial = 'a'.repeat(1020);
    const literal = `${initial}bbb`;
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), initial);
    installBoundedReadHooks({
      afterFstat() {
        fs.appendFileSync(path.join(root, 'stories', 's1', 'comments.json'), 'bbb');
      },
    });
    const read = readVaultFileBounded(root, rel, 1024);
    expect(read.content.length).toBe(1023);
    const expectedSha = crypto.createHash('sha256').update(Buffer.from(literal, 'utf-8')).digest('hex');
    expect(read.sha256).toBe(expectedSha);
  });

  it('reports sha256 of non-ASCII bytes', () => {
    const rel = 'stories/s1/comments.json';
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    const text = 'café ☕';
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), text);
    const read = readVaultFileBounded(root, rel);
    const expected = crypto.createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
    expect(read.sha256).toBe(expected);
    expect(read.content).toBe(text);
  });

  it('refuses a folder without File not found', () => {
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    const err = (() => {
      try {
        readVaultFileBounded(root, 'stories/s1');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(sanitizeIpcError('vault:read', err).error).not.toBe('File not found.');
    expect(sanitizeIpcError('vault:read', err).error).toBe('Invalid input.');
  });

  it('throws ENOENT for a missing file', () => {
    expect(() => readVaultFileBounded(root, 'stories/s1/comments.json')).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('F7 refuses opening a directory as a vault file', () => {
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    const err = (() => {
      try {
        readVaultFileBounded(root, 'stories/s1');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeTruthy();
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
    expect(sanitizeIpcError('vault:read', err).error).toBe('Invalid input.');
  });

  it('F7 refuses when fstat reports non-regular file (isFile guard)', () => {
    const rel = 'stories/s1/comments.json';
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"ok":1}');
    const fstat = fs.fstatSync.bind(fs);
    const nonRegularFs = new Proxy(fs, {
      get(target, prop, receiver) {
        if (prop === 'fstatSync') {
          return (fd: number, opts?: { bigint?: boolean }) => {
            const st = fstat(fd, opts);
            return new Proxy(st, {
              get(stats, key, statsReceiver) {
                if (key === 'isFile') return () => false;
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
    const err = (() => {
      try {
        readVaultFileBounded(root, rel, undefined, { deps: { ...defaultDeps, fs: nonRegularFs } });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeTruthy();
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
  });

  it('F7 refuses a Unix domain socket leaf', async () => {
    fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
    const sockPath = path.join(root, 'stories', 's1', 'socket.json');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, resolve);
    });
    try {
      const err = (() => {
        try {
          readVaultFileBounded(root, 'stories/s1/socket.json');
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeTruthy();
      const reply = sanitizeIpcError('vault:read', err);
      expect(['Invalid input.', 'Path not allowed.', 'Internal error.']).toContain(reply.error);
      expect(reply.error).not.toBe('File not found.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        fs.unlinkSync(sockPath);
      } catch {
        /* ignore */
      }
    }
  });

  it.skip('F7 FIFO skipped: bounded no-follow open blocks on FIFO until a writer connects (Four-Q residual)', () => {
    /* documented residual — not exercised to avoid hanging the test runner */
  });

  describe('C1 forced-win32 zero file IDs', () => {
    const rel = 'stories/s1/comments.json';

    beforeEach(() => {
      fs.mkdirSync(path.join(root, 'stories', 's1'), { recursive: true });
      fs.writeFileSync(path.join(root, 'stories', 's1', 'comments.json'), '{"ok":true}');
    });

    it('accepts zero ino on FAT volumes', () => {
      const probe = withProbe('fat');
      try {
        const read = readVaultFileBounded(root, rel, undefined, { deps: probe.deps });
        expect(read.content).toBe('{"ok":true}');
      } finally {
        probe.cleanup();
      }
    });

    it('refuses zero ino on local volumes via zero file index guard', () => {
      const probe = withProbe('local');
      try {
        const err = (() => {
          try {
            readVaultFileBounded(root, rel, undefined, { deps: probe.deps });
            return null;
          } catch (e) {
            return e;
          }
        })();
        expect((err as Error).message).toMatch(/zero file index unsupported/);
        expect((err as Error).message).not.toMatch(/symlink escape detected/);
        expect(sanitizeIpcError('vault:read', err).error).toBe('Path not allowed.');
      } finally {
        probe.cleanup();
      }
    });

    it('refuses zero ino on unknown volumes via zero file index guard', () => {
      const probe = withProbe('unknown');
      try {
        const err = (() => {
          try {
            readVaultFileBounded(root, rel, undefined, { deps: probe.deps });
            return null;
          } catch (e) {
            return e;
          }
        })();
        expect((err as Error).message).toMatch(/zero file index unsupported/);
        expect(sanitizeIpcError('vault:read', err).error).toBe('Path not allowed.');
      } finally {
        probe.cleanup();
      }
    });

    it('F4 network zero-ID read accepts when fd and pre-open lstat sizes match', () => {
      const rel = 'stories/s1/comments.json';
      const marked = networkZeroInoFs(true);
      (marked as Record<symbol, string>)[PLATFORM_MARK] = 'win32';
      const deps = {
        ...defaultDeps,
        fs: marked,
        platform: 'win32' as const,
        probeVolume: () => 'network' as VolumeKind,
      };
      try {
        const read = readVaultFileBounded(root, rel, undefined, { deps });
        expect(read.content).toBe('{"ok":true}');
      } finally {
        Reflect.deleteProperty(marked, PLATFORM_MARK);
      }
    });

    it('F4 network zero-ID read refuses fd size mismatch vs pre-open lstat', () => {
      const rel = 'stories/s1/comments.json';
      const marked = networkZeroInoFs(false);
      (marked as Record<symbol, string>)[PLATFORM_MARK] = 'win32';
      const deps = {
        ...defaultDeps,
        fs: marked,
        platform: 'win32' as const,
        probeVolume: () => 'network' as VolumeKind,
      };
      try {
        const err = (() => {
          try {
            readVaultFileBounded(root, rel, undefined, { deps });
            return null;
          } catch (e) {
            return e;
          }
        })();
        expect((err as Error).message).toMatch(/symlink escape detected/);
        expect(sanitizeIpcError('vault:read', err).error).toBe('Path not allowed.');
      } finally {
        Reflect.deleteProperty(marked, PLATFORM_MARK);
      }
    });

    it('mutant: skipping zeroIndexPolicy would allow local zero-ino read', () => {
      const probe = withProbe('local');
      const policySpy = vi.spyOn(noFollowWriteModule, 'zeroIndexPolicy').mockReturnValue('skip');
      try {
        const read = readVaultFileBounded(root, rel, undefined, { deps: probe.deps });
        expect(read.content).toBe('{"ok":true}');
      } finally {
        policySpy.mockRestore();
        probe.cleanup();
      }
    });
  });
});