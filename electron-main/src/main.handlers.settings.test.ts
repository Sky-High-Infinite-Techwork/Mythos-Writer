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

  it('refuses invalid writing-assistant agent baseUrl without persisting', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    const priorUrl = before.agents.writingAssistant.provider?.baseUrl;
    const poisoned: AppSettings = {
      ...before,
      agents: {
        ...before.agents,
        writingAssistant: {
          ...before.agents.writingAssistant,
          provider: {
            kind: before.agents.writingAssistant.provider?.kind ?? 'openai',
            model: before.agents.writingAssistant.provider?.model ?? 'gpt-4o',
            apiKey: before.agents.writingAssistant.provider?.apiKey ?? '',
            baseUrl: 'http://169.254.169.254/latest/meta-data/wa',
          },
        },
      },
    };
    const result = await invoke<{ saved: boolean; error?: string }>(IPC_CHANNELS.SETTINGS_SET, {
      settings: poisoned,
    });
    expect(result.saved).toBe(false);
    expect(result.error).toMatch(/agents\.writingAssistant\.provider\.baseUrl/i);
    const disk = fs.readFileSync(settingsPath, 'utf-8');
    expect(disk).not.toContain('169.254.169.254');
    const after = JSON.parse(disk) as AppSettings;
    expect(after.agents.writingAssistant.provider?.baseUrl ?? priorUrl).toBe(priorUrl);
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

  it('settings:set regenerates telemetry sessionId when disabling telemetry', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    const armed: AppSettings = {
      ...before,
      telemetry: { enabled: true, sessionId: 'telemetry-session-1907-fixed' },
    };
    const armedResult = await invoke<{ saved: boolean }>(IPC_CHANNELS.SETTINGS_SET, { settings: armed });
    expect(armedResult.saved).toBe(true);
    const disabled: AppSettings = {
      ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings,
      telemetry: { enabled: false, sessionId: 'telemetry-session-1907-fixed' },
    };
    const result = await invoke<{ saved: boolean }>(IPC_CHANNELS.SETTINGS_SET, { settings: disabled });
    expect(result.saved).toBe(true);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    expect(after.telemetry?.enabled).toBe(false);
    expect(after.telemetry?.sessionId).not.toBe('telemetry-session-1907-fixed');
    expect(fs.readFileSync(settingsPath, 'utf-8')).toContain(after.telemetry?.sessionId ?? '');
  });

  it('settings:get returns masked settings without throwing', async () => {
    const got = await invoke<AppSettings & { legacyVaultDetected?: boolean }>(IPC_CHANNELS.SETTINGS_GET);
    expect(got.theme).toBeTruthy();
    expect(got.onboardingComplete).toBe(true);
  });
});