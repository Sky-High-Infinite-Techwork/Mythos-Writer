import { describe, expect, it, vi } from 'vitest';
import { applySceneSaveIndicatorAfterPersist } from './sceneSaveIndicator';

describe('applySceneSaveIndicatorAfterPersist', () => {
  it('clears pending indicator on failure instead of scheduling saved', () => {
    const clearPending = vi.fn();
    const scheduleSaved = vi.fn();
    applySceneSaveIndicatorAfterPersist(false, { clearPending, scheduleSaved });
    expect(clearPending).toHaveBeenCalledTimes(1);
    expect(scheduleSaved).not.toHaveBeenCalled();
  });

  it('schedules saved only on success', () => {
    const clearPending = vi.fn();
    const scheduleSaved = vi.fn();
    applySceneSaveIndicatorAfterPersist(true, { clearPending, scheduleSaved });
    expect(scheduleSaved).toHaveBeenCalledTimes(1);
    expect(clearPending).not.toHaveBeenCalled();
  });
});