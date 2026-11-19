/**
 * agent-hub-interaction-states.spec.ts — SKY-8436 / #1909
 *
 * Real-Electron E2E for the Agent Hub empty/loading/error triad and keyboard
 * focus return. Partner chat uses the live agent:brainstorm handler and a
 * loopback OpenAI-compatible provider (no ipcMain.removeHandler).
 *
 *   npx playwright test e2e/agent-hub-interaction-states.spec.ts --reporter=list
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
import { clickStoryNav } from './helpers/navGuard';
import {
  customProviderSeed,
  startFakeAiProvider,
  type FakeAiProvider,
} from './helpers/fakeAiProvider';

const MAIN_JS = path.resolve(__dirname, '../out/main/main.js');

const STORY_ID = 'ahp-e2e-story-0001';
const CHAPTER_ID = 'ahp-e2e-chapter-0001';
const SCENE_ID = 'ahp-e2e-scene-0001';
const SCENE_TITLE = 'Lighthouse Scene';

function buildAppSettings(fake: FakeAiProvider): object {
  return {
    onboardingComplete: true,
    ai: { enabled: true },
    theme: 'dark',
    rightSidebarVisible: true,
    rightSidebarWidth: 420,
    notesTabUpgradeToastShown: true,
    provider: customProviderSeed(fake.port),
    agents: {
      writingAssistant: {
        enabled: true,
        model: 'e2e-fake-model',
        scanIntervalSeconds: 60,
        autoApply: false,
        confidenceThreshold: 0.85,
        maxTokensPerHour: 100_000,
        maxSuggestionsPerHour: 50,
        heartbeatIntervalMinutes: 5,
        maxTokensPerDay: 500_000,
        waScanInterval: 'manual',
      },
      brainstorm: {
        enabled: true,
        model: 'e2e-fake-model',
        autoApply: false,
        confidenceThreshold: 0.85,
        maxTokensPerHour: 100_000,
        maxSuggestionsPerHour: 50,
        heartbeatIntervalMinutes: 5,
        maxTokensPerDay: 500_000,
      },
      archive: {
        enabled: false,
        model: 'claude-sonnet-4-6',
        continuityCheckIntervalSeconds: 60,
        autoApply: false,
        confidenceThreshold: 0.85,
        maxTokensPerHour: 100_000,
        maxSuggestionsPerHour: 50,
        heartbeatIntervalMinutes: 5,
        maxTokensPerDay: 500_000,
      },
    },
  };
}

function seedUserData(userData: string, vaultDir: string, fake: FakeAiProvider): void {
  const now = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    version: '2.0.0',
    vaultRoot: vaultDir,
    stories: [
      {
        id: STORY_ID,
        title: 'Agent Hub E2E Story',
        path: `stories/${STORY_ID}`,
        chapters: [
          {
            id: CHAPTER_ID,
            title: 'Chapter One',
            path: `stories/${STORY_ID}/chapters/${CHAPTER_ID}`,
            order: 0,
            scenes: [
              {
                id: SCENE_ID,
                title: SCENE_TITLE,
                path: `stories/${STORY_ID}/chapters/${CHAPTER_ID}/scenes/${SCENE_ID}.md`,
                order: 0,
                chapterId: CHAPTER_ID,
                storyId: STORY_ID,
                updatedAt: now,
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    entities: [],
    suggestions: [],
    scenes: [],
    chapters: [],
  };

  const sceneDir = path.join(vaultDir, `stories/${STORY_ID}/chapters/${CHAPTER_ID}/scenes`);
  fs.mkdirSync(sceneDir, { recursive: true });
  fs.writeFileSync(
    path.join(sceneDir, `${SCENE_ID}.md`),
    ['---', `id: ${SCENE_ID}`, 'title: "Lighthouse Scene"', `updatedAt: ${now}`, '---', '', 'The lighthouse beam swept the bay.', ''].join('\n'),
  );
  fs.writeFileSync(path.join(vaultDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(userData, 'app-settings.json'), JSON.stringify(buildAppSettings(fake), null, 2));
  fs.writeFileSync(path.join(userData, 'vault-settings.json'), JSON.stringify({ vaultRoot: vaultDir }, null, 2));
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  const extraArgs = process.platform !== 'darwin' && !process.env.DISPLAY ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', ...extraArgs],
    timeout: 60_000,
  });
}

async function openScene(page: Page, sceneTitle: string): Promise<void> {
  await clickStoryNav(page);
  await page.locator('[data-testid="story-subview-editor"]').click();
  await expect(page.locator('.nav-story-row').first()).toBeVisible({ timeout: 20_000 });
  const sceneRow = page.locator('.nav-scene-row', { hasText: sceneTitle });
  await expect(sceneRow).toBeVisible({ timeout: 8_000 });
  await sceneRow.click();
}

async function openAgentsHub(page: Page): Promise<void> {
  if (await page.locator('.wa-overlay-backdrop').isVisible({ timeout: 1_000 }).catch(() => false)) {
    await page.keyboard.press('Escape');
  }
  const closeWriter = page.locator('[data-testid="ahp-close-writer"]');
  if (await closeWriter.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeWriter.click();
  }
  await expect(page.locator('[data-testid="global-right-sidebar"]')).toBeVisible({ timeout: 8_000 });
}

async function openPartnerChat(page: Page): Promise<void> {
  await page.locator('[data-testid="ahp-tab-partner"]').click();
  await expect(page.getByTestId('ahp-partner-chat-input')).toBeVisible({ timeout: 8_000 });
}

let fake: FakeAiProvider;
let userData: string;
let vaultDir: string;
let app: ElectronApplication | undefined;
let page: Page;

test.beforeAll(async () => {
  fake = await startFakeAiProvider({ kind: 'stream', chunks: ['Coach reply.'] });
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-ahp-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-ahp-vault-'));
  seedUserData(userData, vaultDir, fake);
  app = await launchApp(userData);
  page = await app.firstWindow();
  page.on('dialog', (dialog) => void dialog.accept().catch(() => undefined));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await fake?.close().catch(() => undefined);
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

test.describe.configure({ mode: 'serial' });

test('empty state: Suggestions inbox shows zero-pending copy', async () => {
  await openScene(page, SCENE_TITLE);
  await openAgentsHub(page);
  await page.locator('[data-testid="ahp-tab-suggestions"]').click();
  await expect(page.locator('[data-testid="ahp-suggestions-tab"]')).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('.sr-empty')).toHaveText('Nothing waiting on you.', { timeout: 8_000 });
});

test('loading state: typing indicator shows until the provider stream resolves', async () => {
  fake.setMode({ kind: 'stream', chunks: ['Delayed coach reply.'], chunkDelayMs: 900 });
  await openAgentsHub(page);
  await openPartnerChat(page);

  const input = page.getByTestId('ahp-partner-chat-input');
  await input.fill('How can I raise the tension here?');
  await input.press('Enter');

  await expect(page.getByTestId('ahp-partner-typing')).toBeVisible({ timeout: 3_000 });
  await expect(page.locator('.trp-bubble--agent', { hasText: 'Delayed coach reply.' }))
    .toBeVisible({ timeout: 12_000 });
  await expect(page.getByTestId('ahp-partner-typing')).not.toBeAttached();
});

test('error state: failed provider response keeps the user message; resend recovers', async () => {
  fake.setMode({ kind: 'http', status: 500, body: 'upstream exploded' });
  await openScene(page, SCENE_TITLE);
  await openAgentsHub(page);
  await openPartnerChat(page);

  const prompt = `Give me feedback on the pacing ${Date.now()}`;
  const input = page.getByTestId('ahp-partner-chat-input');
  await input.fill(prompt);
  await input.press('Enter');

  await expect(page.getByTestId('ahp-partner-chat-error')).toBeVisible({ timeout: 12_000 });
  await expect(page.getByTestId('ahp-partner-chat-error')).toContainText(/network error/i);
  await expect(page.locator('.trp-bubble--user', { hasText: prompt })).toBeVisible();

  fake.setMode({ kind: 'stream', chunks: ['Coach reply after retry.'] });
  await page.getByTestId('ahp-partner-chat-retry').click();

  await expect(page.locator('.trp-bubble--agent', { hasText: 'Coach reply after retry.' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.trp-bubble--user', { hasText: prompt })).toHaveCount(1);
  await expect(page.getByTestId('ahp-partner-chat-error')).toHaveCount(0);
});

test('keyboard: Enter opens coach tips from the Open tips control; Close returns to partner chat', async () => {
  await openScene(page, SCENE_TITLE);
  await openAgentsHub(page);
  await openPartnerChat(page);

  const openTips = page.getByTestId('ahp-open-writer-tips');
  await expect(openTips).toBeVisible({ timeout: 8_000 });
  await openTips.focus();
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('ahp-writer-tips')).toBeVisible({ timeout: 8_000 });
  await page.getByTestId('ahp-close-writer').click();
  await expect(page.getByTestId('ahp-writer-tips')).toHaveCount(0);
  await expect(page.getByTestId('ahp-partner-chat-input')).toBeVisible();
  await expect(openTips).toBeFocused();
});

// `.wa-panel-root` previously had `display: contents` (AC-WA-20), which
// stripped an element's own box — the SAME element AC-WA-20's ResizeObserver
// measures for its 280px collapse check. Guards against a re-introduction of
// `display: contents` on that element.
test('regression guard: the Writing Coach mini-chat does not permanently collapse at a normal panel width', async () => {
  await openAgentsHub(page);
  await openPartnerChat(page);
  await page.getByTestId('ahp-open-writer-tips').click();
  await expect(page.getByTestId('ahp-writer-tips')).toBeVisible({ timeout: 8_000 });

  await expect(page.locator('.wa-collapsed-btn')).not.toBeVisible();
  await expect(page.locator('.wa-panel-root')).toBeVisible();
  const width = await page.locator('.wa-panel-root').evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(280);
});