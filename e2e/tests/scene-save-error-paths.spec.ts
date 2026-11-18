/**
 * scene-save-error-paths.spec.ts — Test gap 01 (#1904)
 *
 * Covers refused scene writes, vault disappearance, mid-type scene switch,
 * idle autosave, and hard-kill recovery. Reuses sky-11646 seed/openScene plumbing.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const MAIN_JS = path.resolve(__dirname, '../../out/main/main.js');
const NOW = '2026-07-01T00:00:00.000Z';
const STORY_TITLE = 'Save Error Story';
const SCENE_ONE = 'The Gate';
const SCENE_TWO = 'The Harbor';
const SEED_PROSE_ONE = 'The lantern flickered once.';
const SEED_PROSE_TWO = 'Harbor mist rolled in.';

const SAVE_ERROR_BANNER_TIMEOUT_MS = 20_000;
const EDITOR_DEBOUNCE_MS = 800;
const SAVE_INDICATOR_DELAY_MS = 1_200;
/** Time after typing when a successful save would show \"Saved ✓\" in focus chrome. */
const SAVE_OK_VISIBLE_WAIT_MS = EDITOR_DEBOUNCE_MS + SAVE_INDICATOR_DELAY_MS + 400;

function seedUserData(userData: string, vaultDir: string, notesVaultDir: string): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({ onboardingComplete: true, theme: 'dark' }, null, 2),
  );
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({ vaultRoot: vaultDir, notesVaultRoot: notesVaultDir }, null, 2),
  );
}

function seedV2Vault(bundle: string): { sceneOnePath: string; sceneTwoPath: string; vaultRoot: string } {
  const vaultRoot = path.join(bundle, 'Story Vault');
  const storyDir = path.join(vaultRoot, STORY_TITLE);
  const chapterDir = path.join(storyDir, 'Part 1', 'Chapter 01');
  fs.mkdirSync(chapterDir, { recursive: true });
  fs.mkdirSync(path.join(bundle, 'Notes Vault'), { recursive: true });

  fs.writeFileSync(
    path.join(bundle, 'mythos.json'),
    JSON.stringify({
      formatVersion: 2,
      id: 'vault-save-err-1',
      name: 'Save Error Vault',
      createdAt: NOW,
      stories: [
        { id: 'story-se-1', title: STORY_TITLE, folder: STORY_TITLE, createdAt: NOW, updatedAt: NOW },
      ],
      seed: { layout: 'veynn-v2', mode: 'blank', seededAt: NOW },
    }, null, 2),
  );

  const spine = [
    { dir: 'Part 1', chapters: [{ dir: 'Chapter 01', id: 'ch-se-1', title: 'Chapter One' }] },
  ];
  fs.writeFileSync(
    path.join(storyDir, 'book.md'),
    [
      '---',
      'id: story-se-1',
      `title: ${STORY_TITLE}`,
      `createdAt: ${NOW}`,
      `updatedAt: ${NOW}`,
      '---',
      `# ${STORY_TITLE}`,
      '',
      '## Part 1',
      '',
      '- [[Part 1/Chapter 01|Chapter One]]',
      '',
      '<!-- mythos:spine',
      JSON.stringify(spine),
      '-->',
      '',
    ].join('\n'),
  );

  const sceneOnePath = path.join(chapterDir, 'Scene 01.md');
  const sceneTwoPath = path.join(chapterDir, 'Scene 02.md');
  fs.writeFileSync(
    sceneOnePath,
    `---\nid: scene-se-1\ntitle: ${SCENE_ONE}\nstatus: draft\nupdatedAt: ${NOW}\n---\n${SEED_PROSE_ONE}\n`,
  );
  fs.writeFileSync(
    sceneTwoPath,
    `---\nid: scene-se-2\ntitle: ${SCENE_TWO}\nstatus: draft\nupdatedAt: ${NOW}\n---\n${SEED_PROSE_TWO}\n`,
  );
  return { sceneOnePath, sceneTwoPath, vaultRoot };
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  const extraArgs = (process.platform !== 'darwin' && !process.env.DISPLAY)
    ? ['--headless']
    : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', ...extraArgs],
    timeout: 60_000,
  });
}

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const pg = await app.firstWindow();
  pg.on('pageerror', (e) => console.log('[renderer:pageerror]', e.message));
  await pg.waitForLoadState('domcontentloaded');
  return pg;
}

async function clickStorySection(pg: Page): Promise<void> {
  const nav = pg.locator('nav[aria-label="Main navigation"]');
  await expect(nav).toBeVisible({ timeout: 15_000 });
  const storyBtn = nav.getByRole('button', { name: /^story( writer)?$/i }).first();
  await expect(storyBtn).toBeVisible({ timeout: 10_000 });
  if ((await storyBtn.getAttribute('aria-current')) !== 'page') {
    await storyBtn.click();
  }
  const backdrop = pg.locator('[data-testid="nav-rail-stories-backdrop"]');
  if (await backdrop.count()) {
    await backdrop.click({ position: { x: 5, y: 5 }, force: true });
    await expect(backdrop).toHaveCount(0);
  }
}

async function openScene(pg: Page, sceneTitle: string, seedProse: string): Promise<void> {
  await clickStorySection(pg);
  const storyRow = pg.getByRole('button', { name: new RegExp(STORY_TITLE) }).first();
  await expect(storyRow).toBeVisible({ timeout: 20_000 });
  const chapterRow = pg.getByRole('button', { name: /Chapter One/ }).first();
  if (!(await chapterRow.isVisible().catch(() => false))) {
    await storyRow.click();
  }
  await expect(chapterRow).toBeVisible({ timeout: 10_000 });
  const sceneRow = pg.getByRole('button', { name: new RegExp(sceneTitle) }).first();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await chapterRow.click();
    try {
      await sceneRow.waitFor({ state: 'visible', timeout: 3_000 });
      break;
    } catch {
      /* collapsed again */
    }
  }
  await sceneRow.click();
  const surface = pg.locator('.ProseMirror').first();
  await expect(surface).toBeVisible({ timeout: 15_000 });
  await expect(surface).toContainText(seedProse, { timeout: 15_000 });
}

function sceneBody(scenePath: string): string {
  const parts = fs.readFileSync(scenePath, 'utf-8').split('---\n');
  return (parts[2] ?? '').replace(/^\n/, '');
}

async function waitForSceneBodyContains(scenePath: string, text: string, timeout = 20_000) {
  await expect.poll(() => sceneBody(scenePath), { timeout }).toContain(text);
}

async function waitForSceneBodyExcludes(scenePath: string, text: string, timeout = 20_000) {
  await expect.poll(() => sceneBody(scenePath), { timeout }).not.toContain(text);
}

function vaultTreeContainsText(root: string, needle: string): boolean {
  if (!fs.existsSync(root)) return false;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        try {
          if (fs.readFileSync(p, 'utf-8').includes(needle)) return true;
        } catch {
          /* unreadable leaf */
        }
      }
    }
  }
  return false;
}

async function waitForVaultContainsText(vaultRoot: string, text: string, timeout = 20_000) {
  await expect.poll(() => vaultTreeContainsText(vaultRoot, text), { timeout }).toBe(true);
}

async function waitForSaveErrorBanner(page: Page) {
  await expect.poll(
    async () => page.getByTestId('scene-save-warning').count(),
    { timeout: SAVE_ERROR_BANNER_TIMEOUT_MS },
  ).toBeGreaterThan(0);
}

type ChmodPrior = { priorFileMode: number; priorDirMode: number };

function lockChapterForRefusedWrite(chapterDir: string, sceneOnePath: string): ChmodPrior {
  const priorFileMode = fs.statSync(sceneOnePath).mode & 0o777;
  const priorDirMode = fs.statSync(chapterDir).mode & 0o777;
  fs.chmodSync(sceneOnePath, 0o444);
  fs.chmodSync(chapterDir, 0o555);
  expect(() => fs.accessSync(sceneOnePath, fs.constants.W_OK)).toThrow();
  expect(() => fs.writeFileSync(path.join(chapterDir, 'probe.tmp'), 'x')).toThrow();
  return { priorFileMode, priorDirMode };
}

function unlockChapter(chapterDir: string, sceneOnePath: string, prior: ChmodPrior): void {
  fs.chmodSync(chapterDir, prior.priorDirMode | 0o200);
  fs.chmodSync(sceneOnePath, prior.priorFileMode | 0o200);
}

function lockBundleUnwritable(bundle: string): number {
  const priorBundleMode = fs.statSync(bundle).mode & 0o777;
  fs.chmodSync(bundle, 0o555);
  expect(() => fs.writeFileSync(path.join(bundle, 'probe.tmp'), 'x')).toThrow();
  return priorBundleMode;
}

test.describe('scene save error paths (#1904)', () => {
  test('TC-SE-01: read-only scene file surfaces save error, keeps editor text, recovers on retry', async () => {
    test.skip(process.platform === 'win32', 'read-only chmod assertion runs on Linux CI');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-save-err-ro-'));
    const userData = path.join(tmpRoot, 'user-data');
    const bundle = path.join(tmpRoot, 'Save Error Vault');
    const { sceneOnePath } = seedV2Vault(bundle);
    seedUserData(userData, path.join(bundle, 'Story Vault'), path.join(bundle, 'Notes Vault'));
    const chapterDir = path.dirname(sceneOnePath);
    let chmodPrior: ChmodPrior | undefined;
    let app: ElectronApplication | undefined;

    try {
      app = await launchApp(userData);
      const page = await firstWindow(app);
      await openScene(page, SCENE_ONE, SEED_PROSE_ONE);

      const surface = page.locator('.ProseMirror').first();
      await surface.click();
      await page.keyboard.press('F11');
      await expect(page.locator('.desktop-shell.distraction-free')).toBeVisible({ timeout: 10_000 });

      await page.keyboard.press('End');
      await page.keyboard.insertText(' Baseline save proof.');
      await waitForSceneBodyContains(sceneOnePath, 'Baseline save proof');
      await expect(page.locator('.focus-save-ok')).toBeVisible({ timeout: SAVE_OK_VISIBLE_WAIT_MS });

      chmodPrior = lockChapterForRefusedWrite(chapterDir, sceneOnePath);
      const typed = ' Then the room went dark.';
      await page.keyboard.insertText(typed);
      await expect(surface).toContainText(typed);
      await waitForSaveErrorBanner(page);
      const banner = page.getByTestId('scene-save-warning').first();
      await expect(banner).toContainText(SCENE_ONE);
      await expect(banner).toContainText('Your text is still in the editor');
      await waitForSceneBodyExcludes(sceneOnePath, typed.trim());
      await page.waitForTimeout(SAVE_OK_VISIBLE_WAIT_MS);
      await expect(page.locator('.focus-save-ok')).toHaveCount(0);

      unlockChapter(chapterDir, sceneOnePath, chmodPrior);
      chmodPrior = undefined;
      await page.getByTestId('scene-save-warning-region').getByRole('button', { name: 'Retry' }).click();
      await expect.poll(async () => page.getByTestId('scene-save-warning').count(), { timeout: 10_000 })
        .toBe(0);
      await waitForSceneBodyContains(sceneOnePath, typed.trim());

      await surface.click();
      await page.keyboard.insertText(' Second pass.');
      await waitForSceneBodyContains(sceneOnePath, 'Second pass');
    } finally {
      if (chmodPrior) {
        try { unlockChapter(chapterDir, sceneOnePath, chmodPrior); } catch { /* cleanup */ }
      }
      try { await app?.close(); } catch { /* cleanup */ }
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  test('TC-SE-02a: Story Vault folder removed while scene is open — vault rescaffolds, text saves, no banner', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-save-err-vault-gone-'));
    const userData = path.join(tmpRoot, 'user-data');
    const bundle = path.join(tmpRoot, 'Save Error Vault');
    const { vaultRoot } = seedV2Vault(bundle);
    seedUserData(userData, vaultRoot, path.join(bundle, 'Notes Vault'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchApp(userData);
      const page = await firstWindow(app);
      await openScene(page, SCENE_ONE, SEED_PROSE_ONE);

      fs.rmSync(vaultRoot, { recursive: true, force: true });

      const typed = ' Vault removed marker.';
      const surface = page.locator('.ProseMirror').first();
      await surface.click();
      await page.keyboard.insertText(typed);
      await expect.poll(async () => page.getByTestId('scene-save-warning').count(), {
        timeout: SAVE_ERROR_BANNER_TIMEOUT_MS,
      }).toBe(0);
      await waitForVaultContainsText(vaultRoot, typed.trim());
      expect(fs.existsSync(vaultRoot)).toBe(true);
      await expect(page.locator('.desktop-shell')).toBeVisible();
    } finally {
      try { await app?.close(); } catch { /* cleanup */ }
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  test('TC-SE-02b: unwritable bundle parent while scene open — save error banner, no crash', async () => {
    test.skip(process.platform === 'win32', 'read-only chmod assertion runs on Linux CI');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-save-err-bundle-ro-'));
    const userData = path.join(tmpRoot, 'user-data');
    const bundle = path.join(tmpRoot, 'Save Error Vault');
    const { vaultRoot } = seedV2Vault(bundle);
    seedUserData(userData, vaultRoot, path.join(bundle, 'Notes Vault'));
    let priorBundleMode: number | undefined;
    let app: ElectronApplication | undefined;

    try {
      app = await launchApp(userData);
      const page = await firstWindow(app);
      await openScene(page, SCENE_ONE, SEED_PROSE_ONE);

      fs.rmSync(vaultRoot, { recursive: true, force: true });
      priorBundleMode = lockBundleUnwritable(bundle);

      const surface = page.locator('.ProseMirror').first();
      await surface.click();
      await page.keyboard.insertText(' After bundle locked.');
      await waitForSaveErrorBanner(page);
      await expect(page.locator('.desktop-shell')).toBeVisible();
    } finally {
      if (priorBundleMode !== undefined) {
        try { fs.chmodSync(bundle, priorBundleMode | 0o200); } catch { /* cleanup */ }
      }
      try { await app?.close(); } catch { /* cleanup */ }
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  test('TC-SE-03: type then switch scene immediately — first scene file has the text', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-save-err-switch-'));
    const userData = path.join(tmpRoot, 'user-data');
    const bundle = path.join(tmpRoot, 'Save Error Vault');
    const { sceneOnePath } = seedV2Vault(bundle);
    seedUserData(userData, path.join(bundle, 'Story Vault'), path.join(bundle, 'Notes Vault'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchApp(userData);
      const page = await firstWindow(app);
      await openScene(page, SCENE_ONE, SEED_PROSE_ONE);

      const surface = page.locator('.ProseMirror').first();
      await surface.click();
      const typed = ' Quick switch marker.';
      await page.keyboard.insertText(typed);
      await page.getByRole('button', { name: new RegExp(SCENE_TWO) }).first().click();
      await expect(page.locator('.ProseMirror').first()).toContainText(SEED_PROSE_TWO, { timeout: 10_000 });
      await waitForSceneBodyContains(sceneOnePath, typed.trim());
    } finally {
      try { await app?.close(); } catch { /* cleanup */ }
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  test('TC-SE-04: idle autosave lands on disk without closing the app', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-save-err-idle-'));
    const userData = path.join(tmpRoot, 'user-data');
    const bundle = path.join(tmpRoot, 'Save Error Vault');
    const { sceneOnePath } = seedV2Vault(bundle);
    seedUserData(userData, path.join(bundle, 'Story Vault'), path.join(bundle, 'Notes Vault'));
    let app: ElectronApplication | undefined;

    try {
      app = await launchApp(userData);
      const page = await firstWindow(app);
      await openScene(page, SCENE_ONE, SEED_PROSE_ONE);

      const typed = ' Idle autosave marker.';
      await page.locator('.ProseMirror').first().click();
      await page.keyboard.insertText(typed);
      await waitForSceneBodyContains(sceneOnePath, typed.trim());
    } finally {
      try { await app?.close(); } catch { /* cleanup */ }
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  test('TC-SE-05: hard kill after autosave — relaunch keeps text up to last save', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-save-err-kill-'));
    const userData = path.join(tmpRoot, 'user-data');
    const bundle = path.join(tmpRoot, 'Save Error Vault');
    const { sceneOnePath } = seedV2Vault(bundle);
    seedUserData(userData, path.join(bundle, 'Story Vault'), path.join(bundle, 'Notes Vault'));
    let app: ElectronApplication | undefined;
    let app2: ElectronApplication | undefined;

    try {
      app = await launchApp(userData);
      const page = await firstWindow(app);
      await openScene(page, SCENE_ONE, SEED_PROSE_ONE);

      const saved = ' Persisted before kill.';
      await page.locator('.ProseMirror').first().click();
      await page.keyboard.insertText(saved);
      await waitForSceneBodyContains(sceneOnePath, saved.trim());

      const proc = app.process();
      const exited = new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
      });
      proc.kill('SIGKILL');
      await exited;

      app2 = await launchApp(userData);
      const page2 = await firstWindow(app2);
      await openScene(page2, SCENE_ONE, SEED_PROSE_ONE);
      await expect(page2.locator('.ProseMirror').first()).toContainText(saved.trim());
    } finally {
      try { await app2?.close(); } catch { /* cleanup */ }
      try { await app?.close(); } catch { /* cleanup */ }
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });
});