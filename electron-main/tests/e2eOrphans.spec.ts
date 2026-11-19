/**
 * Guard: every non-capture e2e spec must be reached from a CI e2e step or the
 * small allow-list (live binary / live service). Issue #1915.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ALLOW_LIST,
  findOrphans,
  listE2eSpecFiles,
  wiredSpecsFromCi,
} from '../src/e2eOrphansRuntime';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const ciYmlPath = path.join(repoRoot, '.github/workflows/ci.yml');
const e2eRoot = path.join(repoRoot, 'e2e');

function loadPackageScripts(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe('e2e orphan guard (#1915)', () => {
  it('every non-capture e2e spec is wired in CI or allow-listed', () => {
    const ciYaml = fs.readFileSync(ciYmlPath, 'utf8');
    const wired = wiredSpecsFromCi(ciYaml, loadPackageScripts());
    const all = listE2eSpecFiles(e2eRoot, repoRoot);
    const orphans = findOrphans(all, wired, ALLOW_LIST);

    expect(
      orphans,
      orphans.length
        ? `Unwired e2e specs (add to a test:e2e:* script that CI runs, delete, or allow-list with reason):\n${orphans.map((s) => `  - ${s}`).join('\n')}`
        : undefined,
    ).toEqual([]);
  });

  it('allow-list stays within issue cap (4 live + cross-slice pins)', () => {
    expect(Object.keys(ALLOW_LIST).length).toBeLessThanOrEqual(7);
    expect(ALLOW_LIST['e2e/agent-hub-interaction-states.spec.ts']).toBe('wired by #1923');
  });

  it('synthetic unwired spec is caught by findOrphans', () => {
    const wired = wiredSpecsFromCi(
      fs.readFileSync(ciYmlPath, 'utf8'),
      loadPackageScripts(),
    );
    const synthetic = 'e2e/__synthetic-orphan-guard-fixture.spec.ts';
    const orphans = findOrphans([synthetic], wired, ALLOW_LIST);
    expect(orphans).toEqual([synthetic]);
  });
});