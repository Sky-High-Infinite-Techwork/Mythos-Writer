/**
 * sky-11151-creation-primitive.spec.ts — QA independent acceptance tests
 *
 * Slice: SKY-11151 "[Vault surface] Creation primitive — template/blank/import
 * option set + Obsidian-parity empty" (parent spec SKY-11141 §3/§3a).
 * Written by QA (SKY-11173) from the spec, not from the implementation.
 * TEST FILE ONLY — no product code touched. Failures are expected and
 * routed to the slice owner; do not "fix" this file to make it pass by
 * loosening assertions.
 *
 * Real E2E across the process boundary: drives the first-run WelcomeOverlay
 * create-vault modal (F3#9), which calls the real vault creation IPC and
 * writes to a real temp-dir filesystem. No window.api mocking.
 *
 * Run: xvfb-run --auto-servernum npx playwright test e2e/tests/sky-11151-creation-primitive.spec.ts --reporter=list
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const MAIN_JS = path.resolve(__dirname, '../../out/main/main.js');

async function launchApp(userData: string): Promise<ElectronApplication> {
  const extraArgs = (process.platform !== 'darwin' && !process.env.DISPLAY) ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', ...extraArgs],
    env: { ...process.env, HOME: userData, MYTHOS_E2E: '1' },
    timeout: 60_000,
  });
}

function freshUserData(prefix: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(tempRoot, 'userData');
}

async function dismissLegacyMigrationDialogIfPresent(page: Page): Promise<void> {
  const migrationDialog = page.getByTestId('gs-migration-dialog');
  if (await migrationDialog.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await page.getByTestId('gs-migration-never').click();
    await expect(migrationDialog).not.toBeVisible({ timeout: 5_000 });
  }
}

/** Patch ONLY dialog.showOpenDialog (Browse) — real create IPC runs. */
async function patchOpenDialog(app: ElectronApplication, destParent: string): Promise<void> {
  await app.evaluate(({ dialog }, { dir }: { dir: string }) => {
    (dialog as unknown as Record<string, unknown>).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [dir],
    });
  }, { dir: destParent });
}

/**
 * WelcomeOverlay blank → create-vault modal → Browse (Where to create) picks
 * destParent → blank mode → name → submit. CHOSEN non-default location (§4c).
 */
async function createBlankVaultAtChosenLocation(
  page: Page,
  destParent: string,
  vaultName: string,
): Promise<void> {
  await expect(page.getByTestId('welcome-overlay')).toBeVisible({ timeout: 60_000 });
  await dismissLegacyMigrationDialogIfPresent(page);
  await page.getByTestId('welcome-path-blank').click();

  await expect(page.locator('#create-vault-name')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('rail-vault-mode-blank').click();

  const modal = page.locator('.create-vault-modal');
  await modal.getByRole('button', { name: /Browse/i }).click();
  await expect(page.locator('#create-vault-dest')).toContainText(destParent, { timeout: 5_000 });

  await page.locator('#create-vault-name').fill(vaultName);
  await page.getByTestId('create-vault-submit').click();
  await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 45_000 });
}

function listVisibleEntries(dir: string): string[] {
  return fs.readdirSync(dir).filter((e) => !e.startsWith('.'));
}

test.describe('SKY-11151 creation primitive — Obsidian-parity blank vault (§3a)', () => {
  test('AC-CP-01: "Start blank" creates the vault at the CHOSEN non-default location and name, verified on disk (§4c reachability)', async () => {
    const userData = freshUserData('mythos-cp01-');
    const destParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-cp01-dest-'));
    const vaultName = 'QA Blank Vault One';
    const app = await launchApp(userData);
    try {
      await patchOpenDialog(app, destParent);
      const page = await app.firstWindow();
      await createBlankVaultAtChosenLocation(page, destParent, vaultName);

      const mythosRoot = path.join(destParent, vaultName);
      expect(fs.existsSync(mythosRoot), `expected vault at chosen non-default path ${mythosRoot}`).toBe(true);
      expect(fs.existsSync(path.join(mythosRoot, 'mythos.json'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  test.fixme('AC-CP-02: blank vault has ZERO visible folders/files — Obsidian-parity empty (§3a hard requirement) (pending SKY-11151)', async () => {
    const userData = freshUserData('mythos-cp02-');
    const destParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-cp02-dest-'));
    const vaultName = 'QA Blank Vault Two';
    const app = await launchApp(userData);
    try {
      await patchOpenDialog(app, destParent);
      const page = await app.firstWindow();
      await createBlankVaultAtChosenLocation(page, destParent, vaultName);

      const mythosRoot = path.join(destParent, vaultName);
      const visible = listVisibleEntries(mythosRoot);
      expect(
        visible,
        'blank vault must have no user-visible folders — Story Vault/Notes Vault/Agent Vault are current machinery leaking into the tree',
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test.fixme('AC-CP-03: the empty choice is PERSISTED — folders stay absent after a relaunch, not re-seeded on next boot (pending SKY-11151)', async () => {
    const userData = freshUserData('mythos-cp03-');
    const destParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-cp03-dest-'));
    const vaultName = 'QA Blank Vault Three';
    const app = await launchApp(userData);
    try {
      await patchOpenDialog(app, destParent);
      const page = await app.firstWindow();
      await createBlankVaultAtChosenLocation(page, destParent, vaultName);
    } finally {
      await app.close();
    }

    const app2 = await launchApp(userData);
    try {
      const page2 = await app2.firstWindow();
      await expect(page2.locator('.app-menu-bar')).toBeVisible({ timeout: 20_000 });

      const mythosRoot = path.join(destParent, vaultName);
      const visible = listVisibleEntries(mythosRoot);
      expect(
        visible,
        'a relaunch must never re-seed a vault that was created blank',
      ).toEqual([]);
    } finally {
      await app2.close();
    }
  });
});

test.describe('SKY-11151 — sample-story path removal (§3)', () => {
  test.fixme('AC-CP-04: the first-run card set has exactly 3 options (template/blank/import) — no 4th "sample" card (pending SKY-11151)', async () => {
    const userData = freshUserData('mythos-cp04-');
    const app = await launchApp(userData);
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('screen-step1')).toBeVisible({ timeout: 15_000 });

      await expect(page.getByTestId('card-sample'), 'card-sample must be removed per SKY-11141 §3').toHaveCount(0);
      await expect(page.getByTestId('card-start-blank')).toBeVisible();
      await expect(page.getByTestId('card-import-obsidian')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

test.describe('SKY-11151 — one shared primitive, reused everywhere (§3)', () => {
  test.fixme('AC-CP-05: Settings "New vault…" offers the SAME template/blank/import option set as first run (pending SKY-11151)', async () => {
    const storyVault = path.join(os.tmpdir(), `mythos-cp05-story-${Date.now()}`);
    const notesVault = path.join(os.tmpdir(), `mythos-cp05-notes-${Date.now()}`);
    fs.mkdirSync(storyVault, { recursive: true });
    fs.mkdirSync(notesVault, { recursive: true });
    const userData = freshUserData('mythos-cp05-');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      path.join(userData, 'app-settings.json'),
      JSON.stringify({ onboardingComplete: true, theme: 'dark' }, null, 2),
    );
    fs.writeFileSync(
      path.join(userData, 'vault-settings.json'),
      JSON.stringify({ vaultRoot: storyVault, notesVaultRoot: notesVault }, null, 2),
    );

    const app = await launchApp(userData);
    try {
      const page = await app.firstWindow();
      await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 15_000 });
      await page.locator('.app-menu-gear-btn').click();
      await page.getByRole('tab', { name: 'Vault & Files' }).click();

      const newVaultBtn = page.getByTestId('mvs-new-vault');
      await newVaultBtn.scrollIntoViewIfNeeded();
      await newVaultBtn.click();
      await expect(page.getByTestId('mvs-create-form')).toBeVisible();

      const optionControls = page.locator(
        '[data-testid="mvs-create-form"] [role="radio"], [data-testid="mvs-create-form"] input[type="radio"], [data-testid="mvs-create-form"] [data-testid*="blank"], [data-testid="mvs-create-form"] [data-testid*="import"], [data-testid="mvs-create-form"] [data-testid*="template"]',
      );
      await expect(
        optionControls.first(),
        'Settings "New vault…" must expose the shared template/blank/import primitive, not create a demo-seeded vault unconditionally',
      ).toBeVisible({ timeout: 3_000 });
    } finally {
      await app.close();
    }
  });
});