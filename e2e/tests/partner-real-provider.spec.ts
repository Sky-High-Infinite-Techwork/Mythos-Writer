/**
 * Issue #1909 — partner chat through the real agent:brainstorm handler and a
 * loopback OpenAI-compatible provider (no removeHandler / no handler mocks).
 *
 *   npx playwright test e2e/tests/partner-real-provider.spec.ts --reporter=list --workers=1
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
import { clickStoryNav } from '../helpers/navGuard';
import { openSettingsDialog, closeSettingsDialog } from '../helpers/aiOffSuite';
import {
  startFakeAiProvider,
  customProviderSeed,
  type FakeAiProvider,
} from '../helpers/fakeAiProvider';

const MAIN_JS = path.resolve(__dirname, '../../out/main/main.js');

const STORY_ID = 'prp-e2e-story';
const SCENE_TITLE = 'Harbor Scene';

function seedVault(vaultDir: string, notesDir: string): void {
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, '.notes-vault'), '');
  const now = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    version: '2.0.0',
    vaultRoot: vaultDir,
    stories: [{
      id: STORY_ID,
      title: 'Partner Real Provider Story',
      path: `stories/${STORY_ID}`,
      chapters: [{
        id: 'prp-ch',
        title: 'Chapter One',
        path: `stories/${STORY_ID}/chapters/prp-ch`,
        order: 0,
        scenes: [{
          id: 'prp-scene',
          title: SCENE_TITLE,
          path: `stories/${STORY_ID}/chapters/prp-ch/scenes/prp-scene.md`,
          order: 0,
          chapterId: 'prp-ch',
          storyId: STORY_ID,
          updatedAt: now,
        }],
        createdAt: now,
        updatedAt: now,
      }],
      createdAt: now,
      updatedAt: now,
    }],
    entities: [],
    suggestions: [],
    scenes: [],
    chapters: [],
  };
  const sceneDir = path.join(vaultDir, `stories/${STORY_ID}/chapters/prp-ch/scenes`);
  fs.mkdirSync(sceneDir, { recursive: true });
  fs.writeFileSync(
    path.join(sceneDir, 'prp-scene.md'),
    ['---', 'id: prp-scene', `title: "${SCENE_TITLE}"`, `updatedAt: ${now}`, '---', '', 'Salt air rolled in from the harbor.', ''].join('\n'),
  );
  fs.writeFileSync(path.join(vaultDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function writeSettings(userData: string, vaultDir: string, notesDir: string, fake: FakeAiProvider, aiEnabled: boolean): void {
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({
      onboardingComplete: true,
      theme: 'dark',
      rightSidebarVisible: true,
      rightSidebarWidth: 420,
      notesTabUpgradeToastShown: true,
      ai: { enabled: aiEnabled },
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
        archive: { enabled: false, model: 'e2e-fake-model', continuityCheckIntervalSeconds: 60 },
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({ vaultRoot: vaultDir, notesVaultRoot: notesDir }, null, 2),
  );
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  const extraArgs = process.platform !== 'darwin' && !process.env.DISPLAY ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', ...extraArgs],
    timeout: 60_000,
  });
}

async function openPartnerChat(page: Page): Promise<void> {
  await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 20_000 });
  await clickStoryNav(page);
  await page.locator('[data-testid="story-subview-editor"]').click();
  await expect(page.locator('.nav-story-row').first()).toBeVisible({ timeout: 20_000 });
  const sceneRow = page.locator('.nav-scene-row', { hasText: SCENE_TITLE });
  await expect(sceneRow).toBeVisible({ timeout: 15_000 });
  await sceneRow.click();
  await expect(page.locator('[data-testid="global-right-sidebar"]')).toBeVisible({ timeout: 8_000 });
  await page.locator('[data-testid="ahp-tab-partner"]').click();
  await expect(page.getByTestId('ahp-partner-chat-input')).toBeVisible({ timeout: 8_000 });
}

async function sendPartnerPrompt(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('ahp-partner-chat-input');
  await input.fill(text);
  await input.press('Enter');
}

function assertLoopbackOnly(fake: FakeAiProvider): void {
  for (const host of fake.requestHosts()) {
    expect(host).toMatch(/^127\.0\.0\.1:\d+$/);
  }
}

test.describe.configure({ mode: 'serial' });

let fake: FakeAiProvider;
let userData: string;
let vaultDir: string;
let notesDir: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fake = await startFakeAiProvider({ kind: 'stream', chunks: ['Hello'] });
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-prp-ud-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-prp-vault-'));
  notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-prp-notes-'));
  seedVault(vaultDir, notesDir);
  writeSettings(userData, vaultDir, notesDir, fake, true);
  app = await launchApp(userData);
  page = await app.firstWindow();
  page.on('dialog', (d) => void d.accept().catch(() => undefined));
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await fake?.close().catch(() => undefined);
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.rmSync(notesDir, { recursive: true, force: true });
});

test('streamed reply assembles provider chunks in order', async () => {
  await openPartnerChat(page);
  fake.setMode({ kind: 'stream', chunks: ['Alpha', 'Beta', 'Gamma'] });
  const hitsBefore = fake.hits();
  await sendPartnerPrompt(page, 'Order check');
  await expect(page.locator('.trp-bubble--agent', { hasText: 'AlphaBetaGamma' })).toBeVisible({ timeout: 15_000 });
  expect(fake.hits()).toBe(hitsBefore + 1);
  assertLoopbackOnly(fake);
});

test('401 bad key surfaces auth error and Settings entry', async () => {
  await openPartnerChat(page);
  fake.setMode({ kind: 'http', status: 401, body: '{"error":"invalid_api_key"}' });
  await sendPartnerPrompt(page, 'Bad key probe');
  const err = page.getByTestId('ahp-partner-chat-error');
  await expect(err).toBeVisible({ timeout: 12_000 });
  await expect(err).toContainText(/authentication error/i);
  await expect(err).toContainText(/settings/i);
  await openSettingsDialog(page);
  await page.locator('[data-testid="settings-cat-agents"]').click();
  await expect(page.locator('[data-testid="model-keys-page"]')).toBeVisible({ timeout: 8_000 });
  await closeSettingsDialog(page);
});

test('429 rate limit shows once without automatic retry loop', async () => {
  await openPartnerChat(page);
  fake.setMode({ kind: 'http', status: 429, body: '{"error":"rate_limited"}' });
  const before = fake.hits();
  await sendPartnerPrompt(page, 'Rate limit probe');
  await expect(page.getByTestId('ahp-partner-chat-error')).toContainText(/rate limit/i, { timeout: 12_000 });
  await page.waitForTimeout(2_000);
  expect(fake.hits()).toBe(before + 1);
});

test('500 error then manual retry succeeds', async ({}, testInfo) => {
  await openPartnerChat(page);
  fake.setMode({ kind: 'http', status: 500, body: 'internal error' });
  const prompt = 'Retry after five hundred';
  await sendPartnerPrompt(page, prompt);
  await expect(page.getByTestId('ahp-partner-chat-error')).toContainText(/network error/i, { timeout: 12_000 });
  await page.screenshot({ path: testInfo.outputPath('partner-500-retry.png'), fullPage: false });

  fake.setMode({ kind: 'stream', chunks: ['Recovered reply'] });
  await expect(page.getByTestId('ahp-partner-chat-retry')).toBeVisible({ timeout: 8_000 });
  await page.getByTestId('ahp-partner-chat-retry').click();
  await expect(page.locator('.trp-bubble--agent', { hasText: 'Recovered reply' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ahp-partner-chat-error')).toHaveCount(0);
});

test('mid-stream drop surfaces network error and keeps the user message', async () => {
  await openPartnerChat(page);
  fake.setMode({ kind: 'drop', chunks: ['Partial', ' token'], dropAfterChunks: 2, chunkDelayMs: 80 });
  const prompt = 'Drop mid stream';
  await sendPartnerPrompt(page, prompt);
  await expect(page.getByTestId('ahp-partner-chat-error')).toContainText(/network error|invalid request/i, { timeout: 15_000 });
  await expect(page.locator('.trp-bubble--user', { hasText: prompt })).toBeVisible();
  const agentPartial = page.locator('.trp-bubble--agent').filter({ hasText: /Partial|response incomplete/i });
  const errorBanner = page.getByTestId('ahp-partner-chat-error');
  await expect
    .poll(async () => (await agentPartial.count()) > 0 || (await errorBanner.textContent())?.includes('partial reply kept'))
    .toBeTruthy();
});

test('Cancel mid-stream closes the provider socket', async () => {
  await openPartnerChat(page);
  fake.setMode({
    kind: 'stream',
    chunks: Array.from({ length: 12 }, (_, i) => `tok${i}-`),
    chunkDelayMs: 350,
  });
  const input = page.getByTestId('ahp-partner-chat-input');
  await input.fill('Cancel me');
  await input.press('Enter');
  await expect(page.getByTestId('ahp-partner-typing')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('ahp-partner-chat-cancel').click();
  await expect(page.getByTestId('ahp-partner-typing')).toHaveCount(0, { timeout: 8_000 });
  await expect.poll(() => fake.sawAbortClose(), { timeout: 5_000 }).toBe(true);
  expect(fake.sentDone()).toBe(false);
});

test.describe('AI master off — isolated profile', () => {
  test('master AI off sends zero provider HTTP requests (real agentBrainstorm IPC)', async () => {
    const offFake = await startFakeAiProvider({ kind: 'stream', chunks: ['nope'] });
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-prp-off-'));
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-prp-off-v-'));
    const notes = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-prp-off-n-'));
    seedVault(vault, notes);
    writeSettings(ud, vault, notes, offFake, false);
    const offApp = await launchApp(ud);
    try {
      const pg = await offApp.firstWindow();
      await pg.waitForLoadState('domcontentloaded');
      await expect(pg.locator('.app-menu-bar')).toBeVisible({ timeout: 60_000 });
      await pg.waitForTimeout(1_500);
      const hitsBefore = offFake.hits();
      const result = await pg.evaluate(async () => {
        const response = await window.api.agentBrainstorm('silent probe', []);
        if (response && typeof response === 'object' && 'error' in response) {
          return { kind: 'error' as const, msg: String((response as { error: string }).error) };
        }
        return { kind: 'ok' as const, text: (response as { text?: string })?.text ?? '' };
      });
      expect(offFake.hits()).toBe(hitsBefore);
      expect(result.kind).toBe('error');
      for (const host of offFake.requestHosts()) {
        expect(host).toMatch(/^127\.0\.0\.1:\d+$/);
      }
    } finally {
      await offApp.close();
      await offFake.close();
      fs.rmSync(ud, { recursive: true, force: true });
      fs.rmSync(vault, { recursive: true, force: true });
      fs.rmSync(notes, { recursive: true, force: true });
    }
  });
});