// Mutation-hardening coverage for settings/user-data atomic writes (test gap 08).
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { VaultWriteRefusedError } from '../vault/noFollowWrite.js';
import { SETTINGS_LINK_TEXT } from '../vault/writeErrors.js';
import {
  atomicTempPath,
  deleteLeftoverAtomicTemps,
  writeFileAtomicSecure,
  writeJsonAtomicSecure,
} from './atomicWrite.js';
import * as noFollowWrite from '../vault/noFollowWrite.js';

function trySymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOTSUP') return false;
    throw err;
  }
}

describe('atomicWrite', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('atomicTempPath places a unique temp beside the target using pid and random hex', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-temp-'));
    const target = path.join(dir, 'secrets.json');
    const a = atomicTempPath(target);
    const b = atomicTempPath(target);
    expect(path.basename(a)).toMatch(/^secrets\.json\.\d+-[0-9a-f]{12}\.tmp$/);
    expect(b).not.toBe(a);
    expect(path.dirname(a)).toBe(dir);
  });

  it('writeFileAtomicSecure creates parent directories when mkdir is enabled', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-mkdir-'));
    const nested = path.join(dir, 'nested', 'settings.json');
    writeFileAtomicSecure(nested, '{"ok":true}\n');
    expect(fs.readFileSync(nested, 'utf-8')).toContain('ok');
  });

  it('writeJsonAtomicSecure writes pretty JSON with a trailing newline', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-'));
    const target = path.join(dir, 'app-settings.json');
    writeJsonAtomicSecure(target, { theme: 'dark', count: 2 });
    const raw = fs.readFileSync(target, 'utf-8');
    expect(raw).toBe(`${JSON.stringify({ theme: 'dark', count: 2 }, null, 2)}\n`);
  });

  it('maps LEAF_LINK, HANDLE_MISMATCH, and SWAP refusals to SETTINGS_LINK_TEXT', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-map-'));
    const target = path.join(dir, 'settings.json');
    for (const code of ['LEAF_LINK', 'HANDLE_MISMATCH', 'SWAP'] as const) {
      vi.spyOn(noFollowWrite, 'writeNoFollowAtomic').mockImplementationOnce(() => {
        throw new VaultWriteRefusedError(code, 'settings.json');
      });
      expect(() => writeFileAtomicSecure(target, '{}')).toThrow(SETTINGS_LINK_TEXT);
    }
  });

  it('rethrows VaultWriteRefusedError codes that are not link/handle/swap', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-rethrow-'));
    const target = path.join(dir, 'settings.json');
    vi.spyOn(noFollowWrite, 'writeNoFollowAtomic').mockImplementationOnce(() => {
      throw new VaultWriteRefusedError('HARD_LINK', 'settings.json');
    });
    expect(() => writeFileAtomicSecure(target, '{}')).toThrow(/HARD_LINK/);
  });

  it('refuses when the target path is a symlink leaf', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-symlink-'));
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, 'KEEP\n', 'utf-8');
    const link = path.join(dir, 'settings.json');
    if (!trySymlink(outside, link)) return;
    expect(() => writeFileAtomicSecure(link, 'nope')).toThrow(SETTINGS_LINK_TEXT);
    expect(fs.readFileSync(outside, 'utf-8')).toBe('KEEP\n');
  });

  it('deleteLeftoverAtomicTemps removes only matching regular-file temps, not symlinks or dirs', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-leftover-'));
    const target = path.join(dir, 'settings.json');
    fs.writeFileSync(target, '{"ok":true}\n', 'utf-8');
    const goodTemp = `${target}.${process.pid}-abcabcabcabc.tmp`;
    const shortName = `${target}..tmp`;
    const wrongPattern = path.join(dir, 'settings.wrongsuffix.tmp');
    const wrongBase = path.join(dir, 'other.json.1-abcabcabcabc.tmp');
    fs.writeFileSync(goodTemp, 'tmp', 'utf-8');
    fs.writeFileSync(shortName, 'tmp', 'utf-8');
    fs.writeFileSync(wrongPattern, 'tmp', 'utf-8');
    fs.writeFileSync(wrongBase, 'tmp', 'utf-8');
    const subdir = `${target}.${process.pid}-dddddddddddd.tmp`;
    fs.mkdirSync(subdir);
    const sym = `${target}.${process.pid}-eeeeeeeeeeee.tmp`;
    const symlinked = trySymlink(target, sym);
    deleteLeftoverAtomicTemps([target]);
    expect(fs.existsSync(goodTemp)).toBe(false);
    expect(fs.existsSync(shortName)).toBe(true);
    expect(fs.existsSync(wrongPattern)).toBe(true);
    expect(fs.existsSync(wrongBase)).toBe(true);
    expect(fs.existsSync(subdir)).toBe(true);
    if (symlinked) {
      expect(fs.lstatSync(sym).isSymbolicLink()).toBe(true);
    }
  });
});