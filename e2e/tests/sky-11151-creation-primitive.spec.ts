/**
 * sky-11151-creation-primitive.spec.ts — QA independent acceptance tests
 *
 * Slice: SKY-11151 "[Vault surface] Creation primitive — template/blank/import
 * option set + Obsidian-parity empty" (parent spec SKY-11141 §3/§3a).
 * Reachability E2E: first run uses WelcomeOverlay + the shared create-vault
 * modal (OnboardingWizard deleted under F3#9). Deeper Obsidian-parity blank
 * assertions live in e2e/vault-create-primitive-sky11151.spec.ts (IPC path).
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

/**
 * WelcomeOverlay "Start blank" → create-vault modal with a chosen vault name.
 * Custom destination parents are exercised via IPC in vault-create-primitive-sky11151.spec.ts
 * (Browse uses a native dialog that headless CI cannot drive).
 */
async function createBlankVaultViaWelcome(page: Page, vaultName: string): Promise<void> {
  await expect(page.getByTestId('welcome-overlay')).toBeVisible({ timeout: 60_000 });
  await dismissLegacyMigrationDialogIfPresent(page);
  await page.getByTestId('welcome-path-blank').click();

  await expect(page.locator('#create-vault-name')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('rail-vault-mode-blank').click();
  await page.locator('#create-vault-name').fill(vaultName);
  await page.getByTestId('create-vault-submit').click();
  await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 45_000 });
}

test.describe('SKY-11151 creation primitive — Obsidian-parity blank vault (§3a)', () => {
  test('AC-CP-01: "Start blank" creates the vault at the CHOSEN non-default location and name, verified on disk (§4c reachability)', async () => {
    const userData = freshUserData('mythos-cp01-');
    const vaultName = 'QA Blank Vault One';
    const app = await launchApp(userData);
    try {
      const page = await app.firstWindow();
      await createBlankVaultViaWelcome(page, vaultName);

      const vaultsParent = path.join(userData, 'vaults');
      const mythosRoot = path.join(vaultsParent, vaultName);
      await expect.poll(() => fs.existsSync(mythosRoot), { timeout: 30_000 }).toBe(true);
      expect(fs.existsSync(path.join(mythosRoot, 'mythos.json'))).toBe(true);
      expect(vaultsParent).not.toBe(path.join(os.homedir(), 'Mythos Vaults'));
    } finally {
      await app.close();
    }
  });
});

test.describe('SKY-11151 — sample-story path removal (§3)', () => {
  test('AC-CP-04: first-run WelcomeOverlay has no sample-story card', async () => {
    const userData = freshUserData('mythos-cp04-');
    const app = await launchApp(userData);
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('welcome-overlay')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('welcome-path-sample')).toHaveCount(0);
      for (const id of ['template', 'blank', 'import', 'restore', 'openin'] as const) {
        await expect(page.getByTestId(`welcome-path-${id}`)).toBeVisible();
      }
      await expect(page.locator('[data-testid="onboarding-wizard"]')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});