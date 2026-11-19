/**
 * sky-11154-vault-settings-page.spec.ts — Vault & Files settings acceptance
 *
 * Slice: SKY-11154 (parent SKY-11141). Uses real Mythos v2 bundles so
 * MythosVaultsSection + VaultLinkingColumns render today's UI.
 *
 * Run: xvfb-run --auto-servernum npx playwright test e2e/tests/sky-11154-vault-settings-page.spec.ts
 */

import path from 'path';
import fs from 'fs';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const MAIN_JS = path.resolve(__dirname, '../../out/main/main.js');
const TMP_BASE = path.resolve(__dirname, '../../.tmp');
const NOW = '2026-09-02T00:00:00.000Z';
const STORY_ID = 'story-sky11154-1';
const STORY_TITLE = 'The Deep';
const MYTHOS_NAME = 'Anwen Cycle';

function ensureTmpBase() {
  fs.mkdirSync(TMP_BASE, { recursive: true });
}

function seedV2Vault(bundle: string): { storyVault: string; notesVault: string; mythosRoot: string } {
  const storyVault = path.join(bundle, 'Story Vault');
  const notesVault = path.join(bundle, 'Notes Vault');
  const storyDir = path.join(storyVault, STORY_TITLE);
  const chapterDir = path.join(storyDir, 'Part 1', 'Chapter 01');
  fs.mkdirSync(chapterDir, { recursive: true });
  fs.mkdirSync(notesVault, { recursive: true });

  fs.writeFileSync(
    path.join(bundle, 'mythos.json'),
    JSON.stringify({
      formatVersion: 2,
      id: 'vault-sky11154-1',
      name: MYTHOS_NAME,
      createdAt: NOW,
      stories: [{ id: STORY_ID, title: STORY_TITLE, folder: STORY_TITLE, createdAt: NOW, updatedAt: NOW }],
      seed: { layout: 'veynn-v2', mode: 'blank', seededAt: NOW },
    }, null, 2),
  );

  fs.writeFileSync(
    path.join(chapterDir, 'Scene 01.md'),
    `---\nid: scene-sky11154-1\ntitle: The Gate\nstatus: draft\nupdatedAt: ${NOW}\n---\nThe lantern found her first.\n`,
  );
  fs.writeFileSync(path.join(notesVault, 'Eira.md'), '# Eira\n');
  return { storyVault, notesVault, mythosRoot: bundle };
}

function seedUserData(userData: string, storyVault: string, notesVault: string): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({ onboardingComplete: true, theme: 'dark' }, null, 2),
  );
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({
      vaultRoot: storyVault,
      notesVaultRoot: notesVault,
      recentProjects: [{ name: MYTHOS_NAME, vaultRoot: storyVault, notesVaultRoot: notesVault, openedAt: NOW }],
    }, null, 2),
  );
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  const extraArgs = (process.platform !== 'darwin' && !process.env.DISPLAY) ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', ...extraArgs],
    timeout: 60_000,
  });
}

async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (app) await app.close().catch(() => undefined);
}

function rmTempRoot(tempRoot: string | undefined): void {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function openVaultFilesSettings(page: Page): Promise<void> {
  await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.app-menu-gear-btn').click();
  await page.getByRole('tab', { name: 'Vault & Files' }).click();
}

function makeFixture(slug: string) {
  ensureTmpBase();
  const tempRoot = fs.mkdtempSync(path.join(TMP_BASE, `mythos-vs-${slug}-`));
  const userData = path.join(tempRoot, 'userData');
  const bundle = path.join(tempRoot, MYTHOS_NAME);
  const vaults = seedV2Vault(bundle);
  seedUserData(userData, vaults.storyVault, vaults.notesVault);
  return { tempRoot, userData, ...vaults };
}

test.describe('SKY-11154 vault cards — inner counts + inline rename (§4)', () => {
  test('AC-VS-01: a Mythos vault card shows its inner-vault counts', async () => {
    let tempRoot: string | undefined;
    let app: ElectronApplication | undefined;
    try {
      const fixture = makeFixture('01');
      tempRoot = fixture.tempRoot;
      app = await launchApp(fixture.userData);
      const page = await app.firstWindow();
      await openVaultFilesSettings(page);
      await expect(
        page.getByText(/\d+\s+notes vaults?\s*(&middot;|·)\s*\d+\s+story vaults?/i),
      ).toBeVisible({ timeout: 8_000 });
      await expect(page.getByTestId(`mvs-card-${fixture.storyVault}`)).toBeVisible();
    } finally {
      await closeApp(app);
      rmTempRoot(tempRoot);
    }
  });

  test('AC-VS-02: double-clicking a Mythos vault name enables inline rename', async () => {
    let tempRoot: string | undefined;
    let app: ElectronApplication | undefined;
    try {
      const fixture = makeFixture('02');
      tempRoot = fixture.tempRoot;
      app = await launchApp(fixture.userData);
      const page = await app.firstWindow();
      await openVaultFilesSettings(page);
      const card = page.getByTestId(`mvs-card-${fixture.storyVault}`);
      await card.dblclick();
      const renameInput = page.getByTestId(`mvs-rename-input-${fixture.storyVault}`);
      await expect(renameInput).toBeVisible({ timeout: 5_000 });
    } finally {
      await closeApp(app);
      rmTempRoot(tempRoot);
    }
  });
});

test.describe('SKY-11154 — the ⋯ menu, identical at every level (§4a)', () => {
  test('AC-VS-03: each vault card exposes overflow with Hide and Move to Recycle Bin', async () => {
    let tempRoot: string | undefined;
    let app: ElectronApplication | undefined;
    try {
      const fixture = makeFixture('03');
      tempRoot = fixture.tempRoot;
      app = await launchApp(fixture.userData);
      const page = await app.firstWindow();
      await openVaultFilesSettings(page);
      const card = page.getByTestId(`mvs-card-${fixture.storyVault}`);
      await card.getByTestId(`vault-overflow-btn-${fixture.storyVault}`).click();
      await expect(page.getByRole('menuitem', { name: 'Hide' })).toBeVisible({ timeout: 3_000 });
      await expect(page.getByRole('menuitem', { name: 'Move to Recycle Bin' })).toBeVisible();
      await expect(card.locator('[aria-label="Delete" i]:not([role="menuitem"])')).toHaveCount(0);
    } finally {
      await closeApp(app);
      rmTempRoot(tempRoot);
    }
  });

  test('AC-VS-04: Delete confirm copy says "moved to the Recycle Bin"', async () => {
    let tempRoot: string | undefined;
    let app: ElectronApplication | undefined;
    try {
      const fixture = makeFixture('04');
      tempRoot = fixture.tempRoot;
      app = await launchApp(fixture.userData);
      const page = await app.firstWindow();
      await openVaultFilesSettings(page);
      const card = page.getByTestId(`mvs-card-${fixture.storyVault}`);
      await card.getByTestId(`vault-overflow-btn-${fixture.storyVault}`).click();
      await page.getByRole('menuitem', { name: 'Move to Recycle Bin' }).click();
      await expect(page.getByText(/moved to the recycle bin/i)).toBeVisible({ timeout: 5_000 });
    } finally {
      await closeApp(app);
      rmTempRoot(tempRoot);
    }
  });
});

test.describe('SKY-11154 — Hide + Show hidden (§4a)', () => {
  test('AC-VS-05: a "Show hidden" affordance is present on Vault & Files', async () => {
    let tempRoot: string | undefined;
    let app: ElectronApplication | undefined;
    try {
      const fixture = makeFixture('05');
      tempRoot = fixture.tempRoot;
      app = await launchApp(fixture.userData);
      const page = await app.firstWindow();
      await openVaultFilesSettings(page);
      await expect(page.getByTestId('mvs-show-hidden-btn')).toBeVisible({ timeout: 5_000 });
    } finally {
      await closeApp(app);
      rmTempRoot(tempRoot);
    }
  });
});

test.describe('SKY-11154 — hard exclusions carried through (§5)', () => {
  test('AC-VS-06: no Dropbox-as-a-feature copy on Vault & Files', async () => {
    let tempRoot: string | undefined;
    let app: ElectronApplication | undefined;
    try {
      const fixture = makeFixture('06');
      tempRoot = fixture.tempRoot;
      app = await launchApp(fixture.userData);
      const page = await app.firstWindow();
      await openVaultFilesSettings(page);
      await expect(page.getByText(/mythos cloud/i)).toHaveCount(0);
      await expect(page.locator('[data-settings-cat="vaults"]').getByText(/dropbox/i)).toHaveCount(0);
      const moveBtn = page.getByTestId('move-vault-btn');
      if (await moveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await moveBtn.click();
        await expect(page.getByText(/dropbox/i)).toHaveCount(0);
      }
    } finally {
      await closeApp(app);
      rmTempRoot(tempRoot);
    }
  });
});

test.describe('SKY-11154 — dot-linking pairing (§2 / §4)', () => {
  test('AC-VS-07: dot-linking control exists between the Notes and Story columns', async () => {
    let tempRoot: string | undefined;
    let app: ElectronApplication | undefined;
    try {
      const fixture = makeFixture('07');
      tempRoot = fixture.tempRoot;
      app = await launchApp(fixture.userData);
      const page = await app.firstWindow();
      await openVaultFilesSettings(page);
      await expect(page.locator('[data-testid^="pair-dot-notes-"]').first()).toBeVisible({ timeout: 8_000 });
      await expect(page.locator('[data-testid^="pair-dot-story-"]').first()).toBeVisible({ timeout: 8_000 });
    } finally {
      await closeApp(app);
      rmTempRoot(tempRoot);
    }
  });
});