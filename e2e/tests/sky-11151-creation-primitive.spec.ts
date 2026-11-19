/**
 * sky-11151-creation-primitive.spec.ts — QA independent acceptance tests
 *
 * Slice: SKY-11151 "[Vault surface] Creation primitive — template/blank/import
 * option set + Obsidian-parity empty" (parent spec SKY-11141 §3/§3a).
 * WelcomeOverlay reachability (F3#9). CHOSEN non-default destination is covered
 * by e2e/vault-create-primitive-sky11151.spec.ts (TC-CVP-* via createVaultFromOptions IPC).
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

function listVisibleEntries(dir: string): string[] {
  return fs.readdirSync(dir).filter((e) => !e.startsWith('.'));
}

test.describe('SKY-11151 creation primitive — Obsidian-parity blank vault (§3a)', () => {
  test('AC-CP-01: Welcome "Start blank" creates a named vault under default <userData>/vaults (§4c reachability); chosen parent → vault-create-primitive-sky11151.spec.ts', async () => {
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
    } finally {
      await app.close();
    }
  });

  test.fixme('AC-CP-02: blank vault has ZERO visible folders/files — Obsidian-parity empty (§3a hard requirement) (pending SKY-11151)', async () => {
    const userData = freshUserData('mythos-cp02-');
    const vaultName = 'QA Blank Vault Two';
    const app = await launchApp(userData);
    try {
      const page = await app.firstWindow();
      await createBlankVaultViaWelcome(page, vaultName);

      const mythosRoot = path.join(path.join(userData, 'vaults'), vaultName);
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
    const vaultName = 'QA Blank Vault Three';
    const app = await launchApp(userData);
    try {
      const page = await app.firstWindow();
      await createBlankVaultViaWelcome(page, vaultName);
    } finally {
      await app.close();
    }

    const app2 = await launchApp(userData);
    try {
      const page2 = await app2.firstWindow();
      await expect(page2.locator('.app-menu-bar')).toBeVisible({ timeout: 20_000 });

      const mythosRoot = path.join(path.join(userData, 'vaults'), vaultName);
      const visible = listVisibleEntries(mythosRoot);
      expect(visible, 'a relaunch must never re-seed a vault that was created blank').toEqual([]);
    } finally {
      await app2.close();
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