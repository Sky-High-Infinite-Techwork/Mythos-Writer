/** Result of a scene vault write through the IPC bridge (resolves, may carry `{ error }`). */
export function vaultWriteRefused(result: unknown): boolean {
  if (!result || typeof result !== 'object') return true;
  const record = result as { error?: unknown; bytes?: unknown };
  if (typeof record.error === 'string' && record.error.length > 0) return true;
  const bytes = record.bytes;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return true;
  return false;
}

/**
 * Persist scene markdown via `writeVault`. Returns true only when bytes landed on disk.
 * Throws from the bridge are treated as failure (no rethrow).
 */
export async function writeSceneVault(
  writeVault: (path: string, content: string) => Promise<unknown>,
  path: string,
  content: string,
): Promise<boolean> {
  try {
    const result = await writeVault(path, content);
    return !vaultWriteRefused(result);
  } catch {
    return false;
  }
}

export function sceneSaveFailureMessage(sceneTitle: string, missing?: boolean): string {
  const base = `Couldn't save “${sceneTitle}”. Your text is still in the editor.`;
  if (missing) {
    return `${base} The scene is no longer in the story list.`;
  }
  return base;
}

export interface SceneSaveFailureEntry {
  storyId: string;
  sceneId: string;
  sceneTitle: string;
  missing?: boolean;
  /** Vault that was active when the write started — isolates banners across switches. */
  vaultRoot: string;
  vaultSwitchGeneration: number;
}

export interface ScenePersistContext {
  vaultRoot: string;
  vaultSwitchGeneration: number;
  writeGeneration: number;
}

export type ScenePersistStatus = 'success' | 'failed' | 'stale';

/** Placeholder story id when the scene cannot be located in the manifest yet. */
export const UNKNOWN_STORY_ID = '?';

export interface ScenePersistOutcome {
  status: ScenePersistStatus;
  started: ScenePersistContext;
}

export function beginSceneWriteGeneration(generations: Map<string, number>, sceneId: string): number {
  const next = (generations.get(sceneId) ?? 0) + 1;
  generations.set(sceneId, next);
  return next;
}

export function shouldApplyScenePersistOutcome(
  started: ScenePersistContext,
  currentVaultRoot: string,
  currentVaultGeneration: number,
  generations: Map<string, number>,
  sceneId: string,
): boolean {
  return (
    started.vaultRoot === currentVaultRoot
    && started.vaultSwitchGeneration === currentVaultGeneration
    && generations.get(sceneId) === started.writeGeneration
  );
}

export function sceneFailuresForVault(
  failures: ReadonlyMap<string, SceneSaveFailureEntry>,
  vaultRoot: string,
  vaultSwitchGeneration: number,
): SceneSaveFailureEntry[] {
  return [...failures.values()].filter(
    (e) => e.vaultRoot === vaultRoot && e.vaultSwitchGeneration === vaultSwitchGeneration,
  );
}

export function sceneFailureKey(storyId: string, sceneId: string): string {
  return `${storyId}:${sceneId}`;
}

export function upsertSceneFailure(
  prev: ReadonlyMap<string, SceneSaveFailureEntry>,
  entry: SceneSaveFailureEntry,
): Map<string, SceneSaveFailureEntry> {
  const next = new Map(prev);
  next.set(sceneFailureKey(entry.storyId, entry.sceneId), { ...entry, missing: false });
  return next;
}

export function removeSceneFailure(
  prev: ReadonlyMap<string, SceneSaveFailureEntry>,
  storyId: string,
  sceneId: string,
): Map<string, SceneSaveFailureEntry> {
  const next = new Map(prev);
  next.delete(sceneFailureKey(storyId, sceneId));
  return next;
}

/** Drop failure rows for a scene — including the unknown-story key from pre-manifest writes. */
export function clearSceneFailuresOnSuccess(
  prev: ReadonlyMap<string, SceneSaveFailureEntry>,
  storyId: string,
  sceneId: string,
): Map<string, SceneSaveFailureEntry> {
  let next = removeSceneFailure(prev, storyId, sceneId);
  next = removeSceneFailure(next, UNKNOWN_STORY_ID, sceneId);
  for (const [key, entry] of next) {
    if (entry.sceneId === sceneId && key !== sceneFailureKey(storyId, sceneId)) {
      next.delete(key);
    }
  }
  return next;
}

export function markSceneFailureMissing(
  prev: ReadonlyMap<string, SceneSaveFailureEntry>,
  storyId: string,
  sceneId: string,
): Map<string, SceneSaveFailureEntry> {
  const key = sceneFailureKey(storyId, sceneId);
  const cur = prev.get(key);
  if (!cur) return new Map(prev);
  const next = new Map(prev);
  next.set(key, { ...cur, missing: true });
  return next;
}