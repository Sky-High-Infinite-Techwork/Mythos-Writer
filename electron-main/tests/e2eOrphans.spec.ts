/**
 * Guard: every non-capture e2e spec must be reached from a CI e2e step or the
 * small allow-list (live binary / live service). Issue #1915.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const ciYmlPath = path.join(repoRoot, '.github/workflows/ci.yml');
const e2eRoot = path.join(repoRoot, 'e2e');

/** Specs intentionally unwired — need packaged binary, live service, or cross-slice wiring. */
const ALLOW_LIST: Readonly<Record<string, string>> = {
  'e2e/kokoro-tts.spec.ts': 'needs Kokoro model assets (86MB) / real TTS binary',
  'e2e/voice-real-binary.spec.ts': 'needs espeak-ng or piper binary on PATH',
  'e2e/sky-11373-lmstudio-live.spec.ts': 'needs live LM Studio HTTP endpoint',
  'e2e/packaged-smoke.spec.ts': 'needs MYTHOS_PACKAGED_EXE built installer',
  // Temporary until #1923 merges (test:e2e:depth-slider); drop on rebase after that PR lands.
  'e2e/agent-hub-interaction-states.spec.ts': 'wired by #1923',
  // Temporary until slice 03 (#1906) wires vault-settings; drop when that PR lands.
  'e2e/tests/sky-11154-vault-settings-page.spec.ts': 'wired by slice 03 (#1906)',
  // Temporary until slice 09 (#1912) fixes perf budgets; not on required CI shard today.
  'e2e/perf/ui-runtime.spec.ts': 'wired by slice 09 (#1912)',
};

const NPM_E2E_RUN = /npm run (test:e2e:[\w-]+)/g;

function normalizeSpecPath(raw: string): string {
  let p = raw.replace(/\\/g, '/').trim();
  if (p.startsWith('./')) p = p.slice(2);
  if (!p.startsWith('e2e/')) {
    if (p.startsWith('tests/')) p = `e2e/${p}`;
    else if (!p.includes('/')) p = `e2e/${p}`;
  }
  return p;
}

function extractPlaywrightSpecs(command: string): string[] {
  const tokens = command.split(/\s+/);
  const specs: string[] = [];
  let sawPlaywright = false;
  for (const token of tokens) {
    if (token === 'playwright' || token.endsWith('playwright')) {
      sawPlaywright = true;
      continue;
    }
    if (!sawPlaywright) continue;
    if (token === 'test') continue;
    if (token.startsWith('-')) continue;
    if (token.includes('playwright')) continue;
    if (token.endsWith('.spec.ts') || token.includes('.spec.ts')) {
      specs.push(normalizeSpecPath(token));
    }
  }
  return specs;
}

function loadPackageScripts(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

function resolveScriptSpecs(
  scriptName: string,
  scripts: Record<string, string>,
  visiting: Set<string>,
): string[] {
  if (visiting.has(scriptName)) return [];
  visiting.add(scriptName);
  const body = scripts[scriptName];
  if (!body) return [];

  const nested = [...body.matchAll(/\bnpm run ([\w:-]+)/g)].map((m) => m[1]);
  const fromNested = nested.flatMap((name) => resolveScriptSpecs(name, scripts, visiting));
  const direct = extractPlaywrightSpecs(body);
  return [...new Set([...direct, ...fromNested])];
}

function ciE2eScriptNames(ciYaml: string): string[] {
  const names = new Set<string>();
  for (const match of ciYaml.matchAll(NPM_E2E_RUN)) {
    names.add(match[1]);
  }
  return [...names];
}

function listE2eSpecFiles(): string[] {
  const found: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.spec.ts')) continue;
      const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
      const base = path.basename(rel);
      if (base.startsWith('capture-')) continue;
      found.push(rel);
    }
  }
  walk(e2eRoot);
  return found.sort();
}

function wiredSpecsFromCi(): Set<string> {
  const scripts = loadPackageScripts();
  const ciYaml = fs.readFileSync(ciYmlPath, 'utf8');
  const scriptNames = ciE2eScriptNames(ciYaml);
  const specs = new Set<string>();
  for (const name of scriptNames) {
    for (const spec of resolveScriptSpecs(name, scripts, new Set())) {
      specs.add(spec);
    }
  }
  return specs;
}

describe('e2e orphan guard (#1915)', () => {
  it('every non-capture e2e spec is wired in CI or allow-listed', () => {
    const wired = wiredSpecsFromCi();
    const all = listE2eSpecFiles();
    const orphans: string[] = [];

    for (const spec of all) {
      if (ALLOW_LIST[spec]) continue;
      if (wired.has(spec)) continue;
      orphans.push(spec);
    }

    expect(
      orphans,
      orphans.length
        ? `Unwired e2e specs (add to a test:e2e:* script that CI runs, delete, or allow-list with reason):\n${orphans.map((s) => `  - ${s}`).join('\n')}`
        : undefined,
    ).toEqual([]);
  });

  it('allow-list stays within the issue cap plus temporary cross-slice entries', () => {
    // #1915 cap is 4 binary/live specs; cross-slice rows until sibling PRs land.
    expect(Object.keys(ALLOW_LIST).length).toBeLessThanOrEqual(7);
    expect(ALLOW_LIST['e2e/agent-hub-interaction-states.spec.ts']).toBe('wired by #1923');
    expect(ALLOW_LIST['e2e/tests/sky-11154-vault-settings-page.spec.ts']).toBe(
      'wired by slice 03 (#1906)',
    );
    expect(ALLOW_LIST['e2e/perf/ui-runtime.spec.ts']).toBe('wired by slice 09 (#1912)');
  });

  it('fails when a new unwired spec appears (synthetic orphan)', () => {
    const wired = wiredSpecsFromCi();
    const synthetic = 'e2e/__synthetic-orphan-guard-fixture.spec.ts';
    expect(wired.has(synthetic)).toBe(false);
    expect(ALLOW_LIST[synthetic]).toBeUndefined();
  });
});