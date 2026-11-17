// Compare-and-swap vault writes for whole-file writers.

import crypto from 'crypto';
import fs from 'fs';

import type { VaultWriteResponse } from '../ipc.js';
import { ipcErrorUserMessage, IPC_ERROR_CATEGORIES } from '../ipcErrors.js';
import { markSelfWrite, safeVaultJoin, writeVaultFileAtomic } from '../vault.js';
import { VaultFileTooLargeError, MAX_VAULT_FILE_BYTES } from './limits.js';
import { readVaultFileBounded } from './boundedRead.js';
import type { VaultFileId } from './boundedRead.js';
import { defaultDeps, writeNoFollowAtomic, VaultWriteRefusedError } from './noFollowWrite.js';
import type { ExpectTarget, NoFollowDeps } from './noFollowWrite.js';
import { mapVaultWriteError } from './writeErrors.js';

const READ_RETRY_DELAYS_MS = [50, 150, 300];
const CAS_HASH_RE = /^[0-9a-f]{64}$/;

function utf8Sha256(content: string): string {
  return crypto.createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function isMissingLeaf(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function win32RetryAbsence(abs: string, fsImpl: typeof fs): boolean {
  if (process.platform !== 'win32') return false;
  for (const delay of READ_RETRY_DELAYS_MS) {
    try {
      fsImpl.lstatSync(abs);
      return false;
    } catch (err) {
      if (!isMissingLeaf(err)) throw err;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
  try {
    fsImpl.lstatSync(abs);
    return false;
  } catch (err) {
    if (!isMissingLeaf(err)) throw err;
  }
  return true;
}

function leafAbsent(root: string, rel: string, fsImpl: typeof fs): boolean {
  const abs = safeVaultJoin(root, rel, { writeMode: true });
  try {
    fsImpl.lstatSync(abs);
    return false;
  } catch (err) {
    if (!isMissingLeaf(err)) throw err;
  }
  if (process.platform !== 'win32') return true;
  return win32RetryAbsence(abs, fsImpl);
}

function writeCasBytes(
  root: string,
  rel: string,
  content: string,
  expectTarget: ExpectTarget,
  deps: NoFollowDeps,
): void {
  const abs = safeVaultJoin(root, rel, { writeMode: true });
  const buf = Buffer.from(content, 'utf-8');
  if (buf.byteLength > MAX_VAULT_FILE_BYTES) throw new VaultFileTooLargeError(buf.byteLength);
  writeNoFollowAtomic(abs, buf, { durable: true, mkdir: true, rel, expectTarget, deps });
  markSelfWrite(abs);
}

export interface WriteVaultFileCasOptions {
  deps?: NoFollowDeps;
}

export function writeVaultFileCas(
  root: string,
  rel: string,
  content: string,
  expectedSha256: string | null,
  options: WriteVaultFileCasOptions = {},
): { path: string; bytes: number; sha256: string } {
  const deps = options.deps ?? defaultDeps;
  const fsImpl = deps.fs;
  const writtenSha = utf8Sha256(content);
  const bytes = Buffer.byteLength(content, 'utf-8');

  if (expectedSha256 === null) {
    if (!leafAbsent(root, rel, fsImpl)) {
      throw new VaultWriteRefusedError('STALE', rel);
    }
    writeCasBytes(root, rel, content, 'absent', deps);
    return { path: rel, bytes, sha256: writtenSha };
  }

  let snapshot;
  try {
    snapshot = readVaultFileBounded(root, rel, MAX_VAULT_FILE_BYTES, { deps });
  } catch (err) {
    if (isMissingLeaf(err)) {
      throw new VaultWriteRefusedError('CAS_MISSING', rel);
    }
    throw err;
  }

  if (snapshot.id.nlink > 1n) {
    throw new VaultWriteRefusedError('HARD_LINK', rel);
  }
  if (snapshot.sha256 !== expectedSha256) {
    throw new VaultWriteRefusedError('STALE', rel);
  }

  const expectTarget: VaultFileId = snapshot.id;
  try {
    writeCasBytes(root, rel, content, expectTarget, deps);
  } catch (err) {
    if (err instanceof VaultWriteRefusedError && err.code === 'SWAP') {
      throw new VaultWriteRefusedError('STALE', rel);
    }
    throw err;
  }
  return { path: rel, bytes, sha256: writtenSha };
}

/** Plain atomic write with sha256 for IPC replies (unchanged behavior path). */
export function writeVaultPlainForIpc(
  root: string,
  rel: string,
  content: string,
): { path: string; bytes: number; sha256: string } {
  const written = writeVaultFileAtomic(root, rel, content);
  return { path: written.path, bytes: written.bytes, sha256: utf8Sha256(content) };
}

/**
 * Story Vault IPC write body (after `safeVaultIpcJoin`). Validates `expectedSha256`
 * and maps refusal codes for the renderer.
 */
export function vaultWriteForIpc(
  root: string,
  rel: string,
  content: string,
  expectedSha256?: string | null,
  options: WriteVaultFileCasOptions = {},
): VaultWriteResponse {
  try {
    if (expectedSha256 !== undefined) {
      if (expectedSha256 !== null) {
        if (typeof expectedSha256 !== 'string' || !CAS_HASH_RE.test(expectedSha256)) {
          return { path: rel, bytes: 0, error: ipcErrorUserMessage(IPC_ERROR_CATEGORIES.INVALID_INPUT) };
        }
      }
      const written = writeVaultFileCas(root, rel, content, expectedSha256, options);
      return { path: written.path, bytes: written.bytes, sha256: written.sha256 };
    }
    const written = writeVaultPlainForIpc(root, rel, content);
    return { path: written.path, bytes: written.bytes, sha256: written.sha256 };
  } catch (err) {
    const mapped = mapVaultWriteError(err, rel);
    if (mapped) return { path: rel, bytes: 0, error: mapped.error, code: mapped.code };
    throw err;
  }
}