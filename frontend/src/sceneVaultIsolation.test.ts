import { describe, expect, it } from 'vitest';
import {
  beginSceneWriteGeneration,
  shouldApplyScenePersistOutcome,
  upsertSceneFailure,
  type SceneSaveFailureEntry,
} from './scenePersist';

/**
 * Codex security lane: delayed failure from vault A must not surface in vault B
 * after switch (matching scene ids).
 */
describe('scene vault isolation (#1919)', () => {
  it('rejects persist UI updates when vault switch superseded the in-flight write', () => {
    const gens = new Map<string, number>();
    const writeGen = beginSceneWriteGeneration(gens, 'sc-1');
    const started = { vaultRoot: '/vault-a', vaultSwitchGeneration: 0, writeGeneration: writeGen };
    expect(
      shouldApplyScenePersistOutcome(started, '/vault-b', 1, gens, 'sc-1'),
    ).toBe(false);
  });

  it('keeps vault-a failure entries out of vault-b retry set', () => {
    const entryA: SceneSaveFailureEntry = {
      storyId: 's',
      sceneId: 'sc-dup',
      sceneTitle: 'Title from vault A',
      vaultRoot: '/vault-a',
      vaultSwitchGeneration: 0,
    };
    const map = upsertSceneFailure(new Map(), entryA);
    expect([...map.values()].every((e) => e.vaultRoot === '/vault-a')).toBe(true);
    expect(
      shouldApplyScenePersistOutcome(
        { vaultRoot: '/vault-a', vaultSwitchGeneration: 0, writeGeneration: 1 },
        '/vault-b',
        1,
        new Map([['sc-dup', 1]]),
        'sc-dup',
      ),
    ).toBe(false);
  });
});