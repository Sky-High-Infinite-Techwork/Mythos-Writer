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
  });

  it('clears scene save failures only after vault switch commits (applyProjectSwitched)', () => {
    const switchBlock = src.match(
      /const switchToVault = useCallback\(async \(vaultId: string\)[\s\S]*?\n {2}\}, \[activeVaultRoot/,
    )?.[0] ?? '';
    expect(switchBlock).not.toMatch(/setSceneSaveFailures\(new Map\(\)\)/);
    expect(src).toMatch(
      /const applyProjectSwitched = useCallback[\s\S]*?setSceneSaveFailures\(new Map\(\)\)/,
    );
  });

  it('runs snapshotSave even when vault write failed (outside save-indicator gating)', () => {
    expect(src).toMatch(
      /persistSceneMarkdown\(updatedScene\)\.then\(\(saved\) => \{[\s\S]*?window\.api\.snapshotSave/,
    );
    const applyBlock = src.match(
      /const applySceneBlocks = useCallback\([\s\S]*?\n {2}\}, \[updateManifest, persistSceneMarkdown/,
    )?.[0] ?? '';
    const scheduleSaved = applyBlock.match(/scheduleSaved:\s*\(\)\s*=>\s*\{([\s\S]*?)\n {8}\},/)?.[1] ?? '';
    expect(scheduleSaved).not.toMatch(/snapshotSave/);
  });
});