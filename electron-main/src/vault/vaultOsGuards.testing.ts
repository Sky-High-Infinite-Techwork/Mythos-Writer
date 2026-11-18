// Test-only OS capability probes and cross-platform refusal assertions for vault tests.

import { expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { sanitizeIpcError } from '../ipcErrors.js';

function probeVaultOsCapabilities(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-vault-os-probe-'));
  try {
    let symlinkOk = true;
    try {
      fs.symlinkSync('target', path.join(dir, 'link'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM') symlinkOk = false;
      else throw err;
    }
    symlinksWork = symlinkOk;

    let hardlinkOk = true;
    const a = path.join(dir, 'hard-a.txt');
    const b = path.join(dir, 'hard-b.txt');
    fs.writeFileSync(a, 'hardlink-probe');
    try {
      fs.linkSync(a, b);
      hardlinkOk = fs.statSync(a).nlink >= 2;
    } catch {
      hardlinkOk = false;
    }
    hardlinksWork = hardlinkOk;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Set at module load so `it.skipIf(!symlinksWork)` is a real boolean during collection. */
export let symlinksWork = true;
/** Set at module load so `it.skipIf(!hardlinksWork)` is a real boolean during collection. */
export let hardlinksWork = true;

probeVaultOsCapabilities();

export type VaultReadRefusalMessage = 'Invalid input.' | 'Path not allowed.' | 'Permission denied.';

/** Assert bounded read failed closed for the renderer with an exact IPC message (never Internal error.). */
export function expectVaultReadRefused(
  err: unknown,
  expected: VaultReadRefusalMessage,
  channel = 'vault:read',
): void {
  expect(err).toBeTruthy();
  const sanitized = sanitizeIpcError(channel, err).error;
  expect(sanitized).not.toBe('File not found.');
  expect(sanitized).not.toBe('Internal error.');
  expect(sanitized).toBe(expected);
}

/** Directory open: EISDIR on POSIX; EPERM/EACCES/EINVAL paths on native Windows. */
export function expectVaultReadRefusedDirectory(err: unknown): void {
  expect(err).toBeTruthy();
  const sanitized = sanitizeIpcError('vault:read', err).error;
  expect(sanitized).not.toBe('File not found.');
  expect(sanitized).not.toBe('Internal error.');
  if (process.platform !== 'win32') {
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
    expect(sanitized).toBe('Invalid input.');
  } else {
    const win32DirectoryRefusals: VaultReadRefusalMessage[] = [
      'Invalid input.',
      'Path not allowed.',
      'Permission denied.',
    ];
    expect(win32DirectoryRefusals).toContain(sanitized);
  }
}