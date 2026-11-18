/**
 * vault-delete-branches.spec.ts — test-gap audit slice 03 (#1906)
 *
 * Real IPC + shell.trashItem + temp-dir fixtures only. Vault trees live under
 * repo `.tmp/` (disk-backed) so Linux CI can trash them — not os.tmpdir() tmpfs.
 */

import path from 'path';
import fs from 'fs';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const MAIN_JS = path.resolve(__dirname, '../../out/main/main.js');
const TMP_BASE = path.resolve(__dirname, '../../.tmp');
const NOW = '2026-11-18T00:00:00.000Z';

interface VaultBundle {
  mythosRoot: string;
  storyRoot: string;
  notesRoot: string;
  name: string;
}

interface VaultSettings {
  vaultRoot?: string;
  notesVaultRoot?: string;
  recentProjects?: Array<{ name: string; vaultRoot: string; notesVaultRoot?: string; openedAt: string }>;
  hiddenVaultRoots?: string[];
}

function ensureTmpBase() {
  fs.mkdirSync(TMP_BASE, { recursive: true });
}

function seedV2Vault(parent: string, name: string): VaultBundle {
  const mythosRoot = path.join(parent, name);
  const storyRoot = path.join(mythosRoot, 'Story Vault');
  const notesRoot = path.join(mythosRoot, 'Notes Vault');
  fs.mkdirSync(storyRoot, { recursive: true });
  fs.mkdirSync(notesRoot, { recursive: true });
  fs.writeFileSync(
    path.join(mythosRoot, 'mythos.json'),
    JSON.stringify({
      formatVersion: 2,
      id: `vault-${name.replace(/\W/g, '')}`,
      name,
      createdAt: NOW,
      stories: [],
      seed: null,
    }, null, 2),
  );
  fs.writeFileSync(path.join(storyRoot, 'book-seed.md'), '# Seed\n');
  fs.writeFileSync(path.join(notesRoot, 'note.md'), '# Note\n');
  return { mythosRoot, storyRoot, notesRoot, name };
}

function writeUserData(
  userData: string,
  active: VaultBundle,
  others: VaultBundle[] = [],
): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({ onboardingComplete: true, theme: 'dark' }, null, 2),
  );
  const recentProjects = [
    { name: active.name, vaultRoot: active.storyRoot, notesVaultRoot: active.notesRoot, openedAt: NOW },
    ...others.map((o) => ({
      name: o.name,
      vaultRoot: o.storyRoot,
      notesVaultRoot: o.notesRoot,
      openedAt: NOW,
    })),
  ];
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({
      vaultRoot: active.storyRoot,
      notesVaultRoot: active.notesRoot,
      recentProjects,
    }, null, 2),
  );
}

function readVaultSettings(userData: string): VaultSettings {
  return JSON.parse(fs.readFileSync(path.join(userData, 'vault-settings.json'), 'utf-8'));
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  const extraArgs = process.platform !== 'darwin' && !process.env.DISPLAY ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', '--force-prefers-reduced-motion', ...extraArgs],
    timeout: 60_000,
  });
}

async function openVaultFiles(page: Page): Promise<void> {
  await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 20_000 });
  await page.locator('.app-menu-gear-btn').click();
  await page.getByRole('tab', { name: 'Vault & Files' }).click();
  await expect(page.getByTestId('vaults-folder-path')).toBeVisible({ timeout: 10_000 });
}

async function openOverflow(page: Page, testIdSuffix: string): Promise<void> {
  const btn = page.getByTestId(`vault-overflow-btn-${testIdSuffix}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();
  await expect(page.getByTestId(`vault-overflow-menu-${testIdSuffix}`)).toBeVisible({ timeout: 5_000 });
}

function mkFixture(slug: string): { tempRoot: string; userData: string; alpha: VaultBundle; beta: VaultBundle } {
  ensureTmpBase();
  const tempRoot = fs.mkdtempSync(path.join(TMP_BASE, `vault-del-${slug}-`));
  const userData = path.join(tempRoot, 'userData');
  const alpha = seedV2Vault(tempRoot, 'Vault Alpha');
  const beta = seedV2Vault(tempRoot, 'Vault Beta');
  writeUserData(userData, alpha, [beta]);
  return { tempRoot, userData, alpha, beta };
}

// ── 1. Overflow menu on Mythos, Notes, and Story cards ───────────────────────

test('overflow menus on Mythos, Notes, and Story cards expose Hide and Move to Recycle Bin', async () => {
  const { tempRoot, userData, alpha } = mkFixture('menus');
  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await openVaultFiles(page);

    const mythosCard = page.getByTestId(`mvs-card-${alpha.storyRoot}`);
    await expect(mythosCard).toBeVisible({ timeout: 8_000 });
    await openOverflow(page, alpha.storyRoot);
    await expect(page.getByRole('menuitem', { name: 'Hide' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Move to Recycle Bin' })).toBeVisible();

    const notesCard = page.locator('[data-testid^="notes-vault-card-"]').first();
    await expect(notesCard).toBeVisible({ timeout: 8_000 });
    const notesId = ((await notesCard.getAttribute('data-testid')) ?? '').replace('notes-vault-card-', '');
    await openOverflow(page, notesId);
    await expect(page.getByRole('menuitem', { name: 'Hide' })).toBeVisible();

    const storyCard = page.locator('[data-testid^="story-vault-card-"]').first();
    await expect(storyCard).toBeVisible({ timeout: 8_000 });
    const storyId = ((await storyCard.getAttribute('data-testid')) ?? '').replace('story-vault-card-', '');
    await openOverflow(page, storyId);
    await expect(page.getByRole('menuitem', { name: 'Move to Recycle Bin' })).toBeVisible();
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ── 2. Hide → list only; disk unchanged; Show hidden restores ───────────────

test('Hide removes vault from the list without touching disk; Show hidden brings it back', async () => {
  const { tempRoot, userData, alpha, beta } = mkFixture('hide');
  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await openVaultFiles(page);
    await openOverflow(page, beta.storyRoot);
    await page.getByRole('menuitem', { name: 'Hide' }).click();
    await page.getByTestId(`vault-hide-confirm-${beta.storyRoot}`).click();

    await expect(page.getByTestId(`mvs-card-${beta.storyRoot}`)).toHaveCount(0, { timeout: 10_000 });
    expect(fs.existsSync(beta.mythosRoot)).toBe(true);
    expect(readVaultSettings(userData).hiddenVaultRoots).toContain(beta.mythosRoot);

    await page.getByTestId('mvs-show-hidden-btn').click();
    await expect(page.getByTestId(`mvs-unhide-${beta.storyRoot}`)).toBeVisible({ timeout: 8_000 });
    await page.getByTestId(`mvs-unhide-${beta.storyRoot}`).click();
    await expect(page.getByTestId(`mvs-card-${beta.storyRoot}`)).toBeVisible({ timeout: 10_000 });
    const settings = readVaultSettings(userData);
    expect(settings.hiddenVaultRoots ?? []).not.toContain(beta.mythosRoot);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ── 3. Delete → Cancel leaves disk and registry intact ───────────────────────

test('Delete → Cancel leaves the vault folder and recentProjects untouched', async () => {
  const { tempRoot, userData, beta } = mkFixture('cancel');
  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await openVaultFiles(page);
    await openOverflow(page, beta.storyRoot);
    await page.getByRole('menuitem', { name: 'Move to Recycle Bin' }).click();
    await page.getByTestId(`vault-delete-dialog-1-${beta.storyRoot}`).getByRole('button', { name: 'Cancel' }).click();

    expect(fs.existsSync(beta.mythosRoot)).toBe(true);
    const roots = (readVaultSettings(userData).recentProjects ?? []).map((p) => p.vaultRoot);
    expect(roots).toContain(beta.storyRoot);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ── 4. Delete non-active vault → trash + registry prune + no resurrection ────

test('Delete on a non-active Mythos vault trashes the folder and drops it from recentProjects after relaunch', async () => {
  test.setTimeout(120_000);
  const { tempRoot, userData, alpha, beta } = mkFixture('trash-beta');
  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await openVaultFiles(page);
    await openOverflow(page, beta.storyRoot);
    await page.getByRole('menuitem', { name: 'Move to Recycle Bin' }).click();
    await page.getByTestId(`vault-delete-confirm-1-${beta.storyRoot}`).click();
    await expect(page.getByText(/moved to the Recycle Bin/i)).toBeVisible({ timeout: 5_000 });
    await page.getByTestId(`vault-delete-confirm-2-${beta.storyRoot}`).click();

    await expect(page.getByTestId(`mvs-card-${beta.storyRoot}`)).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => fs.existsSync(beta.mythosRoot), { timeout: 60_000, intervals: [250, 500, 1000] }).toBe(false);
    const rootsAfter = (readVaultSettings(userData).recentProjects ?? []).map((p) => p.vaultRoot);
    expect(rootsAfter).not.toContain(beta.storyRoot);
    expect(rootsAfter).toContain(alpha.storyRoot);

    await app.close();
    const app2 = await launchApp(userData);
    try {
      const page2 = await app2.firstWindow();
      await openVaultFiles(page2);
      await expect(page2.getByTestId(`mvs-card-${beta.storyRoot}`)).toHaveCount(0);
      expect(fs.existsSync(beta.mythosRoot)).toBe(false);
    } finally {
      await app2.close().catch(() => undefined);
    }
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ── 5. Delete active vault → shell survives ────────────────────────────────

test('Delete on the active Mythos vault does not crash the shell; another vault remains reachable', async () => {
  test.setTimeout(120_000);
  const { tempRoot, userData, alpha, beta } = mkFixture('trash-active');
  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await openVaultFiles(page);
    await openOverflow(page, alpha.storyRoot);
    await page.getByRole('menuitem', { name: 'Move to Recycle Bin' }).click();
    await page.getByTestId(`vault-delete-confirm-1-${alpha.storyRoot}`).click();
    await page.getByTestId(`vault-delete-confirm-2-${alpha.storyRoot}`).click();

    await expect.poll(() => fs.existsSync(alpha.mythosRoot), { timeout: 30_000 }).toBe(false);
    await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`mvs-card-${beta.storyRoot}`)).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ── 6. Trash failure on read-only parent ───────────────────────────────────

test('Delete failure on a read-only parent shows an error and leaves registry + folder intact', async () => {
  test.setTimeout(120_000);
  const { tempRoot, userData, beta } = mkFixture('readonly');
  const mythosParent = path.dirname(beta.mythosRoot);
  fs.chmodSync(mythosParent, 0o555);

  const app = await launchApp(userData);
  try {
    const trashBlocked = await app.evaluate(async ({ shell }, target) => {
      try {
        await shell.trashItem(target);
        return false;
      } catch {
        return true;
      }
    }, beta.mythosRoot);
    expect(trashBlocked, 'fixture must prove trash really fails on read-only parent').toBe(true);

    const page = await app.firstWindow();
    await openVaultFiles(page);
    await openOverflow(page, beta.storyRoot);
    await page.getByRole('menuitem', { name: 'Move to Recycle Bin' }).click();
    await page.getByTestId(`vault-delete-confirm-1-${beta.storyRoot}`).click();
    await page.getByTestId(`vault-delete-confirm-2-${beta.storyRoot}`).click();

    await expect(page.getByTestId(`vault-delete-failed-${beta.storyRoot}`)).toBeVisible({ timeout: 15_000 });
    expect(fs.existsSync(beta.mythosRoot)).toBe(true);
    expect((readVaultSettings(userData).recentProjects ?? []).map((p) => p.vaultRoot)).toContain(beta.storyRoot);
  } finally {
    try { fs.chmodSync(mythosParent, 0o755); } catch { /* cleanup */ }
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ── 7. Clear all data — keep vaults (Linux) ────────────────────────────────

test('Clear all data with Keep My Vaults removes app data but leaves vault folders', async () => {
  test.setTimeout(120_000);
  ensureTmpBase();
  const tempRoot = fs.mkdtempSync(path.join(TMP_BASE, 'vault-clear-keep-'));
  const userData = path.join(tempRoot, 'userData');
  const bundle = path.join(userData, 'vaults', 'Mythos Vault');
  const vaultDir = path.join(bundle, 'Story Vault');
  const notesVaultDir = path.join(bundle, 'Notes Vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(notesVaultDir, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'app-settings.json'), JSON.stringify({ onboardingComplete: true, theme: 'dark' }, null, 2));
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({ vaultRoot: vaultDir, notesVaultRoot: notesVaultDir }, null, 2),
  );

  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 20_000 });

    await app.evaluate(({ dialog }) => {
      (dialog as unknown as Record<string, unknown>).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });

    await page.locator('.app-menu-gear-btn').click();
    await page.getByRole('tab', { name: 'Vault & Files' }).click();
    await page.locator('[data-testid="clear-data-danger-zone"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="clear-data-btn"]').click();
    await page.locator('[data-testid="clear-data-confirm-btn"]').click();

    await expect(page.getByTestId('clear-data-cancelled')).toBeVisible({ timeout: 15_000 });
    expect(fs.existsSync(vaultDir)).toBe(true);
    expect(fs.existsSync(path.join(userData, 'vault-settings.json'))).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});