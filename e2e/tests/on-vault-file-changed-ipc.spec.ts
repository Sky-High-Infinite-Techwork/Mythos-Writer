/**
 * onVaultFileChanged — built-app proof path (out/main/main.js).
 * External story-vault .md edit must deliver `vault:file-changed` payload to the renderer
 * (single `data` argument, not ipc event).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createStoryFromNavAdd } from '../helpers/newStoryModal';

const MAIN_JS = path.resolve(__dirname, '../../out/main/main.js');

function seedUserData(userData: string, vaultDir: string, notesVaultDir: string): void {
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
  const extraArgs = process.platform !== 'darwin' && !process.env.DISPLAY ? ['--headless'] : [];
  return electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--no-sandbox', ...extraArgs],
    timeout: 60_000,
  });
}

async function wireVaultFileChangedTap(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __vaultFileChangedEvents?: { path: string }[] };
    w.__vaultFileChangedEvents = [];
    window.api.onVaultFileChanged((data) => {
      w.__vaultFileChangedEvents!.push(data);
    });
  });
}

test('vault:file-changed reaches renderer after external story-vault .md edit', async () => {
  test.setTimeout(120_000);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-vfc-'));
  const userData = path.join(tempRoot, 'userData');
  const vaultDir = path.join(tempRoot, 'story-vault');
  const notesDir = path.join(tempRoot, 'notes-vault');
  for (const d of [userData, vaultDir, notesDir]) fs.mkdirSync(d, { recursive: true });
  seedUserData(userData, vaultDir, notesDir);

  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.app-menu-bar')).toBeVisible({ timeout: 12_000 });
    await createStoryFromNavAdd(page);

    await wireVaultFileChangedTap(page);
    await page.evaluate(async () => {
      await window.api.startVaultWatch();
    });

    const sceneFiles: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.md')) sceneFiles.push(full);
      }
    };
    walk(vaultDir);
    expect(sceneFiles.length).toBeGreaterThan(0);
    const target = sceneFiles[0]!;
    fs.appendFileSync(target, '\n\nExternal vault watcher probe.\n');

    await expect
      .poll(
        async () =>
          page.evaluate(() => (window as unknown as { __vaultFileChangedEvents?: unknown[] }).__vaultFileChangedEvents?.length ?? 0),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    const last = await page.evaluate(() => {
      const events = (window as unknown as { __vaultFileChangedEvents?: { path: string }[] }).__vaultFileChangedEvents ?? [];
      return events[events.length - 1];
    });
    expect(last).toBeDefined();
    expect(typeof last!.path).toBe('string');
    expect(last!.path.length).toBeGreaterThan(0);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});