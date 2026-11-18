import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { planUninstallRecovery } from './uninstallRecoveryPlan.js';
import { cleanUninstall } from './uninstallHelper.js';

describe('planUninstallRecovery', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-uninstall-recovery-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports fullyCleared when both roots are gone', () => {
    const story = path.join(tmp, 'story');
    const notes = path.join(tmp, 'notes');

    const plan = planUninstallRecovery(story, notes);

    expect(plan).toEqual({
      storyVaultSurvived: false,
      notesVaultSurvived: false,
      fullyCleared: true,
    });
  });

  it('reports both survived when neither root was removed', () => {
    const story = path.join(tmp, 'story');
    const notes = path.join(tmp, 'notes');
    fs.mkdirSync(story);
    fs.mkdirSync(notes);

    const plan = planUninstallRecovery(story, notes);

    expect(plan).toEqual({
      storyVaultSurvived: true,
      notesVaultSurvived: true,
      fullyCleared: false,
    });
  });

  // SKY-9730: story-vault-survives + notes-vault-gone must recover ONLY the
  // story side — recovering notes too would re-scaffold a vault that was
  // just successfully deleted.
  it('reports only the story side survived when notes vault was deleted', () => {
    const story = path.join(tmp, 'story');
    const notes = path.join(tmp, 'notes');
    fs.mkdirSync(story); // survives (simulated failed delete)
    // notes never created / already removed

    const plan = planUninstallRecovery(story, notes);

    expect(plan).toEqual({
      storyVaultSurvived: true,
      notesVaultSurvived: false,
      fullyCleared: false,
    });
  });

  // Symmetric case: notes survives, story is gone.
  it('reports only the notes side survived when story vault was deleted', () => {
    const story = path.join(tmp, 'story');
    const notes = path.join(tmp, 'notes');
    fs.mkdirSync(notes);

    const plan = planUninstallRecovery(story, notes);

    expect(plan).toEqual({
      storyVaultSurvived: false,
      notesVaultSurvived: true,
      fullyCleared: false,
    });
  });

  // Custom vault roots are warn-only (not in toDelete). Drive cleanUninstall and
  // assert both sides survive, then plan recovery as fully uncleared.
  it('plans recovery when cleanUninstall keeps user-chosen vault folders outside default parent', () => {
    const customStory = path.join(tmp, 'custom-story');
    const customNotes = path.join(tmp, 'custom-notes');
    fs.mkdirSync(customStory, { recursive: true });
    fs.writeFileSync(path.join(customStory, 'scene.md'), '# Scene');
    fs.mkdirSync(customNotes, { recursive: true });
    fs.writeFileSync(path.join(customNotes, 'note.md'), '# Note');

    const result = cleanUninstall({
      storyVaultRoot: customStory,
      notesVaultRoot: customNotes,
      userDataPath: tmp,
    });

    expect(result.customPathsWarning).toContain(customStory);
    expect(result.customPathsWarning).toContain(customNotes);
    expect(fs.existsSync(customStory)).toBe(true);
    expect(fs.existsSync(customNotes)).toBe(true);

    const plan = planUninstallRecovery(customStory, customNotes);
    expect(plan.storyVaultSurvived).toBe(true);
    expect(plan.notesVaultSurvived).toBe(true);
    expect(plan.fullyCleared).toBe(false);
  });

  // Integration-style: default bundle delete with a forced rm failure on the vaults
  // parent mirrors a locked bundle while settings still clear — SKY-9730-style partial.
  it('plans recovery for only the surviving side after default-bundle rm fails on story half', () => {
    const vaultsParent = path.join(tmp, 'vaults');
    const storyVault = path.join(vaultsParent, 'Story Vault');
    const notesVault = path.join(vaultsParent, 'Notes Vault');
    fs.mkdirSync(storyVault, { recursive: true });
    fs.writeFileSync(path.join(storyVault, 'scene.md'), '# Scene');
    fs.mkdirSync(notesVault, { recursive: true });
    fs.writeFileSync(path.join(notesVault, 'note.md'), '# Note');

    const originalRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((p, opts) => {
      if (p === vaultsParent) return undefined; // silent no-op: bundle still on disk
      return originalRmSync(p as fs.PathLike, opts as fs.RmOptions);
    });

    try {
      const result = cleanUninstall({
        storyVaultRoot: storyVault,
        notesVaultRoot: notesVault,
        userDataPath: tmp,
      });

      expect(result.errors.some((e) => e.startsWith(vaultsParent))).toBe(true);
      expect(fs.existsSync(storyVault)).toBe(true);
      expect(fs.existsSync(notesVault)).toBe(true);

      // Simulate notes side gone after a successful partial clear elsewhere.
      fs.rmSync(notesVault, { recursive: true, force: true });

      const plan = planUninstallRecovery(storyVault, notesVault);
      expect(plan.storyVaultSurvived).toBe(true);
      expect(plan.notesVaultSurvived).toBe(false);
      expect(plan.fullyCleared).toBe(false);
      expect(fs.existsSync(notesVault)).toBe(false);
    } finally {
      rmSpy.mockRestore();
    }
  });
});
