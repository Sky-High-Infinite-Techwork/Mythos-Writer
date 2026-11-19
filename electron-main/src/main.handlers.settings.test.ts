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
import { MASK_PREFIX } from './settings-masking.js';

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

  it('settings:set syncs writing-assistant flat wa* fields on valid save', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    const next: AppSettings = {
      ...before,
      agents: {
        ...before.agents,
        writingAssistant: {
          ...before.agents.writingAssistant,
          enabled: !before.agents.writingAssistant.enabled,
          cadenceTrigger:
            before.agents.writingAssistant.cadenceTrigger === 'on_save' ? 'idle_heartbeat' : 'on_save',
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
    expect(after.waEnabled).toBe(next.agents.writingAssistant.enabled);
    expect(after.waCadenceTrigger).toBe(next.agents.writingAssistant.cadenceTrigger);
  });

  it('refuses malformed stt payload without enabling bad stt flags', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    const poisoned = {
      ...before,
      stt: { enabled: 'yes', provider: 'auto' },
    } as unknown as AppSettings;
    const result = await invoke<{ saved: boolean; error?: string }>(IPC_CHANNELS.SETTINGS_SET, {
      settings: poisoned,
    });
    expect(result.saved).toBe(false);
    expect(result.error).toBeTruthy();
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    expect(after.stt).toEqual(before.stt);
  });

  it('refuses invalid archive agent baseUrl without persisting hostile URL', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const diskBefore = fs.readFileSync(settingsPath, 'utf-8');
    const before = JSON.parse(diskBefore) as AppSettings;
    const poisoned: AppSettings = {
      ...before,
      agents: {
        ...before.agents,
        archive: {
          ...before.agents.archive,
          provider: {
            kind: before.agents.archive.provider?.kind ?? 'openai',
            model: before.agents.archive.provider?.model ?? 'gpt-4o',
            apiKey: before.agents.archive.provider?.apiKey ?? '',
            baseUrl: 'http://169.254.169.254/latest/meta-data/archive',
          },
        },
      },
    };
    const result = await invoke<{ saved: boolean; error?: string }>(IPC_CHANNELS.SETTINGS_SET, {
      settings: poisoned,
    });
    expect(result.saved).toBe(false);
    expect(result.error).toMatch(/agents\.archive\.provider\.baseUrl/i);
    expect(fs.readFileSync(settingsPath, 'utf-8')).not.toContain('169.254.169.254');
  });

  it('settings:set persists archive continuity scheduler toggles', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    const next: AppSettings = {
      ...before,
      archiveContinuityEnabled: !before.archiveContinuityEnabled,
      archiveScanInterval: (before.archiveScanInterval ?? 300) + 15,
      agents: {
        ...before.agents,
        archive: {
          ...before.agents.archive,
          enabled: !before.agents.archive.enabled,
        },
      },
    };
    const result = await invoke<{ saved: boolean }>(IPC_CHANNELS.SETTINGS_SET, { settings: next });
    expect(result.saved).toBe(true);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    expect(after.archiveContinuityEnabled).toBe(next.archiveContinuityEnabled);
    expect(after.archiveScanInterval).toBe(next.archiveScanInterval);
    expect(after.agents.archive.enabled).toBe(next.agents.archive.enabled);
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

  it('refuses invalid tts shape without persisting provider change', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    const poisoned = {
      ...before,
      tts: { enabled: true, provider: 'auto', localBinaryPath: 12345 },
    } as unknown as AppSettings;
    const result = await invoke<{ saved: boolean; error?: string }>(IPC_CHANNELS.SETTINGS_SET, {
      settings: poisoned,
    });
    expect(result.saved).toBe(false);
    expect(result.error).toBeTruthy();
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    expect(after.tts).toEqual(before.tts);
  });

  it('settings:get masks provider apiKey for renderer', async () => {
    const settingsPath = path.join(bundle.userData, 'app-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    const rawKey = 'sk-ant-rawkey-should-never-leak-1907';
    const priorProvider = before.provider ?? { kind: 'openai' as const, apiKey: '' };
    const armed: AppSettings = {
      ...before,
      provider: { ...priorProvider, apiKey: rawKey },
    };
    const saved = await invoke<{ saved: boolean }>(IPC_CHANNELS.SETTINGS_SET, { settings: armed });
    expect(saved.saved).toBe(true);
    const got = await invoke<AppSettings>(IPC_CHANNELS.SETTINGS_GET);
    expect(got.provider?.apiKey).toMatch(new RegExp(`^${MASK_PREFIX.replace(/\./g, '\\.')}`));
    expect(got.provider?.apiKey).not.toBe(rawKey);
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
    expect(onDisk.provider?.apiKey).toBe(rawKey);
  });
});