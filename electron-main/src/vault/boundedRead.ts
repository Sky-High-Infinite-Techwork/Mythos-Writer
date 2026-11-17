// Bounded, no-follow vault read for whole-file writers. Never writes.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { safePath } from '../vault.js';
import { VaultFileTooLargeError, MAX_VAULT_FILE_BYTES } from './limits.js';
import { defaultDeps, zeroIndexPolicy } from './noFollowWrite.js';
import type { NoFollowDeps } from './noFollowWrite.js';
import { NOFOLLOW_MISMATCH, openNoFollow } from './noFollowOpen.js';
import { isResolvedPathInsideRoot } from './safeVaultJoin.js';

export interface VaultFileId {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  nlink: bigint;
}

export interface BoundedReadResult {
  content: string;
  path: string;
  sha256: string;
  id: VaultFileId;
}

export interface BoundedReadHooks {
  afterJoin?: () => void;
  afterFstat?: () => void;
}

let testHooks: BoundedReadHooks | null = null;

/** @internal Installed only from vault unit tests. */
export function installBoundedReadHooks(hooks: BoundedReadHooks | null): void {
  testHooks = hooks;
}

function pathNotAllowed(rel: string): Error {
  return new Error(`Path traversal denied: ${rel} (symlink escape detected)`);
}

function zeroIndexRefused(rel: string): Error {
  return new Error(`Path traversal denied: ${rel} (zero file index unsupported)`);
}

/**
 * Containment identity on the opened fd vs the path stats. **Residual (C1):**
 * when dev/ino are 0n, FAT/exFAT skips dev/ino; network shares compare fd
 * `fstat.size` to the pre-open leaf `lstat.size` (swap between lstat and open);
 * local/unknown refuses. Full dev/ino+size identity uses realpath `stat` when
 * indexes are non-zero.
 */
function idsMatch(
  fd: fs.BigIntStats,
  listed: fs.BigIntStats,
  preOpen: fs.BigIntStats | undefined,
  dir: string,
  rel: string,
  deps: NoFollowDeps,
): void {
  if (fd.ino !== 0n && listed.ino !== 0n) {
    if (fd.dev !== listed.dev || fd.ino !== listed.ino) {
      throw pathNotAllowed(rel);
    }
    return;
  }
  const policy = zeroIndexPolicy(dir, deps, false);
  if (policy === 'unsupported') {
    throw zeroIndexRefused(rel);
  }
  if (policy === 'network' && preOpen !== undefined && fd.size !== preOpen.size) {
    throw pathNotAllowed(rel);
  }
}

function assertContainmentOnFd(
  abs: string,
  rel: string,
  fd: number,
  vaultRoot: string,
  preOpen: fs.BigIntStats | undefined,
  deps: NoFollowDeps,
): void {
  const realVaultRoot = fs.realpathSync.native(vaultRoot);
  const realPath = fs.realpathSync.native(abs);
  if (!isResolvedPathInsideRoot(realVaultRoot, realPath, deps.platform)) {
    throw new Error(`Path traversal denied: ${rel}`);
  }
  const listed = deps.fs.statSync(realPath, { bigint: true });
  const fst = deps.fs.fstatSync(fd, { bigint: true });
  idsMatch(fst, listed, preOpen, path.dirname(abs), rel, deps);
}

export interface ReadVaultFileBoundedOptions {
  maxBytes?: number;
  deps?: NoFollowDeps;
}

/**
 * Read one vault file through a single no-follow fd, bounded, with SHA-256.
 */
export function readVaultFileBounded(
  vaultRoot: string,
  rel: string,
  maxBytes = MAX_VAULT_FILE_BYTES,
  options: ReadVaultFileBoundedOptions = {},
): BoundedReadResult {
  const deps = options.deps ?? defaultDeps;
  const fsImpl = deps.fs;
  const abs = safePath(vaultRoot, rel, false);
  testHooks?.afterJoin?.();

  let preOpen: fs.BigIntStats | undefined;
  try {
    preOpen = fsImpl.lstatSync(abs, { bigint: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
  }

  let fd: number | undefined;
  try {
    fd = openNoFollow(
      fsImpl,
      abs,
      fsImpl.constants.O_RDONLY,
      undefined,
      deps.platform,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === NOFOLLOW_MISMATCH) {
      throw pathNotAllowed(rel);
    }
    throw err;
  }

  try {
    const fst = fsImpl.fstatSync(fd, { bigint: true });
    testHooks?.afterFstat?.();

    if (!fst.isFile()) {
      const dirErr = Object.assign(new Error('EISDIR: not a file'), { code: 'EISDIR' });
      throw dirErr;
    }

    if (fst.size > BigInt(maxBytes)) {
      throw new VaultFileTooLargeError(Number(fst.size), maxBytes);
    }

    assertContainmentOnFd(abs, rel, fd, vaultRoot, preOpen, deps);

    const chunkSize = 64 * 1024;
    const scratch = Buffer.alloc(chunkSize);
    const chunks: Buffer[] = [];
    let total = 0;

    while (total <= maxBytes) {
      const toRead = Math.min(chunkSize, maxBytes + 1 - total);
      const n = fsImpl.readSync(fd, scratch, 0, toRead, null);
      if (n === 0) break;
      chunks.push(Buffer.from(scratch.subarray(0, n)));
      total += n;
      if (total > maxBytes) {
        throw new VaultFileTooLargeError(total, maxBytes);
      }
    }

    const buf = Buffer.concat(chunks, total);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const content = buf.toString('utf-8');
    const id: VaultFileId = {
      dev: fst.dev,
      ino: fst.ino,
      size: BigInt(buf.length),
      mtimeNs: fst.mtimeNs,
      nlink: fst.nlink,
    };
    return { content, path: rel, sha256, id };
  } finally {
    try {
      if (fd !== undefined) fsImpl.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}