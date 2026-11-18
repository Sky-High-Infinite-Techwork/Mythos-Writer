import './main.handlers.harnessSetup.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { harnessPaths } from './main.handlers.harnessSetup.js';
import {
  IPC_CHANNELS,
  cleanupTestTmp,
  invoke,
  seedMythosVaultBundle,
  teardownHandlerHarnessSuite,
} from './mainHandlersHarness.js';
import { SETTINGS_DEFAULTS } from './appSettingsLoad.js';
import type { AppSettings } from './ipc.js';

let bundle: ReturnType<typeof seedMythosVaultBundle>;

beforeEach(() => {
  bundle = seedMythosVaultBundle({ seedDemo: false });
  harnessPaths.userData = bundle.userData;
});

afterEach(() => {
  teardownHandlerHarnessSuite();
  cleanupTestTmp();
});

describe('main.handlers settings:set', () => {
  it('persists valid settings changes to app-settings.json', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    const next: AppSettings = {
      ...SETTINGS_DEFAULTS,
      ...before,
      theme: before.theme === 'dark' ? 'high-contrast' : 'dark',
      onboardingComplete: true,
    };
    const result = await invoke<{ saved: boolean }>(IPC_CHANNELS.SETTINGS_SET, { settings: next });
    expect(result.saved).toBe(true);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    expect(after.theme).toBe(next.theme);
  });

  it('refuses invalid provider baseUrl and does not persist the hostile URL', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    const priorUrl = before.provider?.baseUrl;
    const poisoned: AppSettings = {
      ...before,
      provider: {
        kind: 'openai',
        model: 'gpt-4o',
        apiKey: '',
        baseUrl: 'http://169.254.169.254/latest/meta-data/',
      },
    };
    const result = await invoke<{ saved: boolean; error?: string }>(IPC_CHANNELS.SETTINGS_SET, {
      settings: poisoned,
    });
    expect(result.saved).toBe(false);
    expect(result.error).toMatch(/provider\.baseUrl/i);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    expect(after.provider?.baseUrl).toBe(priorUrl);
    expect(after.provider?.baseUrl).not.toBe(poisoned.provider?.baseUrl);
  });

  it('settings:set syncs writing-assistant flat fields on valid save', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    const next: AppSettings = {
      ...before,
      agents: {
        ...before.agents,
        writingAssistant: {
          ...before.agents.writingAssistant,
          scanIntervalSeconds: (before.agents.writingAssistant.scanIntervalSeconds ?? 60) + 5,
        },
      },
    };
    const result = await invoke<{ saved: boolean }>(IPC_CHANNELS.SETTINGS_SET, { settings: next });
    expect(result.saved).toBe(true);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    expect(after.agents.writingAssistant.scanIntervalSeconds).toBe(
      next.agents.writingAssistant.scanIntervalSeconds,
    );
  });

  it('settings:get returns masked settings without throwing', async () => {
    const got = await invoke<AppSettings & { legacyVaultDetected?: boolean }>(IPC_CHANNELS.SETTINGS_GET);
    expect(got.theme).toBeTruthy();
    expect(got.onboardingComplete).toBe(true);
  });
});