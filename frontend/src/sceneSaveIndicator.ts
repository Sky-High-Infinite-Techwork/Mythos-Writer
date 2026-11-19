import type { ScenePersistStatus } from './scenePersist';

/** Apply save-indicator side effects after a scene vault persist attempt (#1904 gate). */
export function applySceneSaveIndicatorAfterPersist(
  status: Exclude<ScenePersistStatus, 'stale'>,
  timers: { clearPending: () => void; scheduleSaved: () => void },
): void {
  if (status === 'failed') {
    timers.clearPending();
    return;
  }
  timers.scheduleSaved();
}