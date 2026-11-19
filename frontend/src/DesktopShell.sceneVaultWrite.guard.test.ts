import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #1904: scene file creation paths must not call writeVault directly — resolved
 * `{ error }` would be treated as success without the banner.
 */
describe('DesktopShell scene markdown writes (#1904)', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'DesktopShell.tsx'),
    'utf-8',
  );

  it('routes initial scene file writes through persistSceneMarkdown', () => {
    expect(src).not.toMatch(/writeVault\?\.\(\s*scene\.path\s*,\s*blocksToMarkdown\(scene\)\)/);
    expect(src).not.toMatch(
      /await\s+window\.api\?\.writeVault\?\.\(\s*scene\.path\s*,\s*blocksToMarkdown\(scene\)\)/,
    );
  });

  it('resolves storyId via resolveStoryIdForScene before interpreting writeVault outcome', () => {
    expect(src).toMatch(/resolveStoryIdForScene\(storiesRef\.current,\s*scene\)/);
    expect(src).not.toMatch(
      /if\s*\(\s*!storyId\s*\)\s*\{[\s\S]*?return false;[\s\S]*?\}\s*if\s*\(\s*!ok\s*\)/,
    );
    expect(src).toMatch(/clearSceneFailuresOnSuccess/);
    expect(src).toMatch(/status:\s*'stale'/);
  });

  it('clears scene save failures only after vault switch commits (applyProjectSwitched)', () => {
    const switchBlock = src.match(
      /const switchToVault = useCallback\(async \(vaultId: string\)[\s\S]*?return completeVaultSwitch\(vaultId, 'tile'\);\n {2}\}, \[/,
    );
    expect(switchBlock, 'switchToVault useCallback block').toBeTruthy();
    expect(switchBlock![0].length).toBeGreaterThan(80);
    expect(switchBlock![0]).not.toMatch(/setSceneSaveFailures\(new Map\(\)\)/);

    const applyBlock = src.match(
      /const applyProjectSwitched = useCallback\(\(vaultRoot: string\) => \{[\s\S]*?setSceneSaveFailures\(new Map\(\)\);[\s\S]*?\n {2}\}, \[/,
    );
    expect(applyBlock, 'applyProjectSwitched useCallback block').toBeTruthy();
    expect(applyBlock![0].length).toBeGreaterThan(80);
    expect(applyBlock![0]).toMatch(/setSceneSaveFailures\(new Map\(\)\)/);
  });

  it('binds deferred snapshot and indicator to vault context via applyAfterSceneVaultPersist', () => {
    const applyBlock = src.match(
      /const applySceneBlocks = useCallback\([\s\S]*?\n {2}\}, \[updateManifest, persistSceneMarkdown/,
    );
    expect(applyBlock, 'applySceneBlocks useCallback block').toBeTruthy();
    expect(applyBlock![0]).toMatch(/applyAfterSceneVaultPersist/);
    const scheduleSaved = applyBlock![0].match(/scheduleSaved:\s*\(\)\s*=>\s*\{([\s\S]*?)\n {10}\},/)?.[1];
    expect(scheduleSaved, 'scheduleSaved body inside applySceneBlocks').toBeTruthy();
    expect(scheduleSaved!.length).toBeGreaterThan(20);
    expect(scheduleSaved).not.toMatch(/snapshotSave/);
  });
});