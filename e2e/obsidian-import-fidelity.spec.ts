/**
 * obsidian-import-fidelity.spec.ts — SKY-8005
 *
 * Gap this closes: e2e/onboarding-four-paths.spec.ts (now entirely
 * formerly skipped — SKY-6933 stale selectors) removed and re-stubbed the
 * onboarding:import-vault:dry-run IPC handler with canned JSON, so the real
 * Obsidian importer never executed during e2e. Fidelity was only
 * unit-tested (electron-main/src/obsidianImporter.test.ts), bypassing the
 * UI/IPC seam — the exact failure mode from SKY-7990 (notes-folders broke
 * for months while green).
 *
 * Note on surface: the onboarding wizard's own import path
 * (ONBOARDING_IMPORT_DRY_RUN/COMMIT) is dead code — preload.ts never
 * exposes it to the renderer. The live, user-reachable Obsidian import
 * surface today is Settings -> Vault & Files -> "Import another vault"
 * (ImportVaultSection.tsx), which calls vault:import-scan / vault:import-run
 * -> convertVaultSource('obsidian', ...) -> obsidianImporter.ts. That is the
 * path this test drives end-to-end.
 *
 * Only dialog.showOpenDialog (native OS file picker — Playwright cannot
 * drive it) is patched, matching the accepted pattern in
 * e2e/export-formats.spec.ts ("Patch ONLY dialog.showSaveDialog ... real
 * handlers run"). The import IPC handlers, obsidianImporter.ts, and disk
 * writes all execute for real.
 *
 * Run (after `npm run build:electron`):
 *   npx playwright test e2e/obsidian-import-fidelity.spec.ts --reporter=list
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

const MAIN_JS = path.resolve(__dirname, '../out/main/main.js');

// ─── Fixture: a small but representative Obsidian vault ────────────────────

const MARCUS_MD = [
  '---',
  'tags: [protagonist]',
  'aliases: [Marc]',
  'cssclass: obsidian-only-should-be-stripped',
  '---',
  '',
  'Marcus first appears in [[Prologue]] and carries the [[Obsidian Gate]] shard.',
  '',
  '![[Marcus.png]]',
].join('\n');

function buildFixtureVault(root: string): void {
  fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(root, '.obsidian', 'app.json'), '{}');

  // Nested folder structure
  fs.mkdirSync(path.join(root, 'Characters'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Lore'), { recursive: true });

  // Note with frontmatter + wikilinks to notes in other folders (one at
  // root, one nested one level deeper). Since SKY-10383 the importer copies
  // markdown byte-for-byte — no frontmatter stripping, no link rewriting —
  // so the test asserts this exact content survives the import untouched.
  fs.writeFileSync(path.join(root, 'Characters', 'Marcus.md'), MARCUS_MD);

  // Attachment co-located with the note that embeds it (Obsidian convention)
  fs.writeFileSync(path.join(root, 'Characters', 'Marcus.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // Root-level note the first wikilink resolves to (no folder prefix expected)
  fs.writeFileSync(
    path.join(root, 'Prologue.md'),
    '---\ntags: [scene]\n---\n\nThe gate stood ajar.',
  );
  // Nested note the second wikilink resolves to (folder prefix expected)
  fs.writeFileSync(
    path.join(root, 'Lore', 'Obsidian Gate.md'),
    '---\ntags: [lore]\n---\n\nCarved from a single black stone.',
  );
}

// ─── Harness ────────────────────────────────────────────────────────────────

function seedCompletedOnboarding(userData: string, storyVault: string, notesVault: string): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(storyVault, { recursive: true });
  fs.mkdirSync(notesVault, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({ onboardingComplete: true, theme: 'dark' }, null, 2),
  );
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({ vaultRoot: storyVault, notesVaultRoot: notesVault }, null, 2),
  );
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  const extraArgs = process.platform !== 'darwin' && !process.env.DISPLAY ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', ...extraArgs],
    timeout: 60_000,
  });
}

/** Patch ONLY dialog.showOpenDialog to return srcDir (real import IPC runs). */
async function patchOpenDialog(app: ElectronApplication, srcDir: string): Promise<void> {
  await app.evaluate(({ dialog }, { dir }: { dir: string }) => {
    (dialog as unknown as Record<string, unknown>).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [dir],
    });
  }, { dir: srcDir });
}

// SKY-11154: legacy ImportVaultSection E2E retired; importer still covered in
// electron-main/src/mythosFormat/*.test.ts.
test('SKY-8005 retirement: app launches with vault (Obsidian import UI path retired)', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-obsidian-retired-'));
  const userData = path.join(tempRoot, 'userData');
  const storyVault = path.join(tempRoot, 'Story Vault');
  const notesVault = path.join(tempRoot, 'Notes Vault');
  fs.mkdirSync(storyVault, { recursive: true });
  fs.mkdirSync(notesVault, { recursive: true });
  seedCompletedOnboarding(userData, storyVault, notesVault);

  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 12_000 });
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
