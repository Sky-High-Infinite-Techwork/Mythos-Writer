// SKY-9022 — EPIC M6 sidebars, updated for Slice B partner shell:
//   - Left sidebar three zones unchanged
//   - Right tabs: <partner> · Suggestions · Scenes · Notes & Analysis
//   - Partner tab: card + hands (no AGENTS list); Getting Started card inside
//   - Sidebar dock: drag any panel tab between the left and right sidebars;
//     the placement is saved and survives a restart
import path from 'path';
import os from 'os';
import fs from 'fs';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
const MAIN_JS = path.resolve(__dirname, '../../out/main/main.js');

const STORY_ID = 'm6-e2e-story-0001';
const CHAPTER_ID = 'm6-e2e-chapter-0001';
const SCENE_ID = 'm6-e2e-scene-0001';
const STORY_TITLE = 'M6 Sidebar Story';

/**
 * Seeds a post-onboarding profile. rightSidebarVisible must be explicit:
 * the GRS only auto-opens via the real onboarding flow (main.ts sets it for
 * non-skip start modes), which these tests bypass with onboardingComplete.
 * Agents are seeded disabled so no scan ever attempts a network call.
 */
function seedUserData(userData: string, vaultDir: string, notesVaultDir: string, opts?: { seedStory?: boolean; omitRightSidebarVisible?: boolean }): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(notesVaultDir, { recursive: true });
  const agentDefaults = { model: 'claude-sonnet-4-6', autoApply: false, confidenceThreshold: 0.85, maxTokensPerHour: 100_000, maxSuggestionsPerHour: 50, heartbeatIntervalMinutes: 5, maxTokensPerDay: 500_000 };
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({
      onboardingComplete: true,
      theme: 'dark',
      ...(opts?.omitRightSidebarVisible ? {} : { rightSidebarVisible: true }),
      notesTabUpgradeToastShown: true,
      agents: {
        writingAssistant: { enabled: false, scanIntervalSeconds: 30, ...agentDefaults },
        brainstorm: { enabled: false, ...agentDefaults },
        archive: { enabled: false, continuityCheckIntervalSeconds: 60, ...agentDefaults },
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({ vaultRoot: vaultDir, notesVaultRoot: notesVaultDir }, null, 2),
  );
  if (opts?.seedStory) {
    const now = new Date().toISOString();
    const sceneDir = path.join(vaultDir, 'stories', STORY_ID, 'chapters', CHAPTER_ID, 'scenes');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(
      path.join(sceneDir, `${SCENE_ID}.md`),
      '---\ntitle: "The Gate"\n---\n\nShe crossed the threshold.\n',
      'utf8',
    );
    const manifest = {
      version: 1,
      stories: [{
        id: STORY_ID, title: STORY_TITLE, genre: 'Fantasy', path: `stories/${STORY_ID}`, order: 0,
        createdAt: now, updatedAt: now,
        chapters: [{
          id: CHAPTER_ID, title: 'Chapter One', storyId: STORY_ID, order: 0,
          createdAt: now, updatedAt: now,
          scenes: [{
            id: SCENE_ID, title: 'The Gate', path: `stories/${STORY_ID}/chapters/${CHAPTER_ID}/scenes/${SCENE_ID}.md`,
            chapterId: CHAPTER_ID, storyId: STORY_ID, order: 0,
            draftState: 'in-progress', createdAt: now, updatedAt: now, blocks: [],
          }],
        }],
      }],
    };
    fs.writeFileSync(path.join(vaultDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
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

test.describe('SKY-9022/M6 — left sidebar (three zones only)', () => {
  let tempRoot: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-m6-left-'));
    const userData = path.join(tempRoot, 'userData');
    seedUserData(userData, path.join(tempRoot, 'story-vault'), path.join(tempRoot, 'notes-vault'), { seedStory: true });
    app = await launchApp(userData);
    page = await firstWindow(app);
    await expect(page.locator('[data-testid="left-rail"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('.nav-story-title', { hasText: STORY_TITLE }).click();
    await expect(page.locator('[data-testid="lr-story-card"]')).toBeVisible({ timeout: 8_000 });
  });

  test.afterAll(async () => {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('renders exactly the three prototype zones', async () => {
    const rail = page.locator('[data-testid="left-rail"]');
    await expect(rail.locator('[data-testid="lr-story-card"]')).toBeVisible();
    await expect(rail.locator('[data-testid="lr-nav-zone"]')).toBeVisible();
    await expect(rail.locator('[data-testid="lr-project-footer"]')).toBeVisible();
    await expect(rail.locator('.lr-story-icon')).toBeVisible();
    await expect(rail.locator('.lr-story-title')).toBeVisible();
    await expect(rail.locator('.lr-story-meta')).toContainText(/·.*words/);
    await expect(rail.locator('.lr-progress-bar')).toBeVisible();
    await expect(rail.locator('.lr-nav-label')).toHaveText('STORY NAVIGATOR');
    await expect(rail.locator('.lr-nav-add')).toBeVisible();
    await expect(rail.locator('.lr-nav-collapse-btn')).toBeVisible();
    await expect(rail.locator('.nav-header')).toHaveCount(0);
    const sceneRow = rail.locator('.nav-scene-row').first();
    await expect(sceneRow.locator('.nav-scene-title')).toHaveText('Scene 1 · The Gate');
    await expect(sceneRow.locator('.nav-status-dot')).toBeVisible();
    await expect(rail.locator('.nav-draft-badge')).toHaveCount(0);
    await expect(rail.locator('.lr-footer-label')).toHaveText('PROJECT');
    const stats = rail.locator('.lr-stat-key');
    await expect(stats).toHaveText(['Words', 'Scenes', 'On Track']);
  });

  test('story-title click opens the first scene — Scene Analysis populates', async () => {
    const rail = page.locator('[data-testid="left-rail"]');
    await expect(rail.locator('.nav-scene-row.active .nav-scene-title')).toHaveText('Scene 1 · The Gate');
    // Slice B: Scene Analysis lives under Notes & Analysis.
    const hub = page.locator('[data-testid="agent-hub-panel"]');
    await hub.getByRole('tab', { name: 'Notes & Analysis' }).click();
    await expect(hub.locator('[data-testid="scene-analysis-rows"]')).toBeVisible({ timeout: 8_000 });
    await expect(hub.locator('.ahp-analysis-row-k', { hasText: 'Word Count' })).toBeVisible();
    await expect(hub.getByText('Open a scene to see analysis.')).toHaveCount(0);
  });

  test('no panel-system controls exist anywhere in the DOM', async () => {
    await expect(page.getByRole('button', { name: /^\+ Add Panel$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Add panel$/i })).toHaveCount(0);
    await expect(page.locator('[data-panel-id]')).toHaveCount(0);
    await expect(page.getByText('⧉', { exact: true })).toHaveCount(0);
    await expect(page.getByText('⊞', { exact: true })).toHaveCount(0);
    await expect(page.locator('[draggable="true"][class*="panel"]')).toHaveCount(0);
  });
});

test.describe('SKY-9022/M6 — right sidebar partner shell (Slice B)', () => {
  let tempRoot: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-m6-right-'));
    const userData = path.join(tempRoot, 'userData');
    seedUserData(userData, path.join(tempRoot, 'story-vault'), path.join(tempRoot, 'notes-vault'), { seedStory: true });
    app = await launchApp(userData);
    page = await firstWindow(app);
    await expect(page.locator('[data-testid="global-right-sidebar"]')).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('tab strip is Mythos · Suggestions · Scenes · Notes & Analysis', async () => {
    const grs = page.locator('[data-testid="global-right-sidebar"]');
    const tabs = grs.getByRole('tab');
    await expect(tabs).toHaveText(['Mythos', 'Suggestions', 'Scenes', 'Notes & Analysis']);
    await expect(grs.getByRole('tab', { name: 'Mythos' })).toHaveAttribute('aria-selected', 'true');
  });

  test('partner tab: card + action buttons; no AGENTS list / Suggestions hub card', async () => {
    const hub = page.locator('[data-testid="agent-hub-panel"]');
    await expect(hub.locator('[data-testid="ahp-partner-view"]')).toBeVisible({ timeout: 8_000 });
    await expect(hub.locator('[data-testid="partner-card"]')).toBeVisible();
    await expect(hub.locator('[data-testid="ahp-action-beta-read"]')).toBeVisible();
    await expect(hub.locator('[data-testid="ahp-action-continuity"]')).toBeVisible();
    await expect(hub.locator('[data-testid="ahp-action-notes-to-timeline"]')).toBeVisible();
    await expect(hub.locator('[data-testid="ahp-action-timeline-to-notes"]')).toBeVisible();
    await expect(hub.locator('[data-testid="ahp-hand-writer"]')).toHaveCount(0);
    await expect(hub.locator('[data-testid="ahp-hand-analyst"]')).toHaveCount(0);
    await expect(hub.locator('[data-testid="ahp-hand-archivist"]')).toHaveCount(0);
    await expect(hub.locator('section[aria-label="Agents"]')).toHaveCount(0);
    await expect(hub.locator('[data-testid="ahp-agent-row-writing-assistant"]')).toHaveCount(0);
  });

  test('Suggestions tab mounts the full review list', async () => {
    const hub = page.locator('[data-testid="agent-hub-panel"]');
    await hub.getByRole('tab', { name: 'Suggestions' }).click();
    await expect(hub.locator('[data-testid="ahp-suggestions-tab"]')).toBeVisible({ timeout: 8_000 });
    await expect(hub.locator('.suggestion-review')).toBeVisible({ timeout: 8_000 });
  });

  test('Notes & Analysis includes Scene Analysis + Questions-for-you', async () => {
    const hub = page.locator('[data-testid="agent-hub-panel"]');
    await hub.getByRole('tab', { name: 'Notes & Analysis' }).click();
    await expect(hub.locator('[data-testid="ahp-notes-analysis"]')).toBeVisible({ timeout: 8_000 });
    await expect(hub.locator('section[aria-label="Scene Analysis"]')).toBeVisible();
    await expect(hub.locator('[data-testid="questions-for-you"]')).toBeVisible();
  });

  test('exactly one Continuity header when Notes & Analysis is open', async () => {
    const grs = page.locator('[data-testid="global-right-sidebar"]');
    await grs.getByRole('tab', { name: 'Notes & Analysis' }).click();
    const headers = grs.locator('.pc-header-title', { hasText: 'Continuity' });
    await expect(headers).toHaveCount(1);
  });
});

test.describe('SKY-9022/M6 — fresh profile: tab strip + Getting Started card', () => {
  let tempRoot: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-m6-fresh-'));
    const userData = path.join(tempRoot, 'userData');
    seedUserData(userData, path.join(tempRoot, 'story-vault'), path.join(tempRoot, 'notes-vault'));
    app = await launchApp(userData);
    page = await firstWindow(app);
  });

  test.afterAll(async () => {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('tab strip is visible immediately; Getting Started panel deleted (F3#10)', async () => {
    const grs = page.locator('[data-testid="global-right-sidebar"]');
    await expect(grs).toBeVisible({ timeout: 15_000 });

    await expect(grs.getByRole('tab', { name: 'Mythos' })).toBeVisible({ timeout: 8_000 });
    await expect(grs.getByRole('tab', { name: 'Scenes' })).toBeVisible();

    const partner = grs.locator('[data-testid="ahp-partner-view"]');
    await expect(partner).toBeVisible({ timeout: 8_000 });
    await expect(partner.locator('[data-testid="gs-panel"]')).toHaveCount(0);
  });
});

test.describe('SKY-10499 — genuinely fresh profile (rightSidebarVisible unset)', () => {
  let tempRoot: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-sky10499-fresh-'));
    const userData = path.join(tempRoot, 'userData');
    seedUserData(
      userData,
      path.join(tempRoot, 'story-vault'),
      path.join(tempRoot, 'notes-vault'),
      { omitRightSidebarVisible: true },
    );
    app = await launchApp(userData);
    page = await firstWindow(app);
  });

  test.afterAll(async () => {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('tab strip renders, partner tabs are clickable, Getting Started never occupies the panel as gs-aside', async () => {
    const grs = page.locator('[data-testid="global-right-sidebar"]');
    await expect(grs).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('.gs-aside')).toHaveCount(0);
    await expect(page.locator('aside.gs-aside')).toHaveCount(0);

    const tabNames = ['Mythos', 'Suggestions', 'Scenes', 'Notes & Analysis'];
    for (const name of tabNames) {
      const tab = grs.getByRole('tab', { name });
      await expect(tab).toBeVisible({ timeout: 8_000 });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    }

    await grs.getByRole('tab', { name: 'Mythos' }).click();
    const partner = grs.locator('[data-testid="ahp-partner-view"]');
    await expect(partner).toBeVisible({ timeout: 8_000 });
    // F3#10: GettingStartedPanel deleted — never mount as gs-aside or gs-panel.
    await expect(partner.locator('[data-testid="gs-panel"]')).toHaveCount(0);
  });
});

// ─── Sidebar dock: drag any panel between either sidebar, and it persists ────
//
// Click-through a person can follow: open the story, drag the right sidebar's
// "Scenes" tab into the left sidebar, drag the left sidebar's "Story navigator"
// tab into the right sidebar, restart the app (same profile) and find both where
// they were dropped; then drag them back — including into the emptied left
// sidebar's drop column — and restart again to the default layout.
//
// Drags dispatch real DOM DragEvents (one shared DataTransfer, real element
// coordinates) at the app's own drag handlers — mouse-driven HTML5 drag is
// unreliable in headless Electron (see brainstorm-wave33 / folder-ops-sky7995).

const LEFT_TABS = 'Left sidebar panels';

/** Reads the profile's saved settings straight from disk. */
function savedSidebarDock(userData: string): unknown {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userData, 'app-settings.json'), 'utf8'));
    return raw?.activeLayout?.sidebarDock ?? null;
  } catch {
    return null;
  }
}

async function rightTabNames(page: Page): Promise<string[]> {
  return page.locator('[data-testid="global-right-sidebar"] .ahp-tabs [role="tab"]').allTextContents();
}

async function leftTabNames(page: Page): Promise<string[]> {
  const list = page.getByRole('tablist', { name: LEFT_TABS });
  if (await list.count() === 0) return [];
  return list.getByRole('tab').allTextContents();
}

/**
 * Drag `source` and drop it on the drop zone `zone()` resolves to, at the
 * point `at` picks inside the zone's box (default: its centre). The zone is
 * resolved only after dragstart, so a drop column that appears mid-drag works.
 */
async function dragPanel(
  page: Page,
  source: ReturnType<Page['locator']>,
  zone: () => ReturnType<Page['locator']>,
  at: (box: { x: number; y: number; width: number; height: number }) => { x: number; y: number } =
    (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }),
): Promise<void> {
  await expect(source).toBeVisible();
  const sb = (await source.boundingBox())!;
  // A handle, not the locator: after the drop the tab lives in the other
  // sidebar, and a locator would wait for it to come back before dragend.
  const handle = (await source.elementHandle())!;
  await handle.evaluate((el, p) => {
    const w = window as unknown as { __dockDt?: DataTransfer };
    w.__dockDt = new DataTransfer();
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: w.__dockDt, clientX: p.x, clientY: p.y }));
  }, { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 });
  const target = zone();
  await expect(target).toBeVisible({ timeout: 5_000 });
  const p = at((await target.boundingBox())!);
  await target.evaluate((el, pt) => {
    const dt = (window as unknown as { __dockDt: DataTransfer }).__dockDt;
    const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y };
    el.dispatchEvent(new DragEvent('dragenter', init));
    el.dispatchEvent(new DragEvent('dragover', init));
    el.dispatchEvent(new DragEvent('drop', init));
  }, p);
  await handle.evaluate((el) => {
    const dt = (window as unknown as { __dockDt?: DataTransfer }).__dockDt;
    // The browser fires dragend on the source; skip it if the tab re-mounted elsewhere.
    if (el.isConnected) el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  });
  await handle.dispose();
}

test.describe('Sidebar dock — drag any panel between the left and right sidebars; it persists', () => {
  let tempRoot: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  async function open(): Promise<void> {
    app = await launchApp(userData);
    page = await firstWindow(app);
    await expect(page.locator('[data-testid="global-right-sidebar"]')).toBeVisible({ timeout: 15_000 });
  }

  async function restart(): Promise<void> {
    await app.close().catch(() => undefined);
    await open();
  }

  test.beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-sidebar-dock-'));
    userData = path.join(tempRoot, 'userData');
    seedUserData(userData, path.join(tempRoot, 'story-vault'), path.join(tempRoot, 'notes-vault'), { seedStory: true });
    await open();
    await page.locator('.nav-story-title', { hasText: STORY_TITLE }).click();
    await expect(page.locator('[data-testid="lr-story-card"]')).toBeVisible({ timeout: 8_000 });
  });

  test.afterAll(async () => {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('starts in the default layout: navigator left, Agent Hub tabs right', async () => {
    expect(await leftTabNames(page)).toEqual(['Story navigator']);
    expect(await rightTabNames(page)).toEqual(['Mythos', 'Suggestions', 'Scenes', 'Notes & Analysis']);
    for (const tab of await page.locator('[data-dock-panel]').all()) {
      await expect(tab).toHaveAttribute('draggable', 'true');
    }
  });

  test('right → left: drag the Scenes tab into the left sidebar', async () => {
    const scenes = page.locator('[data-testid="global-right-sidebar"] [data-dock-panel="hub-scenes"]');
    const leftNav = page.getByRole('tablist', { name: LEFT_TABS }).getByRole('tab', { name: 'Story navigator' });
    // Drop on the left edge of "Story navigator" → Scenes lands before it.
    const nb = (await leftNav.boundingBox())!;
    await dragPanel(page, scenes, () => page.locator('[data-testid="sidebar-dock-left"]'),
      () => ({ x: nb.x + 4, y: nb.y + nb.height / 2 }));
    await expect.poll(() => leftTabNames(page)).toEqual(['Scenes', 'Story navigator']);
    await expect.poll(() => rightTabNames(page)).toEqual(['Mythos', 'Suggestions', 'Notes & Analysis']);
    // It shows in the left sidebar right away, with its real content.
    const left = page.locator('[data-testid="sidebar-dock-left"]');
    await expect(left.getByRole('tab', { name: 'Scenes' })).toHaveAttribute('aria-selected', 'true');
    await expect(left.getByRole('tabpanel')).toBeVisible();
    await expect(left.locator('[data-testid="left-rail"]')).toHaveCount(0);
  });

  test('left → right: drag the Story navigator tab into the right sidebar', async () => {
    const nav = page.getByRole('tablist', { name: LEFT_TABS }).getByRole('tab', { name: 'Story navigator' });
    // Drop on the right sidebar's body (below its tab row) → appended last.
    await dragPanel(page, nav, () => page.locator('[data-testid="global-right-sidebar"]'),
      (b) => ({ x: b.x + b.width / 2, y: b.y + b.height - 40 }));
    await expect.poll(() => rightTabNames(page))
      .toEqual(['Mythos', 'Suggestions', 'Notes & Analysis', 'Story navigator']);
    await expect.poll(() => leftTabNames(page)).toEqual(['Scenes']);
    const grs = page.locator('[data-testid="global-right-sidebar"]');
    await expect(grs.getByRole('tab', { name: 'Story navigator' })).toHaveAttribute('aria-selected', 'true');
    // The navigator works from its new home: the seeded scene is listed there.
    await expect(grs.locator('[data-testid="left-rail"] .nav-scene-title').first()).toHaveText('Scene 1 · The Gate');
    // …and it carries no dead "Collapse left sidebar" button.
    await expect(grs.getByRole('button', { name: 'Collapse left sidebar' })).toHaveCount(0);
  });

  test('both moves are saved and survive an app restart', async () => {
    await expect.poll(() => savedSidebarDock(userData)).toEqual({
      left: ['hub-scenes'],
      right: ['hub-partner', 'hub-suggestions', 'hub-notes-analysis', 'story-navigator'],
    });
    await restart();
    await expect.poll(() => leftTabNames(page), { timeout: 10_000 }).toEqual(['Scenes']);
    expect(await rightTabNames(page)).toEqual(['Mythos', 'Suggestions', 'Notes & Analysis', 'Story navigator']);
  });

  test('drag both back — through the emptied left sidebar’s drop column — and restart to the default', async () => {
    // Scenes back to the right, between Suggestions and Notes & Analysis.
    const scenes = page.getByRole('tablist', { name: LEFT_TABS }).getByRole('tab', { name: 'Scenes' });
    const na = page.locator('[data-testid="global-right-sidebar"] [data-dock-panel="hub-notes-analysis"]');
    const nb = (await na.boundingBox())!;
    await dragPanel(page, scenes, () => page.locator('[data-testid="global-right-sidebar"]'),
      () => ({ x: nb.x + 2, y: nb.y + nb.height / 2 }));
    await expect.poll(() => rightTabNames(page))
      .toEqual(['Mythos', 'Suggestions', 'Scenes', 'Notes & Analysis', 'Story navigator']);
    // The left dock is empty, so the left sidebar is gone…
    await expect(page.locator('[data-testid="sidebar-dock-left"]')).toHaveCount(0);

    // …until a drag starts: then its drop column appears and takes the navigator back.
    const nav = page.locator('[data-testid="global-right-sidebar"] [data-dock-panel="story-navigator"]');
    await dragPanel(page, nav, () => page.locator('[data-testid="sidebar-dock-left"]'));
    await expect.poll(() => leftTabNames(page)).toEqual(['Story navigator']);
    await expect.poll(() => rightTabNames(page)).toEqual(['Mythos', 'Suggestions', 'Scenes', 'Notes & Analysis']);
    await expect(page.locator('[data-testid="sidebar-dock-left"] [data-testid="left-rail"]')).toBeVisible();

    await expect.poll(() => savedSidebarDock(userData)).toEqual({
      left: ['story-navigator'],
      right: ['hub-partner', 'hub-suggestions', 'hub-scenes', 'hub-notes-analysis'],
    });
    await restart();
    await expect.poll(() => leftTabNames(page), { timeout: 10_000 }).toEqual(['Story navigator']);
    expect(await rightTabNames(page)).toEqual(['Mythos', 'Suggestions', 'Scenes', 'Notes & Analysis']);
  });
});
