/**
 * Pure helpers for the e2e orphan guard (#1915). Keeps detection logic testable.
 */

const NPM_E2E_RUN = /\bnpm run (test:e2e:[\w-]+)/g;

export function findOrphans(
  allSpecs: readonly string[],
  wired: ReadonlySet<string>,
  allowList: Readonly<Record<string, string>>,
): string[] {
  const orphans: string[] = [];
  for (const spec of allSpecs) {
    if (allowList[spec]) continue;
    if (wired.has(spec)) continue;
    orphans.push(spec);
  }
  return orphans;
}

/** Ignore commented YAML lines so disabled steps do not count as wired. */
export function activeCiE2eScriptNames(ciYaml: string): string[] {
  const names = new Set<string>();
  for (const line of ciYaml.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) continue;
    if (!line.includes('npm run test:e2e:')) continue;
    if (!line.includes('xvfb-run') && !/^\s+run:\s+/.test(line)) continue;
    for (const match of line.matchAll(NPM_E2E_RUN)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

export function normalizeSpecPath(raw: string): string {
  let p = raw.replace(/\\/g, '/').trim();
  if (p.startsWith('./')) p = p.slice(2);
  if (!p.startsWith('e2e/')) {
    if (p.startsWith('tests/')) p = `e2e/${p}`;
    else if (!p.includes('/')) p = `e2e/${p}`;
  }
  return p;
}

export function extractPlaywrightSpecs(command: string): string[] {
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

export function resolveScriptSpecs(
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

export function wiredSpecsFromCi(
  ciYaml: string,
  scripts: Record<string, string>,
): Set<string> {
  const scriptNames = activeCiE2eScriptNames(ciYaml);
  const specs = new Set<string>();
  for (const name of scriptNames) {
    for (const spec of resolveScriptSpecs(name, scripts, new Set())) {
      specs.add(spec);
    }
  }
  return specs;
}