import { describe, expect, it, vi } from 'vitest';
import { sceneSaveFailureMessage, vaultWriteRefused, writeSceneVault } from './scenePersist';

describe('vaultWriteRefused', () => {
  it('treats a resolved { error, bytes: 0 } as refused', () => {
    expect(vaultWriteRefused({ path: 'x.md', bytes: 0, error: 'EACCES', code: 'EACCES' })).toBe(true);
  });

  it('treats a successful { bytes } payload as ok', () => {
    expect(vaultWriteRefused({ path: 'x.md', bytes: 42 })).toBe(false);
  });

  it('treats a non-object as refused', () => {
    expect(vaultWriteRefused(null)).toBe(true);
  });
});

describe('writeSceneVault', () => {
  it('returns false when writeVault resolves { error, code }', async () => {
    const writeVault = vi.fn().mockResolvedValue({
      path: 'stories/a/Scene.md',
      bytes: 0,
      error: 'Permission denied',
      code: 'EACCES',
    });
    await expect(writeSceneVault(writeVault, 'stories/a/Scene.md', 'body')).resolves.toBe(false);
  });

  it('returns false when writeVault rejects', async () => {
    const writeVault = vi.fn().mockRejectedValue(new Error('disk full'));
    await expect(writeSceneVault(writeVault, 'stories/a/Scene.md', 'body')).resolves.toBe(false);
  });

  it('returns true when writeVault resolves bytes', async () => {
    const writeVault = vi.fn().mockResolvedValue({ path: 'stories/a/Scene.md', bytes: 12 });
    await expect(writeSceneVault(writeVault, 'stories/a/Scene.md', 'body')).resolves.toBe(true);
  });
});

describe('sceneSaveFailureMessage', () => {
  it('includes the scene title in Ivy copy', () => {
    expect(sceneSaveFailureMessage('The Gate')).toBe(
      "Couldn't save “The Gate”. Your text is still in the editor.",
    );
  });
});