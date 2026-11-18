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
});