import { describe, expect, it, vi } from 'vitest';
import { applyAfterSceneVaultPersist } from './sceneSaveAfterPersist';

describe('applyAfterSceneVaultPersist', () => {
  const started = {
    vaultRoot: '/vault-a',
    vaultSwitchGeneration: 0,
    writeGeneration: 1,
  };

  it('skips snapshot and save indicator for stale persist outcomes', () => {
    const snapshotSave = vi.fn();
    const scheduleSaved = vi.fn();
    const clearPending = vi.fn();
    applyAfterSceneVaultPersist(
      { status: 'stale', started },
      {
        vaultRoot: '/vault-a',
        vaultSwitchGeneration: 0,
        generations: new Map([['sc-1', 1]]),
        sceneId: 'sc-1',
      },
      { snapshotSave, scheduleSaved, clearPending },
    );
    expect(snapshotSave).not.toHaveBeenCalled();
    expect(scheduleSaved).not.toHaveBeenCalled();
    expect(clearPending).not.toHaveBeenCalled();
  });

  it('does not apply vault A snapshot or saved indicator on vault B with matching scene id', () => {
    const snapshotSave = vi.fn();
    const scheduleSaved = vi.fn();
    applyAfterSceneVaultPersist(
      { status: 'success', started },
      {
        vaultRoot: '/vault-b',
        vaultSwitchGeneration: 1,
        generations: new Map([['sc-dup', 1]]),
        sceneId: 'sc-dup',
      },
      { snapshotSave, scheduleSaved, clearPending: vi.fn() },
    );
    expect(snapshotSave).not.toHaveBeenCalled();
    expect(scheduleSaved).not.toHaveBeenCalled();
  });

  it('snapshots on refused write when vault context is still current', () => {
    const snapshotSave = vi.fn();
    const clearPending = vi.fn();
    const scheduleSaved = vi.fn();
    applyAfterSceneVaultPersist(
      { status: 'failed', started },
      {
        vaultRoot: '/vault-a',
        vaultSwitchGeneration: 0,
        generations: new Map([['sc-1', 1]]),
        sceneId: 'sc-1',
      },
      { snapshotSave, scheduleSaved, clearPending },
    );
    expect(snapshotSave).toHaveBeenCalledTimes(1);
    expect(clearPending).toHaveBeenCalledTimes(1);
    expect(scheduleSaved).not.toHaveBeenCalled();
  });
});