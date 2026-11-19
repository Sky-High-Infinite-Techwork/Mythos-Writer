// SKY-3180 (Part A · A5): Shell relayout E2E + regression sweep.
//
// Covers the acceptance criteria that PR #809's selector-migration pass did not:
//   - Single GlobalRightSidebar instance across every AppNavRail/tab mode (Story, Notes, Brainstorm).
//   - Story sub-view render sweep (editor/kanban/structure/timeline) under the new shell.
//   - Beta 4 M4: workspace tab strip visibility — tabs are documents now, so
//     the strip starts empty on a fresh vault, shows the pinned Scene Crafter
//     Setup tab on Scene Crafter (SKY-11069: docs/board strip), and is hidden
//     on Timeline/Brainstorm (FULL-SPEC §4).
//   - W1 (PLAN-WIDGET-SYSTEM-v2): scope model + page shell defaults behind the widget shell beta flag
//     (page panels open inside their page; the global sidebar holds global panels only). See the
//     "W1 widget shell" describes at the end of this file.
import path from 'path';
import os from 'os';
import fs from 'fs';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { clickStoryNav } from './helpers/navGuard';
import {
  firstWindow as firstSeededWindow,
  launchApp as launchSeededApp,
  makeScratch,
  openSeededScene,
  rmScratch,
  seedUserData as seedSceneUserData,
  seedVault,
  type Scratch,
} from './helpers/launchApp';
import { closeElectronApp } from './helpers/electronTeardown';

const MAIN_JS = path.resolve(__dirname, '../out/main/main.js');
const RIGHT_SIDEBAR_SEL = '[data-testid="global-right-sidebar"], .grs-collapsed-edge';

function seedUserData(userData: string, vaultDir: string, notesVaultDir: string): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(notesVaultDir, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({ onboardingComplete: true, theme: 'dark' }, null, 2),
  );
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({ vaultRoot: vaultDir, notesVaultRoot: notesVaultDir }, null, 2),
  );
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  const extraArgs = (process.platform !== 'darwin' && !process.env.DISPLAY) ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', ...extraArgs],
    timeout: 60_000,
  });
}

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}

const CTRL3 = process.platform === 'darwin' ? 'Meta+3' : 'Control+3';

// ─── Single right sidebar across every mode ──────────────────────────────────

test.describe('Shell relayout — single GlobalRightSidebar across modes', () => {
  let tempRoot: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-shell-sidebar-'));
    userData = path.join(tempRoot, 'userData');
    seedUserData(userData, path.join(tempRoot, 'story-vault'), path.join(tempRoot, 'notes-vault'));
    app = await launchApp(userData);
    page = await firstWindow(app);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('exactly one right sidebar element renders in Story mode', async () => {
    await expect(page.locator(RIGHT_SIDEBAR_SEL)).toHaveCount(1, { timeout: 10_000 });
  });

  test('exactly one right sidebar element renders in Notes mode', async () => {
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Notes' }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Notes' }))
      .toHaveAttribute('aria-current', 'page', { timeout: 5_000 });
    await expect(page.locator(RIGHT_SIDEBAR_SEL)).toHaveCount(1, { timeout: 10_000 });
  });

  test('exactly one right sidebar element renders in Brainstorm mode', async () => {
    await page.keyboard.press(CTRL3);
    await expect(page.locator('[aria-labelledby="app-tab-brainstorm"]')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator(RIGHT_SIDEBAR_SEL)).toHaveCount(1, { timeout: 10_000 });

    // Restore Story mode for any later test ordering assumptions.
    await clickStoryNav(page);
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Story' }))
      .toHaveAttribute('aria-current', 'page', { timeout: 5_000 });
  });
});

// ─── Story sub-view render sweep ──────────────────────────────────────────────

test.describe('Shell relayout — Story sub-view render sweep', () => {
  let tempRoot: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-shell-subview-'));
    userData = path.join(tempRoot, 'userData');
    seedUserData(userData, path.join(tempRoot, 'story-vault'), path.join(tempRoot, 'notes-vault'));
    app = await launchApp(userData);
    page = await firstWindow(app);
    await expect(page.locator('[data-testid="story-subview-bar"]')).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('Editor sub-view is the default and renders unchanged', async () => {
    await expect(page.locator('[data-testid="story-subview-editor"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.shell-panels')).toBeVisible({ timeout: 5_000 });
  });

  test('Scene Board (kanban) sub-view renders unchanged', async () => {
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Scene Crafter"]').click();
    await expect(page.locator('[data-testid="story-subview-bar"]')).not.toBeVisible({ timeout: 3_000 });
    await expect(page.locator('.shell-kanban')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.shell-panels')).not.toBeVisible();
  });

  test('Structure sub-view renders unchanged', async () => {
    // SKY-9019/M5: the previous test left the shell on rail-only kanban where the
    // sub-view bar is hidden — return to the Story section first.
    await clickStoryNav(page);
    await expect(page.locator('[data-testid="story-subview-bar"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="story-subview-structure"]').click();
    await expect(page.locator('[data-testid="story-subview-structure"]')).toHaveAttribute('aria-selected', 'true', { timeout: 3_000 });
    await expect(page.locator('.shell-structure')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.shell-kanban')).not.toBeVisible();
  });

  test('Timeline sub-view renders unchanged', async () => {
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Timeline"]').click();
    await expect(page.locator('[data-testid="story-subview-bar"]')).not.toBeVisible({ timeout: 3_000 });
    await expect(page.locator('.shell-timeline')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.shell-structure')).not.toBeVisible();
  });

  test('returning to Editor sub-view renders unchanged', async () => {
    await clickStoryNav(page);
    await expect(page.locator('[data-testid="story-subview-bar"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="story-subview-editor"]').click();
    await expect(page.locator('[data-testid="story-subview-editor"]')).toHaveAttribute('aria-selected', 'true', { timeout: 3_000 });
    await expect(page.locator('.shell-panels')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.shell-timeline')).not.toBeVisible();
  });
});

// ─── Beta 4 M4: workspace tab strip = documents (FULL-SPEC §4) ────────────────

test.describe('Shell relayout — M4 workspace tab strip visibility', () => {
  let tempRoot: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-shell-wtb-'));
    userData = path.join(tempRoot, 'userData');
    seedUserData(userData, path.join(tempRoot, 'story-vault'), path.join(tempRoot, 'notes-vault'));
    app = await launchApp(userData);
    page = await firstWindow(app);
    await expect(page.getByRole('tablist', { name: 'Workspace tabs' })).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('the strip starts with no document tabs on a fresh vault, + button present', async () => {
    // M4: tabs are documents — module mirrors no longer seed the strip.
    const tabs = page.getByRole('tablist', { name: 'Workspace tabs' }).getByRole('tab');
    await expect(tabs).toHaveCount(0);
    await expect(page.locator('[data-testid="wtb-new-tab-btn"]')).toBeVisible();
  });

  test('Scene Crafter (kanban) shows the pinned Setup tab in the workspace strip', async () => {
    // SKY-11069 owner ruling: Scene Crafter is a docs/board strip now — a
    // pinned "Scene Crafter" Setup tab, not the static view pseudo-tab.
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Scene Crafter"]').click();
    const setupTab = page.locator(
      '[role="tablist"][aria-label="Workspace tabs"] [role="tab"]',
      { hasText: 'Scene Crafter' },
    );
    await expect(setupTab).toBeVisible({ timeout: 5_000 });
    // The + (new board) stays available (SKY-11069: board strip "+" creates a board).
    await expect(page.locator('[data-testid="wtb-new-tab-btn"]')).toBeVisible();
  });

  test('the strip is hidden on the Timeline sub-view', async () => {
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Timeline"]').click();
    await expect(page.locator('.shell-timeline')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('tablist', { name: 'Workspace tabs' })).toHaveCount(0);
  });

  test('the strip is hidden on Brainstorm and returns on the Story editor', async () => {
    await page.keyboard.press(CTRL3);
    await expect(page.locator('[aria-labelledby="app-tab-brainstorm"]')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('tablist', { name: 'Workspace tabs' })).toHaveCount(0);

    await clickStoryNav(page);
    await page.locator('[data-testid="story-subview-editor"]').click();
    await expect(page.getByRole('tablist', { name: 'Workspace tabs' })).toBeVisible({ timeout: 5_000 });
  });
});

// ─── W1 widget shell: page panels open inside their page ─────────────────────
//
// Widget shell beta flag ON (seeded `widgetShell: true`; W1 has no toggle and writes no settings):
//   - Story Editor opens with the Story Navigator inside the page and a page-only inspector
//     (`edPanel`: Scenes + the hub's full Notes & Analysis tab; no Findings / Suggestions / partner).
//   - The toolbar Continuity scan expands `edPanel` on Notes & Analysis.
//   - The right sidebar holds the global partner only (no Scenes / Notes & Analysis tabs); its Add
//     menu splits Global vs This page, lists Findings as a full global panel, and never lists Beta.
//     "On this page" counts only panels W1 renders there (other pages list theirs as inert).
//   - Brainstorm shows the Idea Board with no page-level partner chat face.
//   - Keyboard collapse works and the editor is never remounted (remount count 0).
//   - Focus mode hides the inspector like the right sidebar.
//   - axe passes on the page chrome.
// AI Off (flag on): the partner, Findings, AI activity and Inbox are hidden or inert.
// Flag OFF: the old shell, unchanged.

interface ShellOptions {
  widgetShell: boolean;
  aiEnabled: boolean;
}

interface ShellSession {
  app: ElectronApplication;
  page: Page;
  scratch: Scratch;
}

/** Seeds a one-scene vault, applies the flag + AI mode, launches, and opens the Story Editor by clicking. */
async function openShell({ widgetShell, aiEnabled }: ShellOptions): Promise<ShellSession> {
  const scratch = makeScratch('page-panels');
  let app: ElectronApplication | undefined;
  try {
    seedVault(scratch.vaultDir);
    seedSceneUserData(scratch.userData, scratch.vaultDir, scratch.notesVaultDir);
    const settingsPath = path.join(scratch.userData, 'app-settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown> & {
      agents: Record<string, Record<string, unknown>>;
    };
    settings.agents.brainstorm = { ...settings.agents.brainstorm, enabled: true };
    // The Notes & Analysis continuity panel shows its scan toolbar (and scene picker) only while the
    // Archive Agent is on; seedSceneUserData leaves every agent off. Same precondition as plan058-l7-partner.
    settings.agents.archive = { ...settings.agents.archive, enabled: true };
    const patched = {
      ...settings,
      ai: { enabled: aiEnabled },
      gettingStartedDismissed: true,
      vaultUpgradePromptShown: true,
      ...(widgetShell ? { widgetShell: true } : {}),
    };
    fs.writeFileSync(settingsPath, JSON.stringify(patched, null, 2));

    app = await launchSeededApp(scratch.userData);
    const page = await firstSeededWindow(app);
    const notNow = page.getByRole('button', { name: /not now/i });
    if (await notNow.count()) await notNow.first().click().catch(() => {});
    await openSeededScene(page);
    return { app, page, scratch };
  } catch (err) {
    // A failed launch or setup must not leak the Electron process or the scratch dirs.
    await closeElectronApp(app);
    rmScratch(scratch);
    throw err;
  }
}

async function closeShell(session: ShellSession | undefined): Promise<void> {
  if (!session) return;
  try {
    await closeElectronApp(session.app);
  } finally {
    rmScratch(session.scratch);
  }
}

interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: { target: string[] }[];
}

let axeSource: string | undefined;

/** Runs axe (WCAG 2 A/AA) on one element through CDP evaluate — the renderer CSP blocks script tags. */
async function axeViolations(page: Page, selector: string): Promise<AxeViolation[]> {
  if (axeSource === undefined) {
    axeSource = fs.readFileSync(path.resolve(__dirname, '../node_modules/axe-core/axe.min.js'), 'utf8');
  }
  await page.evaluate(axeSource);
  return page.evaluate(async (sel) => {
    const target = document.querySelector(sel);
    if (!target) throw new Error(`axe target not found: ${sel}`);
    const axe = (window as unknown as {
      axe: { run: (root: Element, options: object) => Promise<{ violations: AxeViolation[] }> };
    }).axe;
    const result = await axe.run(target, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
    return result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => ({ target: n.target })) }));
  }, selector);
}

const sidebar = (page: Page) => page.getByTestId('global-right-sidebar');
const editorInspector = (page: Page) => page.locator('#app-tabpanel-story').getByTestId('page-panel-edPanel');

test.describe('W1 widget shell ON — page panels open inside their page', () => {
  test.describe.configure({ mode: 'serial' });
  let session: ShellSession | undefined;
  test.beforeAll(async () => { session = await openShell({ widgetShell: true, aiEnabled: true }); });
  test.afterAll(async () => { await closeShell(session); });

  test('Story Editor shows the Story Navigator in the page and a page-only inspector', async () => {
    const { page } = session!;
    const nav = page.locator('#app-tabpanel-story [data-panel-id="navEditor"]');
    await expect(nav).toBeVisible();
    await expect(nav).toHaveAttribute('data-scope', 'page:editor');
    await expect(nav.locator('.story-navigator')).toBeVisible();

    const inspector = editorInspector(page);
    await expect(inspector).toBeVisible();
    await expect(inspector).toHaveAttribute('data-scope', 'page:editor');
    await expect(inspector.getByRole('tab')).toHaveText(['Scenes', 'Notes & Analysis']);
    await expect(inspector.getByRole('tab', { name: /findings|suggestions/i })).toHaveCount(0);
    await expect(inspector.getByTestId('agent-hub-panel')).toHaveCount(0);

    // Global sidebar: the partner only. Scenes and Notes & Analysis are page tabs, so the sidebar drops them.
    await expect(sidebar(page).getByTestId('agent-hub-panel')).toBeVisible();
    await expect(sidebar(page).getByTestId('ahp-tab-partner')).toBeVisible();
    await expect(sidebar(page).getByTestId('ahp-tab-scenes')).toHaveCount(0);
    await expect(sidebar(page).getByTestId('ahp-tab-notes-analysis')).toHaveCount(0);
    await expect(sidebar(page).locator('[data-scope^="page:"]')).toHaveCount(0);
    await expect(sidebar(page).locator('[data-panel-id="navEditor"]')).toHaveCount(0);

    // Notes & Analysis is a page tab, and switching to it keeps the inspector page-only.
    await inspector.getByRole('tab', { name: 'Notes & Analysis' }).click();
    await expect(inspector.getByRole('tab', { name: 'Notes & Analysis' })).toHaveAttribute('aria-selected', 'true');
    await expect(inspector.getByTestId('agent-hub-panel')).toHaveCount(0);
    // It is the hub's full tab: scene analysis, the vault's open questions and the continuity panel.
    const notesAnalysis = inspector.getByTestId('ahp-notes-analysis');
    await expect(notesAnalysis).toBeVisible();
    await expect(notesAnalysis.getByRole('region', { name: 'Scene Analysis' })).toBeVisible();
    await expect(notesAnalysis.getByTestId('view-full-analysis')).toBeVisible();
    await expect(notesAnalysis.getByTestId('questions-for-you')).toBeVisible();
    await expect(notesAnalysis.getByTestId('cp-scan-scene-picker')).toBeVisible({ timeout: 6_000 });
  });

  test('toolbar Continuity scan expands the Editor inspector on Notes & Analysis', async () => {
    const { page } = session!;
    const inspector = editorInspector(page);
    await inspector.getByRole('tab', { name: 'Scenes' }).click();
    await inspector.getByRole('button', { name: 'Collapse Editor inspector' }).click();
    await expect(inspector.getByRole('button', { name: 'Expand Editor inspector' })).toHaveAttribute('aria-expanded', 'false');

    await page.getByTestId('msv-continuity-scan-btn').click();
    await expect(inspector.getByRole('button', { name: 'Collapse Editor inspector' })).toHaveAttribute('aria-expanded', 'true');
    await expect(inspector.getByRole('tab', { name: 'Notes & Analysis' })).toHaveAttribute('aria-selected', 'true');
    await expect(inspector.getByTestId('ahp-notes-analysis').getByTestId('cp-scan-scene-picker')).toBeVisible({ timeout: 6_000 });
    // The sidebar stays on the global partner; the scan never lands on a hidden hub tab.
    await expect(sidebar(page).getByTestId('ahp-tab-partner')).toHaveAttribute('aria-selected', 'true');
    await expect(sidebar(page).getByTestId('ahp-notes-analysis')).toHaveCount(0);
  });

  test('Add menu: Global vs This page sections, Findings as a full global panel, no Beta list', async () => {
    const { page } = session!;
    await sidebar(page).getByTestId('grs-add-panel-btn').click();
    const globalSection = page.getByTestId('grs-add-panel-section-global');
    const pageSection = page.getByTestId('grs-add-panel-section-page');
    await expect(globalSection).toBeVisible();
    await expect(pageSection).toBeVisible();

    const findings = globalSection.getByTestId('grs-add-panel-item-findings');
    await expect(findings).toBeEnabled();
    await expect(findings).toHaveAttribute('data-scope', 'global');
    await expect(findings).toHaveAttribute('data-kind', 'full');
    await expect(page.getByTestId('grs-add-panel-item-navBeta')).toHaveCount(0);
    await expect(page.getByTestId('grs-add-panel-item-betaPanel')).toHaveCount(0);
    // Bridge: the partner panel still hosts the Suggestions tab, so it is not offered twice.
    await expect(page.getByTestId('grs-add-panel-item-suggestions')).toHaveCount(0);
    await expect(globalSection.locator('[data-scope^="page:"]')).toHaveCount(0);
    await expect(pageSection.locator('[data-scope="global"]')).toHaveCount(0);
    // The Editor renders both of its page panels (navEditor, edPanel), so none is offered.
    await expect(pageSection).toContainText("This page's panels are already open.");

    expect(await axeViolations(page, '[data-testid="grs-add-panel-popover"]')).toEqual([]);

    await findings.click();
    const findingsPanel = sidebar(page).getByTestId('global-panel-findings');
    await expect(findingsPanel).toBeVisible();
    await expect(findingsPanel).toHaveAttribute('data-scope', 'global');
    await expect(editorInspector(page).getByTestId('global-panel-findings')).toHaveCount(0);
  });

  test('keyboard collapse works and never remounts the editor', async () => {
    const { page } = session!;
    await page.evaluate(() => {
      const editor = document.querySelector('#app-tabpanel-story .ProseMirror');
      if (!editor) throw new Error('editor not mounted');
      (window as unknown as { __w1Editor?: Element }).__w1Editor = editor;
    });
    const editorRemounts = () => page.evaluate(() => {
      const before = (window as unknown as { __w1Editor?: Element }).__w1Editor;
      const now = document.querySelector('#app-tabpanel-story .ProseMirror');
      return before && before.isConnected && now === before ? 0 : 1;
    });

    const collapse = editorInspector(page).getByRole('button', { name: 'Collapse Editor inspector' });
    await collapse.focus();
    await page.keyboard.press('Enter');
    const expand = editorInspector(page).getByRole('button', { name: 'Expand Editor inspector' });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(expand).toBeFocused();
    await expect(editorInspector(page).getByRole('tablist', { name: 'Editor inspector tabs' })).toBeHidden();
    expect(await editorRemounts()).toBe(0);

    await page.keyboard.press('Space');
    await expect(editorInspector(page).getByRole('button', { name: 'Collapse Editor inspector' })).toHaveAttribute('aria-expanded', 'true');
    await expect(editorInspector(page).getByRole('tablist', { name: 'Editor inspector tabs' })).toBeVisible();
    expect(await editorRemounts()).toBe(0);

    // Docking the global sidebar away and back is a layout change too.
    await sidebar(page).getByRole('button', { name: 'Hide right sidebar' }).click();
    await page.getByRole('button', { name: 'Show right sidebar' }).click();
    await expect(sidebar(page)).toBeVisible();
    expect(await editorRemounts()).toBe(0);

    // Hot path, with no wall-clock budget: ten back-to-back toggles each commit before the next
    // frame (React 18 flushes a discrete click's update in a microtask, ahead of rAF), the body is
    // hidden rather than unmounted (the same tablist node stays connected), and the dock is never remounted.
    const toggles = await page.evaluate(async () => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const dock = document.querySelector('#app-tabpanel-story [data-testid="page-panel-edPanel"]');
      const tablist = dock?.querySelector('[role="tablist"]');
      if (!dock || !tablist) throw new Error('edPanel not mounted');
      const states: { expanded: string | null; bodyHidden: boolean; mounted: boolean }[] = [];
      for (let i = 0; i < 10; i += 1) {
        const button = dock.querySelector<HTMLButtonElement>('[data-testid="page-panel-edPanel-collapse"]');
        if (!button) throw new Error('collapse button missing');
        button.click();
        await frame();
        states.push({
          expanded: dock.querySelector('[data-testid="page-panel-edPanel-collapse"]')?.getAttribute('aria-expanded') ?? null,
          bodyHidden: tablist.closest('[hidden]') !== null,
          mounted: dock.isConnected && tablist.isConnected,
        });
      }
      return states;
    });
    expect(toggles).toEqual(Array.from({ length: 10 }, (_, i) => ({
      expanded: i % 2 === 0 ? 'false' : 'true',
      bodyHidden: i % 2 === 0,
      mounted: true,
    })));
    expect(await editorRemounts()).toBe(0);
  });

  test('axe passes on the page chrome', async () => {
    const { page } = session!;
    expect(await axeViolations(page, '[data-testid="page-panel-edPanel"]')).toEqual([]);
  });

  test('Focus mode hides the Editor inspector like the right sidebar, and Normal brings it back', async () => {
    const { page } = session!;
    await page.getByTestId('writing-mode-focus').click();
    await expect(page.getByTestId('writing-mode-focus')).toHaveAttribute('aria-pressed', 'true');
    await expect(sidebar(page)).not.toBeVisible();
    await expect(page.getByTestId('page-panel-edPanel')).toHaveCount(0);

    await page.getByTestId('writing-mode-normal').click();
    await expect(page.getByTestId('writing-mode-normal')).toHaveAttribute('aria-pressed', 'true');
    await expect(editorInspector(page)).toBeVisible();
  });

  test('Brainstorm shows the Idea Board and no page-level partner chat', async () => {
    const { page } = session!;
    await page.locator('[data-testid="nav-rail-brainstorm"]').click();
    const brainstorm = page.locator('#app-tabpanel-brainstorm');
    await expect(brainstorm).toBeVisible({ timeout: 10_000 });

    await expect(brainstorm.getByTestId('bs-collections')).toBeVisible();
    await expect(brainstorm.getByTestId('bsc-board')).toBeVisible();
    await expect(page.getByTestId('bsc-mode-chat')).toHaveCount(0);
    await expect(page.getByTestId('bs-board-side')).toHaveCount(0);
    await expect(brainstorm.locator('.brainstorm-input')).toHaveCount(0);

    // The partner stays global: the sidebar keeps it, and Brainstorm never claims the sidebar.
    await expect(sidebar(page).getByTestId('agent-hub-panel')).toBeVisible();
    await expect(sidebar(page).locator('.brainstorm-facts-col')).toHaveCount(0);
  });

  test('Add menu on a page W1 renders no dock for: its page panels are inert, not counted as open', async () => {
    const { page } = session!;
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Timeline"]').click();
    await expect(page.locator('.shell-timeline')).toBeVisible({ timeout: 5_000 });

    await sidebar(page).getByTestId('grs-add-panel-btn').click();
    const pageSection = page.getByTestId('grs-add-panel-section-page');
    await expect(pageSection).toBeVisible();
    await expect(pageSection).not.toContainText("This page's panels are already open.");
    for (const id of ['navTimeline', 'tlDetails']) {
      const row = pageSection.getByTestId(`grs-add-panel-item-${id}`);
      await expect(row).toBeDisabled();
      await expect(row).toHaveAttribute('data-scope', 'page:timeline');
    }
    await expect(pageSection).toContainText('This page cannot open this panel yet.');
    await page.keyboard.press('Escape');
  });
});

test.describe('W1 widget shell ON + AI Off — AI global panels are hidden or inert', () => {
  test.describe.configure({ mode: 'serial' });
  let session: ShellSession | undefined;
  test.beforeAll(async () => { session = await openShell({ widgetShell: true, aiEnabled: false }); });
  test.afterAll(async () => { await closeShell(session); });

  test('agent, findings, activity and inbox follow the AI Off rule', async () => {
    const { page } = session!;
    // agent: the partner tab is gone from the global sidebar, and the page tabs never fall back into it.
    await expect(sidebar(page).getByTestId('ahp-tab-partner')).toHaveCount(0);
    await expect(sidebar(page).getByTestId('ahp-tab-suggestions')).toHaveCount(0);
    await expect(sidebar(page).getByTestId('ahp-tab-scenes')).toHaveCount(0);
    await expect(sidebar(page).getByTestId('ahp-tab-notes-analysis')).toHaveCount(0);

    await sidebar(page).getByTestId('grs-add-panel-btn').click();
    // findings: listed but inert, with the reason, and cannot be added.
    const findings = page.getByTestId('grs-add-panel-item-findings');
    await expect(findings).toBeDisabled();
    await expect(page.getByTestId('grs-add-panel-popover')).toContainText('Turn AI on in Settings to add this panel.');
    // agent / activity / inbox: not offered at all.
    await expect(page.getByTestId('grs-add-panel-item-agent')).toHaveCount(0);
    await expect(page.getByTestId('grs-add-panel-item-activity')).toHaveCount(0);
    await expect(page.getByTestId('grs-add-panel-item-inbox')).toHaveCount(0);
    await findings.click({ force: true }).catch(() => {});
    await expect(page.getByTestId('global-panel-findings')).toHaveCount(0);

    // The page-only inspector still works with AI off.
    await page.keyboard.press('Escape');
    await expect(editorInspector(page).getByRole('tab')).toHaveText(['Scenes', 'Notes & Analysis']);
  });
});

test.describe('W1 widget shell OFF — the old shell, unchanged', () => {
  test.describe.configure({ mode: 'serial' });
  let session: ShellSession | undefined;
  test.beforeAll(async () => { session = await openShell({ widgetShell: false, aiEnabled: true }); });
  test.afterAll(async () => { await closeShell(session); });

  test('no page dock, no scoped Add menu, and the four-tab right panel', async () => {
    const { page } = session!;
    await expect(page.locator('.story-navigator')).toBeVisible();
    await expect(page.getByTestId('page-panel-edPanel')).toHaveCount(0);
    await expect(page.locator('[data-panel-id]')).toHaveCount(0);
    await expect(page.getByTestId('grs-add-panel-btn')).toHaveCount(0);
    await expect(page.getByTestId('grs-extra-panels')).toHaveCount(0);
    for (const tab of ['partner', 'suggestions', 'scenes', 'notes-analysis']) {
      await expect(sidebar(page).getByTestId(`ahp-tab-${tab}`)).toBeVisible();
    }
  });

  test('Brainstorm keeps its chat face and claims the sidebar as before', async () => {
    const { page } = session!;
    await page.locator('[data-testid="nav-rail-brainstorm"]').click();
    await expect(page.locator('#app-tabpanel-brainstorm')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('bsc-mode-chat').first()).toBeAttached();
    await expect(sidebar(page).locator('.brainstorm-facts-col')).toHaveCount(1);
  });
});
