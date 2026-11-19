import {
  shouldApplyScenePersistOutcome,
  type ScenePersistOutcome,
} from './scenePersist';
import { applySceneSaveIndicatorAfterPersist } from './sceneSaveIndicator';

export type { ScenePersistOutcome };

export function applyAfterSceneVaultPersist(
  outcome: ScenePersistOutcome,
  current: {
    vaultRoot: string;
    vaultSwitchGeneration: number;
    generations: ReadonlyMap<string, number>;
    sceneId: string;
  },
  sideEffects: {
    snapshotSave: () => void;
    clearPending: () => void;
    scheduleSaved: () => void;
  },
): void {
  if (outcome.status === 'stale') return;
  const contextLive = shouldApplyScenePersistOutcome(
    outcome.started,
    current.vaultRoot,
    current.vaultSwitchGeneration,
    new Map(current.generations),
    current.sceneId,
  );
  if (!contextLive) return;
  sideEffects.snapshotSave();
  applySceneSaveIndicatorAfterPersist(outcome.status, sideEffects);
}