/** Apply save-indicator side effects after a scene vault persist attempt (#1904 gate). */
export function applySceneSaveIndicatorAfterPersist(
  saved: boolean,
  timers: { clearPending: () => void; scheduleSaved: () => void },
): void {
  if (!saved) {
    timers.clearPending();
    return;
  }
  timers.scheduleSaved();
}