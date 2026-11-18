/**
 * local-model-picker.spec.ts — SKY-1502 / SKY-1459
 *
 * E2E coverage for the Local Model Picker v0 acceptance criteria:
 * - AC-1: per-agent picker render
 * - AC-2: Ollama model list dropdown (mocked IPC)
 * - AC-3: Ollama-not-running hint (mocked IPC failure)
 * - AC-4: Custom OpenAI-compatible model listing (mocked IPC)
 * - AC-8: fresh install defaults
 * - AC-9: upgrade preserves existing model settings
 * - AC-10: per-agent test-connection independence (mocked IPC)
 */
/*
 * Removed TC-LMP-01..07 (2026-11): classic per-agent Settings cards unmounted (Slice C).
 * Model & keys + Writing partner replaced per-agent picker E2E.
 */

// Slice C Soft-FAIL: four classic per-agent Settings cards unmounted — suite skipped.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
  type Locator,
} from '@playwright/test';

const MAIN_JS = path.resolve(__dirname, '../../out/main/main.js');

type ProviderListResponse = { ok: true; models: string[] } | { ok: false; error: string };
type ProviderResponses = Record<string, ProviderListResponse>;

type AgentSettings = {
  enabled: boolean;
  model: string;
  scanIntervalSeconds?: number;
  continuityCheckIntervalSeconds?: number;
  autoApply: boolean;
  confidenceThreshold: number;
  maxTokensPerHour: number;
  maxSuggestionsPerHour: number;
  heartbeatIntervalMinutes: number;
  maxTokensPerDay: number;
  provider?: {
    kind: string;
    apiKey?: string;
    baseUrl?: string;
    model: string;
  };
};

type AppSettingsSeed = {
  apiKey: string;
  onboardingComplete: boolean;
  provider?: {
    kind: string;
    apiKey?: string;
    baseUrl?: string;
    model: string;
  };
  agents: {
    writingAssistant: AgentSettings;
    brainstorm: AgentSettings;
    archive: AgentSettings;
    betaReader: AgentSettings;
  };
  theme: string;
  snapshots: { maxPerScene: number; maxAgeDays: number };
};

const budgets = {
  autoApply: false,
  confidenceThreshold: 0.85,
  maxTokensPerHour: 100_000,
  maxSuggestionsPerHour: 50,
  heartbeatIntervalMinutes: 5,
  maxTokensPerDay: 500_000,
};

function baseSettings(): AppSettingsSeed {
  return {
    apiKey: '',
    onboardingComplete: true,
    agents: {
      writingAssistant: {
        enabled: true,
        model: 'claude-sonnet-4-6',
        scanIntervalSeconds: 30,
        ...budgets,
      },
      brainstorm: {
        enabled: true,
        model: 'claude-sonnet-4-6',
        ...budgets,
      },
      archive: {
        enabled: true,
        model: 'claude-sonnet-4-6',
        continuityCheckIntervalSeconds: 60,
        ...budgets,
      },
      // S2-6: Archivist card is gone; Beta Reader is the third settings card.
      // Seed the same explicit Anthropic model the other agents use so AC-8
      // asserts the bound <select> value (not SETTINGS_DEFAULTS model:'').
      betaReader: {
        enabled: true,
        model: 'claude-sonnet-4-6',
        ...budgets,
      },
    },
    theme: 'dark',
    snapshots: { maxPerScene: 100, maxAgeDays: 30 },
  };
}

function seedUserData(
  userData: string,
  storyVault: string,
  notesVault: string,
  settings: AppSettingsSeed = baseSettings(),
): void {
  fs.writeFileSync(path.join(userData, 'app-settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({ vaultRoot: storyVault, notesVaultRoot: notesVault }, null, 2),
  );
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  const extraArgs = process.platform !== 'darwin' && !process.env.DISPLAY ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', ...extraArgs],
    timeout: 60_000,
  });
}

async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  const proc = app.process();
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  try {
    if (proc && !proc.killed) proc.kill('SIGKILL');
  } catch {
    // Already exited.
  }
}

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  page.on('dialog', (dialog) => { void dialog.accept().catch(() => undefined); });
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible({ timeout: 15_000 });
  return page;
}

// SKY-8260: must run AFTER firstWindow() resolves, not right after launch().
// Called too early, this races the main process's own boot-time
// setupIpcMain() loop; if the mock's ipcMain.handle() wins, main's later
// handle() call for the same channel throws (Electron disallows a second
// handler without an intervening removeHandler), which aborts the rest of
// that registration loop and leaves the shell unable to mount past first
// paint. Once firstWindow() has resolved, boot's own registration has
// already completed, so removeHandler()+handle() here cleanly overrides it.
async function installProviderMocks(app: ElectronApplication, responses: ProviderResponses = {}): Promise<void> {
  await app.evaluate(async ({ ipcMain }, providerResponses: ProviderResponses) => {
    ipcMain.removeHandler('provider:listModels');
    ipcMain.handle('provider:listModels', async (_event, payload: { kind?: string }) => {
      const kind = String(payload?.kind ?? '');
      return providerResponses[kind] ?? { ok: true, models: [] };
    });

    ipcMain.removeHandler('settings:testConnection');
    ipcMain.handle('settings:testConnection', async (_event, payload: { provider?: { kind?: string } }) => {
      const kind = payload?.provider?.kind;
      if (kind === 'ollama') return { ok: false, latencyMs: 9, error: 'Mock Ollama connection failed' };
      return { ok: true, latencyMs: 12 };
    });
  }, responses);
}

async function openSettings(page: Page): Promise<void> {
  // SKY-3177: AppNavRail adds a second "Open settings" button; target the menu bar one.
  await page.locator('.app-menu-gear-btn').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible({ timeout: 10_000 });
  // SKY-10668: the panel now opens on Appearance — go to the AI Agents page.
  await page.locator('[data-testid="settings-cat-agents"]').click();
  await expect(page.getByRole('heading', { name: 'PROVIDER BUCKETS' })).toBeVisible();
}

function agentCard(page: Page, name: 'Writing Coach' | 'Brainstorm Agent' | 'Beta Reader'): Locator {
  return page.locator('.settings-agent-card').filter({ hasText: name });
}

async function enableAgentOverride(card: Locator, agentName: string): Promise<void> {
  const toggle = card.getByLabel(`Enable ${agentName} provider override`);
  // The actual checkbox is visually hidden behind the custom toggle track, so
  // dispatch the same change event React receives from a real toggle click.
  await toggle.evaluate((input: HTMLInputElement) => input.click());
  await expect(toggle).toBeChecked();
}

let userData: string;
let storyVault: string;
let notesVault: string;
let app: ElectronApplication | undefined;
let page: Page;

test.beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-lmp-ud-'));
  storyVault = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-lmp-story-'));
  notesVault = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-lmp-notes-'));
});

test.afterEach(async () => {
  await closeApp(app);
  app = undefined;
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(storyVault, { recursive: true, force: true });
  fs.rmSync(notesVault, { recursive: true, force: true });
});

test('TC-LMP-retired: classic per-agent picker specs removed (AgentsSection unmounted, Slice C)', () => {
  // Supersedes TC-LMP-01..07 — see Writing partner + Model & keys specs.
  expect(true).toBe(true);
});







