import { describe, expect, it } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  activeCiE2eScriptNames,
  extractPlaywrightSpecs,
  findOrphans,
  wiredSpecsFromCi,
} from './e2eOrphanGuard';
import { listE2eSpecFiles } from './e2eOrphansRuntime';

describe('e2eOrphanGuard', () => {
  it('findOrphans returns unwired specs not in allow-list', () => {
    const wired = new Set(['e2e/smoke-ui.spec.ts']);
    const all = ['e2e/smoke-ui.spec.ts', 'e2e/__synthetic-orphan-guard-fixture.spec.ts'];
    expect(findOrphans(all, wired, {})).toEqual(['e2e/__synthetic-orphan-guard-fixture.spec.ts']);
  });

  it('commented CI run steps do not wire npm e2e scripts', () => {
    const snippet = `
jobs:
  e2e:
    steps:
      # - name: retired
      #   run: xvfb-run --auto-servernum npm run test:e2e:retired-only
      - name: live
        run: xvfb-run --auto-servernum npm run test:e2e:smoke-ui
`;
    const names = activeCiE2eScriptNames(snippet);
    expect(names).toContain('test:e2e:smoke-ui');
    expect(names).not.toContain('test:e2e:retired-only');
  });

  it('inactive commented step leaves a spec orphaned when script only referenced there', () => {
    const ciYaml = `
      - name: live
        run: xvfb-run --auto-servernum npm run test:e2e:only-wired
    `;
    const scripts = {
      'test:e2e:only-wired': 'playwright test e2e/wired.spec.ts --reporter=list',
      'test:e2e:retired-only': 'playwright test e2e/orphan.spec.ts --reporter=list',
    };
    const wired = wiredSpecsFromCi(ciYaml, scripts);
    const orphans = findOrphans(['e2e/orphan.spec.ts', 'e2e/wired.spec.ts'], wired, {});
    expect(orphans).toEqual(['e2e/orphan.spec.ts']);
  });
  it('a mention outside a run step (name / echo text) does not wire a script', () => {
    const snippet = `
jobs:
  e2e:
    steps:
      - name: will run npm run test:e2e:named-only later
        run: echo done
      - name: live
        run: xvfb-run --auto-servernum npm run test:e2e:smoke-ui
`;
    const names = activeCiE2eScriptNames(snippet);
    expect(names).toEqual(['test:e2e:smoke-ui']);
  });

  it('an inline comment on a run line does not wire a script', () => {
    const snippet = `
    steps:
      - name: live
        run: xvfb-run --auto-servernum npm run test:e2e:smoke-ui # was: npm run test:e2e:retired
`;
    expect(activeCiE2eScriptNames(snippet)).toEqual(['test:e2e:smoke-ui']);
  });

  it('a disabled step (if: false) does not wire a script; a block-scalar run does', () => {
    const snippet = `
    steps:
      - name: parked
        if: false
        run: xvfb-run --auto-servernum npm run test:e2e:parked
      - name: parked expr
        if: \${{ false }}
        run: npm run test:e2e:parked-expr
      - name: block
        run: |
          # npm run test:e2e:commented-in-block
          xvfb-run --auto-servernum npm run test:e2e:block-live
`;
    expect(activeCiE2eScriptNames(snippet).sort()).toEqual(['test:e2e:block-live']);
  });

  it('option values are not spec selectors (an unscheduled spec stays orphaned)', () => {
    expect(extractPlaywrightSpecs('playwright test --grep e2e/orphan.spec.ts e2e/wired.spec.ts')).toEqual([
      'e2e/wired.spec.ts',
    ]);
    expect(extractPlaywrightSpecs('playwright test -g orphan.spec.ts --reporter=list')).toEqual([]);
    expect(extractPlaywrightSpecs('playwright test --project electron e2e/a.spec.ts')).toEqual(['e2e/a.spec.ts']);
  });

  it('listE2eSpecFiles finds nested specs (e2e/tests/**), not only the top level', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const found = listE2eSpecFiles(path.join(repoRoot, 'e2e'), repoRoot);
    expect(found.some((f) => f.startsWith('e2e/tests/') && f.endsWith('.spec.ts'))).toBe(true);
    expect(found.some((f) => !f.slice('e2e/'.length).includes('/'))).toBe(true);
  });
});