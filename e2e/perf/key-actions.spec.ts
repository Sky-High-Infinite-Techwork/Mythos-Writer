/**
 * key-actions.spec.ts — test gap 10 (#1913, tracking #1903).
 *
 * CI-gated perf budgets for nine actions. The fixture and the stop
 * conditions match the audit scratch in #1903 (packaged out/ build,
 * --force-prefers-reduced-motion, veynn-v2 mythos.json, Story Vault,
 * book.md spine). One measured launch per startup metric. The 300-scene
 * launch continues into open-big-scene, the three view switches, and the
 * three exports so the shard grows by one extra app boot, not nine.
 *
 * Big-doc typing, switch-back to Story Writer, and Boards are slice 11.
 *
 * Report mode (ENFORCE_BUDGETS = false) logs `[perf] metric=<name> ms=<n>`
 * and does not fail on time. After 20 CI samples, budgets become
 * max(2× CI p95, 1.25× CI max) and never above BOX_CAPS_MS.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, firstWindow, MAIN_JS } from '../helpers/launchApp';

const NOW = '2026-07-01T00:00:00.000Z';
const STORY_TITLE = 'Audit Perf Story';
const SMALL_SCENE_COUNT = 300;
const BIG_BYTES = 500 * 1024;
const TAIL = 'AUDIT-TAIL-MARKER-ZQX';
const SCENE_COUNT = SMALL_SCENE_COUNT + 1;

/** Box caps from #1913. A budget above its cap is a loosened gate. */
const BOX_CAPS_MS = {
  launch_empty_to_story_tree_ms: 3_500,
  launch_300_to_story_tree_ms: 6_000,
  open_big_scene_500kb_ms: 5_500,
  switch_timeline_ms: 700,
  switch_mythos_ms: 300,
  switch_notes_editor_ms: 4_500,
  export_docx_301_ms: 1_500,
  export_epub_301_ms: 800,
  export_pdf_301_ms: 8_000,
} as const;

type PerfMetric = keyof typeof BOX_CAPS_MS;

/**
 * Flip to true only after the calibration table is in the PR.
 * While false, every action still has to complete; only the time check is off.
 */
const ENFORCE_BUDGETS = false;

/** Placeholder until calibration. Must stay <= BOX_CAPS_MS. */
const BUDGETS_MS: { [K in PerfMetric]: number } = { ...BOX_CAPS_MS };

const METRICS = Object.keys(BOX_CAPS_MS) as PerfMetric[];

function assertBudgetsWithinCaps(): void {
  for (const metric of METRICS) {
    if (BUDGETS_MS[metric] > BOX_CAPS_MS[metric]) {
      throw new Error(
        `budget for ${metric} (${BUDGETS_MS[metric]}) is looser than box cap ${BOX_CAPS_MS[metric]}`,
      );
    }
  }
}

function perf(metric: PerfMetric, ms: number): void {
  const rounded = Math.round(ms);
  console.log(`[perf] metric=${metric} ms=${rounded}`);
  if (!ENFORCE_BUDGETS) return;
  expect.soft(
    rounded,
    `${metric} ${rounded}ms exceeded budget ${BUDGETS_MS[metric]}ms (box cap ${BOX_CAPS_MS[metric]}ms)`,
  ).toBeLessThanOrEqual(BUDGETS_MS[metric]);
}

function prose(bytes: number): string {
  const unit = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

interface SeededVault {
  root: string;
  userData: string;
  chapterDir: string;
}

/**
 * Audit scratch seed. `smallScenes = 0` is the empty-vault launch: the story,
 * chapter, and the 500 KB scene file are on disk (the scratch always wrote
 * Scene 000) and none of the 8 KB scenes are. `smallScenes = 300` is the
 * 301-scene vault (300 × 8 KB + the 500 KB scene).
 */
function seedVault(smallScenes: number): SeededVault {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mythos-key-actions-${smallScenes}-`));
  const userData = path.join(root, 'ud');
  const bundle = path.join(root, 'vault');
  const notes = path.join(bundle, 'Notes Vault');
  const storyDir = path.join(bundle, 'Story Vault', STORY_TITLE);
  const chapterDir = path.join(storyDir, 'Part 1', 'Chapter 01');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(chapterDir, { recursive: true });
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({ onboardingComplete: true, theme: 'dark' }),
  );
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({ vaultRoot: path.join(bundle, 'Story Vault'), notesVaultRoot: notes }),
  );
  fs.writeFileSync(
    path.join(bundle, 'mythos.json'),
    JSON.stringify({
      formatVersion: 2,
      id: 'vault-audit',
      name: 'Audit Vault',
      createdAt: NOW,
      stories: [{ id: 'story-audit', title: STORY_TITLE, folder: STORY_TITLE, createdAt: NOW, updatedAt: NOW }],
      seed: { layout: 'veynn-v2', mode: 'blank', seededAt: NOW },
    }),
  );
  const spine = [{ dir: 'Part 1', chapters: [{ dir: 'Chapter 01', id: 'ch-audit', title: 'Chapter One' }] }];
  fs.writeFileSync(
    path.join(storyDir, 'book.md'),
    [
      '---',
      'id: story-audit',
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
  const small = prose(8 * 1024);
  const bigBody = prose(BIG_BYTES).replace(/\. /g, '.\n\n');
  fs.writeFileSync(
    path.join(chapterDir, 'Scene 000.md'),
    `---\nid: scene-big\ntitle: Big Scene\nstatus: draft\nupdatedAt: ${NOW}\n---\n${bigBody}\n\n${TAIL}\n`,
  );
  for (let i = 1; i <= smallScenes; i += 1) {
    const id = String(i).padStart(3, '0');
    fs.writeFileSync(
      path.join(chapterDir, `Scene ${id}.md`),
      `---\nid: scene-${id}\ntitle: Scene ${id}\nstatus: draft\nupdatedAt: ${NOW}\n---\n${small}\n`,
    );
  }
  return { root, userData, chapterDir };
}

async function revealStoryTree(page: Page): Promise<void> {
  const nav = page.locator('nav[aria-label="Main navigation"]');
  await nav.waitFor({ state: 'visible', timeout: 60_000 });
  const storyBtn = nav.getByRole('button', { name: /^story( writer)?$/i }).first();
  await storyBtn.waitFor({ state: 'visible', timeout: 60_000 });
  if ((await storyBtn.getAttribute('aria-current')) !== 'page') {
    await storyBtn.click();
  }
  const backdrop = page.locator('[data-testid="nav-rail-stories-backdrop"]');
  if (await backdrop.count()) {
    await backdrop.click({ position: { x: 5, y: 5 }, force: true });
    await expect(backdrop).toHaveCount(0);
  }
  // The row's accessible name includes the chevron, so match the title as a substring.
  await page.getByRole('button', { name: new RegExp(STORY_TITLE) }).first().waitFor({
    state: 'visible',
    timeout: 60_000,
  });
}

async function dismissBackdrop(page: Page): Promise<void> {
  const backdrop = page.locator('[data-testid="nav-rail-stories-backdrop"]');
  if (await backdrop.count()) {
    await backdrop.click({ position: { x: 5, y: 5 }, force: true });
    await expect(backdrop).toHaveCount(0);
  }
}

/** Native save dialogs cannot be driven. The export handlers themselves are not patched. */
async function patchSaveDialog(app: ElectronApplication, exportDir: string): Promise<void> {
  await app.evaluate(({ dialog }, { dir }: { dir: string }) => {
    let counter = 0;
    (dialog as unknown as Record<string, unknown>).showSaveDialog = async (
      options: { filters?: Array<{ extensions?: string[] }> },
    ) => {
      const ext = options?.filters?.[0]?.extensions?.[0] ?? 'bin';
      const getBuiltinModule = (process as unknown as {
        getBuiltinModule: (id: string) => { join: (...parts: string[]) => string };
      }).getBuiltinModule;
      const nodePath = getBuiltinModule('path');
      return { canceled: false, filePath: nodePath.join(dir, `key-action-${counter++}.${ext}`) };
    };
  }, { dir: exportDir });
}

function assertExportBytes(exportDir: string, ext: string, magic: string): void {
  const names = fs.readdirSync(exportDir).filter((name) => name.endsWith(`.${ext}`));
  expect(names, `expected a .${ext} file in ${exportDir}`).toHaveLength(1);
  const buf = fs.readFileSync(path.join(exportDir, names[0]!));
  expect(buf.length, `${ext} export must contain the 301-scene book`).toBeGreaterThan(10_000);
  expect(buf.subarray(0, magic.length).toString('latin1')).toBe(magic);
}

async function switchView(page: Page, label: string): Promise<number> {
  const nav = page.locator('nav[aria-label="Main navigation"]');
  const button = nav.getByRole('button', { name: label, exact: true });
  await expect(button).toBeVisible({ timeout: 15_000 });
  // Playwright's click() waits until the rail stops moving, and that wait
  // belongs to the previous view. Trial absorbs it. The sample is the click
  // that fires through aria-current plus two frames — the audit's stop.
  await button.click({ trial: true, timeout: 20_000 });
  const started = Date.now();
  await button.click({ force: true, noWaitAfter: true });
  await expect(button).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  return Date.now() - started;
}

let emptyVault: SeededVault;
let largeVault: SeededVault;
const openApps: ElectronApplication[] = [];

test.beforeAll(() => {
  assertBudgetsWithinCaps();
  expect(fs.existsSync(MAIN_JS), `packaged build missing at ${MAIN_JS}`).toBe(true);
  emptyVault = seedVault(0);
  largeVault = seedVault(SMALL_SCENE_COUNT);
  const sceneFiles = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
  expect(sceneFiles(emptyVault.chapterDir)).toEqual(['Scene 000.md']);
  expect(sceneFiles(largeVault.chapterDir)).toHaveLength(SCENE_COUNT);
  expect(fs.readFileSync(path.join(largeVault.chapterDir, 'Scene 000.md'), 'utf8')).toContain(TAIL);
  const bigStat = fs.statSync(path.join(largeVault.chapterDir, 'Scene 000.md'));
  expect(bigStat.size).toBeGreaterThan(BIG_BYTES);
});

test.afterAll(async () => {
  for (const app of openApps) {
    await app.close().catch(() => undefined);
  }
  for (const vault of [emptyVault, largeVault]) {
    if (vault) fs.rmSync(vault.root, { recursive: true, force: true });
  }
});

async function launchMeasured(userData: string): Promise<{ app: ElectronApplication; page: Page; started: number }> {
  const started = Date.now();
  const app = await launchApp(userData, { reducedMotion: true });
  openApps.push(app);
  const page = await firstWindow(app);
  page.on('pageerror', (error) => console.log('[renderer:pageerror]', error.message));
  return { app, page, started };
}

test('launch to story tree, empty vault', async () => {
  test.setTimeout(120_000);
  const { app, page, started } = await launchMeasured(emptyVault.userData);
  try {
    await revealStoryTree(page);
    perf('launch_empty_to_story_tree_ms', Date.now() - started);
  } finally {
    await app.close().catch(() => undefined);
  }
});

test('launch 300-scene vault, open 500KB scene, switch view, export book', async () => {
  test.setTimeout(240_000);
  const exportDir = path.join(largeVault.root, 'exports');
  fs.mkdirSync(exportDir);

  const { app, page, started } = await launchMeasured(largeVault.userData);
  await revealStoryTree(page);
  perf('launch_300_to_story_tree_ms', Date.now() - started);

  await patchSaveDialog(app, exportDir);

  const chapterRow = page.getByRole('button', { name: /Chapter One/ }).first();
  const big = page.getByRole('button', { name: /Big Scene/ }).first();
  if (!(await chapterRow.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: new RegExp(STORY_TITLE) }).first().click();
  }
  await expect(chapterRow).toBeVisible({ timeout: 20_000 });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await big.isVisible().catch(() => false)) break;
    await chapterRow.click();
    try {
      await big.waitFor({ state: 'visible', timeout: 3_000 });
      break;
    } catch {
      /* reindex collapsed the chapter — retry */
    }
  }
  await expect(big).toBeVisible({ timeout: 20_000 });

  const editor = page.locator('.ProseMirror').first();
  const other = page.getByRole('button', { name: /Scene 001/ }).first();
  await other.click();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor).toContainText('Lorem', { timeout: 30_000 });
  await expect(editor).not.toContainText(TAIL, { timeout: 30_000 });

  const openStarted = Date.now();
  await big.click();
  await expect(editor).toContainText(TAIL, { timeout: 60_000 });
  perf('open_big_scene_500kb_ms', Date.now() - openStarted);

  const nav = page.locator('nav[aria-label="Main navigation"]');
  const navLabels = (await nav.getByRole('button').allInnerTexts()).map((label) => label.trim()).filter(Boolean);
  console.log(`[perf] nav=${JSON.stringify(navLabels)}`);

  // Timeline, Mythos (rail label of the Partner module), Notes Editor.
  // Boards and the return to Story Writer belong to slice 11.
  // Notes Editor is the first switch off the 500 KB scene. That matches the
  // audit loop, where Notes was the first real navigation and carried the
  // multi-second cost (cap 4 500). Mythos and Timeline are the later, fast
  // switches. Boards and the return to Story Writer are slice 11.
  perf('switch_notes_editor_ms', await switchView(page, 'Notes Editor'));
  await dismissBackdrop(page);
  await expect(page.getByTestId('notes-tab-panel')).toBeVisible({ timeout: 15_000 });

  perf('switch_mythos_ms', await switchView(page, 'Mythos'));
  await dismissBackdrop(page);
  await expect(page.getByRole('textbox', { name: 'Brainstorm prompt' })).toBeVisible({ timeout: 15_000 });

  perf('switch_timeline_ms', await switchView(page, 'Timeline'));
  await dismissBackdrop(page);
  await expect(page.getByTestId('timeline-root')).toBeVisible({ timeout: 15_000 });

  const formats: Array<{ value: string; metric: PerfMetric; magic: string }> = [
    { value: 'docx', metric: 'export_docx_301_ms', magic: 'PK' },
    { value: 'epub', metric: 'export_epub_301_ms', magic: 'PK' },
    { value: 'pdf', metric: 'export_pdf_301_ms', magic: '%PDF' },
  ];
  for (const format of formats) {
    await page.getByTestId('wc-menu-file').click();
    await page.locator('.wc-menu-item', { hasText: 'Export…' }).click();
    const dialog = page.locator('[role="dialog"][aria-labelledby="export-dialog-title"]');
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Full book', exact: true }).click();
    await expect(dialog.getByText(`${SCENE_COUNT} scenes`)).toBeVisible({ timeout: 15_000 });
    await dialog.locator(`input[type="radio"][value="${format.value}"]`).click();
    const exportStarted = Date.now();
    await dialog.getByRole('button', { name: /^Export/ }).click();
    await expect(dialog.getByText('Export complete')).toBeVisible({ timeout: 120_000 });
    perf(format.metric, Date.now() - exportStarted);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    assertExportBytes(exportDir, format.value, format.magic);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  }
  await app.close().catch(() => undefined);
});
