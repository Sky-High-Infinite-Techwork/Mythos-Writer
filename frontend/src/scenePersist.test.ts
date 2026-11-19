import { describe, expect, it, vi } from 'vitest';
import {
  beginSceneWriteGeneration,
  markSceneFailureMissing,
  removeSceneFailure,
  sceneFailuresForVault,
  sceneSaveFailureMessage,
  shouldApplyScenePersistOutcome,
  upsertSceneFailure,
  vaultWriteRefused,
  writeSceneVault,
  type SceneSaveFailureEntry,
} from './scenePersist';

describe('vaultWriteRefused', () => {
  it('treats a resolved { error, bytes: 0, code } as refused', () => {
    expect(vaultWriteRefused({ path: 'x.md', bytes: 0, error: 'EACCES', code: 'EACCES' })).toBe(true);
  });

  it('treats sanitized Permission denied (no bytes field) as refused', () => {
    expect(vaultWriteRefused({ error: 'Permission denied.' })).toBe(true);
  });

  it('treats { path } without bytes as refused', () => {
    expect(vaultWriteRefused({ path: 'stories/a/Scene.md' })).toBe(true);
  });

  it('treats empty error string with bytes as not refused', () => {
    expect(vaultWriteRefused({ error: '', bytes: 10 })).toBe(false);
  });

  it('treats a successful { bytes > 0 } payload as ok', () => {
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

describe('scene write generation', () => {
  it('ignores stale write outcomes when a newer write superseded this one', () => {
    const gens = new Map<string, number>();
    const first = beginSceneWriteGeneration(gens, 'sc-1');
    beginSceneWriteGeneration(gens, 'sc-1');
    const started = { vaultRoot: '/vault-a', vaultSwitchGeneration: 1, writeGeneration: first };
    expect(
      shouldApplyScenePersistOutcome(started, '/vault-a', 1, gens, 'sc-1'),
    ).toBe(false);
    expect(
      shouldApplyScenePersistOutcome(
        { vaultRoot: '/vault-a', vaultSwitchGeneration: 1, writeGeneration: 2 },
        '/vault-a',
        1,
        gens,
        'sc-1',
      ),
    ).toBe(true);
  });
});

describe('vault-isolated failure entries', () => {
  const entryA: SceneSaveFailureEntry = {
    storyId: 's', sceneId: '1', sceneTitle: 'A', vaultRoot: '/vault-a', vaultSwitchGeneration: 0,
  };
  const entryB: SceneSaveFailureEntry = {
    storyId: 's', sceneId: '2', sceneTitle: 'B', vaultRoot: '/vault-b', vaultSwitchGeneration: 0,
  };

  it('only retries failures for the active vault generation', () => {
    const map = upsertSceneFailure(upsertSceneFailure(new Map(), entryA), entryB);
    expect(sceneFailuresForVault(map, '/vault-a', 0)).toEqual([{ ...entryA, missing: false }]);
    expect(sceneFailuresForVault(map, '/vault-b', 0)).toEqual([{ ...entryB, missing: false }]);
    expect(sceneFailuresForVault(map, '/vault-a', 1)).toEqual([]);
  });
});

describe('scene save failure map', () => {
  const a: SceneSaveFailureEntry = {
    storyId: 'st-a', sceneId: 'sc-1', sceneTitle: 'Alpha', vaultRoot: '/v', vaultSwitchGeneration: 0,
  };
  const b: SceneSaveFailureEntry = {
    storyId: 'st-a', sceneId: 'sc-2', sceneTitle: 'Beta', vaultRoot: '/v', vaultSwitchGeneration: 0,
  };

  it('keeps banner for the other scene when one entry clears', () => {
    let map = upsertSceneFailure(new Map(), a);
    map = upsertSceneFailure(map, b);
    map = removeSceneFailure(map, a.storyId, a.sceneId);
    expect(map.size).toBe(1);
    expect(map.has('st-a:sc-2')).toBe(true);
  });

  it('marks missing when retry target is gone', () => {
    let map = upsertSceneFailure(new Map(), a);
    map = markSceneFailureMissing(map, a.storyId, a.sceneId);
    expect(map.get('st-a:sc-1')?.missing).toBe(true);
  });
});

describe('sceneSaveFailureMessage', () => {
  it('includes the scene title in Ivy copy', () => {
    expect(sceneSaveFailureMessage('The Gate')).toBe(
      "Couldn't save “The Gate”. Your text is still in the editor.",
    );
  });
});