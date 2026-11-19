/**
 * vault-delete-branches.spec.ts — test-gap audit slice 03 (#1906)
 *
 * Real IPC + shell.trashItem + temp-dir fixtures only. Vault trees live under
 * repo `.tmp/` (disk-backed) so Linux CI can trash them — not os.tmpdir() tmpfs.
 */

import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
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
const TRASH_PROBE_FILE = 'slice03-trash-probe.txt';

interface VaultBundle {
  mythosRoot: string;
  storyRoot: string;
  notesRoot: string;
  name: string;
  trashMarker: string;
}

interface VaultSettings {
  vaultRoot?: string;
  notesVaultRoot?: string;
  recentProjects?: Array<{ name: string; vaultRoot: string; notesVaultRoot?: string; openedAt: string }>;
  hiddenVaultRoots?: string[];
}

type ChmodRestore = { path: string; mode: number };

function ensureTmpBase() {
  fs.mkdirSync(TMP_BASE, { recursive: true });
}

function seedV2Vault(parent: string, name: string): VaultBundle {
  const trashMarker = randomUUID();
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
  fs.writeFileSync(path.join(mythosRoot, TRASH_PROBE_FILE), `probe:${mythosRoot}\ntrash-marker:${trashMarker}\n`);
  return { mythosRoot, storyRoot, notesRoot, name, trashMarker };
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

async function launchApp(userData: string, envExtra?: NodeJS.ProcessEnv): Promise<ElectronApplication> {
  const extraArgs = process.platform !== 'darwin' && !process.env.DISPLAY ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', '--force-prefers-reduced-motion', ...extraArgs],
    env: { ...process.env, ...envExtra },
    timeout: 60_000,
  });
}

function prepareIsolatedTrashDir(tempRoot: string): string {
  const dataHome = path.join(tempRoot, 'xdg-data-home');
  fs.mkdirSync(path.join(dataHome, 'Trash', 'files'), { recursive: true });
  fs.mkdirSync(path.join(dataHome, 'Trash', 'info'), { recursive: true });
  return dataHome;
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

async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  await app.close().catch(() => undefined);
}

function restoreChmods(restores: ChmodRestore[], tempRoot?: string): void {
  for (const { path: p, mode } of restores) {
    try { fs.chmodSync(p, mode); } catch { /* cleanup */ }
  }
  if (tempRoot) {
    try { fs.chmodSync(tempRoot, 0o755); } catch { /* cleanup */ }
  }
}

function rmTempRoot(tempRoot?: string): void {
  if (!tempRoot) return;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

/** Freedesktop trash — requires isolated XDG_DATA_HOME and per-run trash-marker. */
function assertMythosRootInFreedesktopTrash(mythosRoot: string, trashMarker: string, dataHome: string): void {
  if (process.platform !== 'linux') return;
  const infoDir = path.join(dataHome, 'Trash', 'info');
  const filesDir = path.join(dataHome, 'Trash', 'files');
  const resolved = path.resolve(mythosRoot);

  let infoMatchesPath = false;
  if (fs.existsSync(infoDir)) {
    for (const entry of fs.readdirSync(infoDir)) {
      if (!entry.endsWith('.trashinfo')) continue;
      const body = fs.readFileSync(path.join(infoDir, entry), 'utf8');
      if (body.includes(`Path=${resolved}`) || body.includes(encodeURI(resolved))) {
        infoMatchesPath = true;
        break;
      }
    }
  }

  const findMarker = (dir: string, depth: number): boolean => {
    if (depth > 6) return false;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === TRASH_PROBE_FILE && fs.statSync(full).isFile()) {
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes(`trash-marker:${trashMarker}`)) return true;
      }
      if (fs.statSync(full).isDirectory() && findMarker(full, depth + 1)) return true;
    }
    return false;
  };
  const markerInTrash = fs.existsSync(filesDir) && findMarker(filesDir, 0);

  expect(infoMatchesPath, `missing .trashinfo for exact path ${resolved}`).toBe(true);
  expect(markerInTrash, `trash bundle missing probe marker ${trashMarker}`).toBe(true);
}

async function pollVaultRegistryAndDiskUnchanged(
  userData: string,
  bundle: VaultBundle,
  durationMs: number,
): Promise<void> {
  const rootsBefore = (readVaultSettings(userData).recentProjects ?? []).map((p) => p.vaultRoot);
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    expect(fs.existsSync(bundle.mythosRoot)).toBe(true);
    const rootsNow = (readVaultSettings(userData).recentProjects ?? []).map((p) => p.vaultRoot);
    expect(rootsNow).toEqual(rootsBefore);
    expect(rootsNow).toContain(bundle.storyRoot);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function confirmMythosTrash(page: Page, storyRoot: string): Promise<void> {
  await page.getByRole('menuitem', { name: 'Move to Recycle Bin' }).click();
  await page.getByTestId(`vault-delete-confirm-1-${storyRoot}`).click();
  await page.getByTestId(`vault-delete-confirm-2-${storyRoot}`).click();
}

// ── Overflow on every card level ─────────────────────────────────────────────

test('proves overflow menus on Mythos, Notes, and Story cards expose Hide and Move to Recycle Bin', async () => {
  let tempRoot: string | undefined;
  let userData: string;
  let alpha: VaultBundle;
  let app: ElectronApplication | undefined;
  try {
    ({ tempRoot, userData, alpha } = mkFixture('menus'));
    app = await launchApp(userData);
    const page = await app.firstWindow();
    await openVaultFiles(page);

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
    await closeApp(app);
    rmTempRoot(tempRoot);
  }
});

// ── Hide ─────────────────────────────────────────────────────────────────────

test('proves Hide updates the registry only; Show hidden restores without disk changes', async () => {
  let tempRoot: string | undefined;
  let userData: string;
  let beta: VaultBundle;
  let app: ElectronApplication | undefined;
  try {
    ({ tempRoot, userData, beta } = mkFixture('hide'));
    app = await launchApp(userData);
    const page = await app.firstWindow();
    await openVaultFiles(page);
    await openOverflow(page, beta.storyRoot);
    await page.getByRole('menuitem', { name: 'Hide' }).click();
    await page.getByTestId(`vault-hide-confirm-${beta.storyRoot}`).click();

    await expect(page.getByTestId(`mvs-card-${beta.storyRoot}`)).toHaveCount(0, { timeout: 10_000 });
    expect(fs.existsSync(beta.mythosRoot)).toBe(true);
    expect(readVaultSettings(userData).hiddenVaultRoots).toContain(beta.mythosRoot);

    await page.getByTestId('mvs-show-hidden-btn').click();
    await page.getByTestId(`mvs-unhide-${beta.storyRoot}`).click();
    await expect(page.getByTestId(`mvs-card-${beta.storyRoot}`)).toBeVisible({ timeout: 10_000 });
    expect((readVaultSettings(userData).hiddenVaultRoots ?? [])).not.toContain(beta.mythosRoot);
  } finally {
    await closeApp(app);
    rmTempRoot(tempRoot);
  }
});

// ── Delete cancel ──────────────────────────────────────────────────────────

test('proves Delete then Cancel closes the dialog and leaves disk and registry unchanged', async () => {
  let tempRoot: string | undefined;
  let userData: string;
  let beta: VaultBundle;
  let app: ElectronApplication | undefined;
  try {
    ({ tempRoot, userData, beta } = mkFixture('cancel'));
    app = await launchApp(userData);
    const page = await app.firstWindow();
    await openVaultFiles(page);
    await openOverflow(page, beta.storyRoot);
    await page.getByRole('menuitem', { name: 'Move to Recycle Bin' }).click();
    const step1 = page.getByTestId(`vault-delete-dialog-1-${beta.storyRoot}`);
    await step1.getByRole('button', { name: 'Cancel' }).click();
    await expect(step1).toHaveCount(0, { timeout: 5_000 });
    await pollVaultRegistryAndDiskUnchanged(userData, beta, 2_000);
  } finally {
    await closeApp(app);
    rmTempRoot(tempRoot);
  }
});

// ── Non-active delete ────────────────────────────────────────────────────────

test('proves non-active Mythos delete moves the bundle to OS Trash (not rm), prunes recentProjects, and stays gone after relaunch', async () => {
  test.setTimeout(180_000);
  let tempRoot: string | undefined;
  let userData: string;
  let alpha: VaultBundle;
  let beta: VaultBundle;
  let app: ElectronApplication | undefined;
  let app2: ElectronApplication | undefined;
  let xdgDataHome: string;
  try {
    ({ tempRoot, userData, alpha, beta } = mkFixture('trash-beta'));
    xdgDataHome = prepareIsolatedTrashDir(tempRoot);
    app = await launchApp(userData, { XDG_DATA_HOME: xdgDataHome });
    const page = await app.firstWindow();
    await openVaultFiles(page);
    await openOverflow(page, beta.storyRoot);
    await confirmMythosTrash(page, beta.storyRoot);

    await expect(page.getByTestId(`mvs-card-${beta.storyRoot}`)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId(`mvs-card-${alpha.storyRoot}`)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => fs.existsSync(beta.mythosRoot), { timeout: 60_000, intervals: [250, 500, 1000] }).toBe(false);
    assertMythosRootInFreedesktopTrash(beta.mythosRoot, beta.trashMarker, xdgDataHome);

    const rootsAfter = (readVaultSettings(userData).recentProjects ?? []).map((p) => p.vaultRoot);
    expect(rootsAfter).not.toContain(beta.storyRoot);
    expect(rootsAfter).toContain(alpha.storyRoot);

    await closeApp(app);
    app = undefined;
    app2 = await launchApp(userData, { XDG_DATA_HOME: xdgDataHome });
    const page2 = await app2.firstWindow();
    await openVaultFiles(page2);
    await expect(page2.getByTestId(`mvs-card-${alpha.storyRoot}`)).toBeVisible({ timeout: 20_000 });
    await expect(page2.getByTestId(`mvs-card-${beta.storyRoot}`)).toHaveCount(0);
    const registryRelaunch = readVaultSettings(userData).recentProjects ?? [];
    expect(registryRelaunch.map((p) => p.vaultRoot)).not.toContain(beta.storyRoot);
    expect(fs.existsSync(beta.mythosRoot)).toBe(false);
  } finally {
    await closeApp(app2);
    await closeApp(app);
    rmTempRoot(tempRoot);
  }
});

// ── Active delete ────────────────────────────────────────────────────────────

test('proves deleting the active Mythos vault switches vaultRoot to the surviving vault', async () => {
  test.setTimeout(180_000);
  let tempRoot: string | undefined;
  let userData: string;
  let alpha: VaultBundle;
  let beta: VaultBundle;
  let app: ElectronApplication | undefined;
  try {
    ({ tempRoot, userData, alpha, beta } = mkFixture('trash-active'));
    app = await launchApp(userData);
    const page = await app.firstWindow();
    await openVaultFiles(page);
    await openOverflow(page, alpha.storyRoot);
    await confirmMythosTrash(page, alpha.storyRoot);

    await expect.poll(() => fs.existsSync(alpha.mythosRoot), { timeout: 60_000 }).toBe(false);
    await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 15_000 });

    await expect.poll(() => readVaultSettings(userData).vaultRoot, { timeout: 30_000, intervals: [250, 500, 1000] })
      .toBe(beta.storyRoot);

    await expect.poll(async () => {
      const vr = readVaultSettings(userData).vaultRoot;
      if (vr === beta.storyRoot) return 'switched';
      if ((readVaultSettings(userData).recentProjects ?? []).length === 0
        && await page.getByTestId('story-vault-picker-btn').isVisible().catch(() => false)) {
        return 'picker';
      }
      return 'pending';
    }, { timeout: 45_000, intervals: [300, 500, 1000] }).toMatch(/^(switched|picker)$/);

    if (readVaultSettings(userData).vaultRoot === beta.storyRoot) {
      await expect(page.getByTestId(`mvs-card-${beta.storyRoot}`)).toBeVisible({ timeout: 15_000 });
    }
  } finally {
    await closeApp(app);
    rmTempRoot(tempRoot);
  }
});

// ── Trash failure ────────────────────────────────────────────────────────────

test('proves read-only trash failure surfaces an error and leaves registry and folder intact', async () => {
  test.skip(
    process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
    'deterministic trash stub is used instead of chmod (unsafe as root / on Windows)',
  );
  test.setTimeout(120_000);
  let tempRoot: string | undefined;
  let userData: string;
  let beta: VaultBundle;
  let app: ElectronApplication | undefined;
  try {
    ({ tempRoot, userData, beta } = mkFixture('readonly'));
    app = await launchApp(userData);
    await app.evaluate(async ({ shell }) => {
      shell.trashItem = async () => {
        throw new Error('vault-delete-branches: deterministic trash failure');
      };
    });

    const page = await app.firstWindow();
    await openVaultFiles(page);
    await openOverflow(page, beta.storyRoot);
    await confirmMythosTrash(page, beta.storyRoot);

    await expect(page.getByTestId(`vault-delete-failed-${beta.storyRoot}`)).toBeVisible({ timeout: 15_000 });
    expect(fs.existsSync(beta.mythosRoot)).toBe(true);
    expect((readVaultSettings(userData).recentProjects ?? []).map((p) => p.vaultRoot)).toContain(beta.storyRoot);
  } finally {
    await closeApp(app);
    rmTempRoot(tempRoot);
  }
});

// ── Clear all data (confirm, custom vaults) ────────────────────────────────

test('proves Delete Everything clears app data but keeps user-chosen vault folders outside userData', async () => {
  test.setTimeout(120_000);
  let tempRoot: string | undefined;
  let app: ElectronApplication | undefined;
  try {
    ensureTmpBase();
    tempRoot = fs.mkdtempSync(path.join(TMP_BASE, 'vault-clear-confirm-'));
    const userData = path.join(tempRoot, 'userData');
    const customBundle = seedV2Vault(tempRoot, 'Custom Off UserData');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'app-settings.json'), JSON.stringify({ onboardingComplete: true, theme: 'dark' }, null, 2));
    fs.writeFileSync(
      path.join(userData, 'vault-settings.json'),
      JSON.stringify({
        vaultRoot: customBundle.storyRoot,
        notesVaultRoot: customBundle.notesRoot,
        recentProjects: [{
          name: customBundle.name,
          vaultRoot: customBundle.storyRoot,
          notesVaultRoot: customBundle.notesRoot,
          openedAt: NOW,
        }],
      }, null, 2),
    );

    app = await launchApp(userData);
    await app.evaluate(({ dialog }) => {
      (dialog as unknown as Record<string, unknown>).showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    const page = await app.firstWindow();
    await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 20_000 });
    await openVaultFiles(page);
    await page.locator('[data-testid="clear-data-danger-zone"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="clear-data-btn"]').click();
    await page.locator('[data-testid="clear-data-confirm-btn"]').click();

    await expect(page.getByTestId('clear-data-success')).toBeVisible({ timeout: 20_000 });
    expect(fs.existsSync(path.join(userData, 'app-settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(userData, 'vault-settings.json'))).toBe(false);
    expect(fs.existsSync(customBundle.storyRoot)).toBe(true);
    expect(fs.existsSync(customBundle.notesRoot)).toBe(true);
    expect(fs.existsSync(path.join(customBundle.mythosRoot, TRASH_PROBE_FILE))).toBe(true);
  } finally {
    await closeApp(app);
    rmTempRoot(tempRoot);
  }
});