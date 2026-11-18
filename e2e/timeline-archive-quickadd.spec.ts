/**
 * timeline-archive-quickadd.spec.ts — SKY-8266 (retired S2-6)
 *
 * S2-6: Archive Timeline tab / quick-add UI removed (video wins on Archivist).
 * Former TC-AQ-* cases are retired; this spec only asserts the app still boots
 * with a seeded vault so the file stays wired in CI without skip debt.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

const MAIN_JS = path.resolve(__dirname, '../out/main/main.js');

function seedUserData(userData: string, vaultDir: string): void {
  const appSettings = {
    apiKey: '',
    onboardingComplete: true,
    agents: {
      writingAssistant: { enabled: false, model: 'claude-sonnet-4-6' },
      brainstorm: { enabled: false, model: 'claude-sonnet-4-6' },
      archive: { enabled: false, model: 'claude-sonnet-4-6' },
    },
    theme: 'dark',
    snapshots: { maxPerScene: 100, maxAgeDays: 30 },
  };
  fs.writeFileSync(path.join(userData, 'app-settings.json'), JSON.stringify(appSettings, null, 2));
  fs.writeFileSync(path.join(userData, 'vault-settings.json'), JSON.stringify({ vaultRoot: vaultDir }, null, 2));
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  const extraArgs = process.platform !== 'darwin' && !process.env.DISPLAY ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', ...extraArgs],
    timeout: 60_000,
  });
}

test('S2-6 retirement: app launches with seeded vault (Archive Timeline quick-add removed)', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-tl-aq-retired-'));
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-tl-aq-vault-'));
  seedUserData(userData, vaultDir);
  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});