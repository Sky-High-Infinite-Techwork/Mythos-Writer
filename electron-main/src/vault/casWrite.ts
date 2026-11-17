// Compare-and-swap vault writes for whole-file writers.

import crypto from 'crypto';
import fs from 'fs';

import { markSelfWrite, safeVaultJoin, writeVaultFileAtomic } from '../vault.js';
import { VaultFileTooLargeError, MAX_VAULT_FILE_BYTES } from './limits.js';
import { readVaultFileBounded } from './boundedRead.js';
import type { VaultFileId } from './boundedRead.js';
import { writeNoFollowAtomic, VaultWriteRefusedError } from './noFollowWrite.js';
import type { ExpectTarget } from './noFollowWrite.js';

const READ_RETRY_DELAYS_MS = [50, 150, 300];

function utf8Sha256(content: string): string {
  return crypto.createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function isMissingLeaf(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function win32RetryAbsence(abs: string): boolean {
  if (process.platform !== 'win32') return false;
  for (const delay of READ_RETRY_DELAYS_MS) {
    try {
      fs.lstatSync(abs);
      return false;
    } catch (err) {
      if (!isMissingLeaf(err)) throw err;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
  try {
    fs.lstatSync(abs);
    return false;
  } catch (err) {
    if (!isMissingLeaf(err)) throw err;
  }
  return true;
}

function leafAbsent(root: string, rel: string): boolean {
  const abs = safeVaultJoin(root, rel, { writeMode: true });
  try {
    fs.lstatSync(abs);
    return false;
  } catch (err) {
    if (!isMissingLeaf(err)) throw err;
  }
  if (process.platform !== 'win32') return true;
  return win32RetryAbsence(abs);
}

function writeCasBytes(root: string, rel: string, content: string, expectTarget: ExpectTarget): void {
  const abs = safeVaultJoin(root, rel, { writeMode: true });
  const buf = Buffer.from(content, 'utf-8');
  if (buf.byteLength > MAX_VAULT_FILE_BYTES) throw new VaultFileTooLargeError(buf.byteLength);
  writeNoFollowAtomic(abs, buf, { durable: true, mkdir: true, rel, expectTarget });
  markSelfWrite(abs);
}

export function writeVaultFileCas(
  root: string,
  rel: string,
  content: string,
  expectedSha256: string | null,
): { path: string; bytes: number; sha256: string } {
  const writtenSha = utf8Sha256(content);
  const bytes = Buffer.byteLength(content, 'utf-8');

  if (expectedSha256 === null) {
    if (!leafAbsent(root, rel)) {
      throw new VaultWriteRefusedError('STALE', rel);
    }
    writeCasBytes(root, rel, content, 'absent');
    return { path: rel, bytes, sha256: writtenSha };
  }

  let snapshot;
  try {
    snapshot = readVaultFileBounded(root, rel);
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
    writeCasBytes(root, rel, content, expectTarget);
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