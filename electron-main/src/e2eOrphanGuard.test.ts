import { describe, expect, it } from 'vitest';
import {
  activeCiE2eScriptNames,
  findOrphans,
  wiredSpecsFromCi,
} from './e2eOrphanGuard';

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
});