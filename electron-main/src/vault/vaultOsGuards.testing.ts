// Test-only OS capability probes and cross-platform refusal assertions for vault tests.

import { expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { sanitizeIpcError } from '../ipcErrors.js';

export let symlinksWork = true;
export let hardlinksWork = true;

export function installVaultOsCapabilityProbes(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-vault-os-probe-'));
  try {
    try {
      fs.symlinkSync('target', path.join(dir, 'link'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM') symlinksWork = false;
      else throw err;
    }
    const a = path.join(dir, 'hard-a.txt');
    const b = path.join(dir, 'hard-b.txt');
    fs.writeFileSync(a, 'hardlink-probe');
    try {
      fs.linkSync(a, b);
      hardlinksWork = fs.statSync(a).nlink >= 2;
    } catch {
      hardlinksWork = false;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const READ_REFUSAL_MESSAGES = [
  'Invalid input.',
  'Path not allowed.',
  'Permission denied.',
  'Internal error.',
] as const;

/** Assert bounded read failed closed for the renderer (errno may differ on win32). */
export function expectVaultReadRefused(err: unknown, channel = 'vault:read'): void {
  expect(err).toBeTruthy();
  const sanitized = sanitizeIpcError(channel, err).error;
  expect(sanitized).not.toBe('File not found.');
  expect(READ_REFUSAL_MESSAGES).toContain(sanitized);
}

/** Directory open: EISDIR on POSIX; EPERM/EACCES/EINVAL paths on native Windows. */
export function expectVaultReadRefusedDirectory(err: unknown): void {
  expectVaultReadRefused(err);
  if (process.platform !== 'win32') {
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
    expect(sanitizeIpcError('vault:read', err).error).toBe('Invalid input.');
  }
}