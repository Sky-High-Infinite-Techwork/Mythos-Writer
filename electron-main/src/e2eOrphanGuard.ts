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

/** Drop a YAML / shell comment: `#` at the start or after whitespace (quotes are not tracked; CI lines here have none). */
function stripComment(line: string): string {
  const m = /(^|\s)#/.exec(line);
  return m ? line.slice(0, m.index) : line;
}

const STEP_START = /^(\s*)-\s+(.*)$/;
const RUN_KEY = /^(\s*)(?:-\s+)?run:\s*(.*)$/;
const DISABLED_IF = /^\s*(?:-\s+)?if:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/;

/**
 * npm e2e script names invoked by ACTIVE CI run steps only (#1915, final gate on c166c605):
 * a `run:` value, inline or as a `run: |` / `run: >` block; never a `name:` / `echo`-free
 * mention elsewhere, never a commented line or inline comment, never a step with `if: false`.
 */
export function activeCiE2eScriptNames(ciYaml: string): string[] {
  const names = new Set<string>();
  const lines = ciYaml.split('\n').map((l) => l.replace(/\r$/, ''));
  // Split into steps: a `- ` line starts one; it runs until the next `- ` at the same or a lower indent.
  type Step = string[];
  const steps: Step[] = [];
  let cur: Step | null = null;
  let curIndent = -1;
  for (const raw of lines) {
    const line = stripComment(raw);
    if (line.trim() === '') { if (cur) cur.push(line); continue; }
    const indent = line.length - line.trimStart().length;
    const start = STEP_START.exec(line);
    if (start && (cur === null || indent <= curIndent)) {
      cur = [line];
      curIndent = start[1].length;
      steps.push(cur);
      continue;
    }
    if (cur && indent <= curIndent) { cur = null; curIndent = -1; }
    if (cur) cur.push(line);
  }
  for (const step of steps) {
    if (step.some((l) => DISABLED_IF.test(l))) continue;
    for (let i = 0; i < step.length; i += 1) {
      const m = RUN_KEY.exec(step[i]);
      if (!m) continue;
      const keyIndent = m[1].length + (step[i].trimStart().startsWith('-') ? 2 : 0);
      const body: string[] = [];
      const inline = m[2].trim();
      if (inline !== '' && !/^[|>][+-]?$/.test(inline)) {
        body.push(inline);
      } else {
        for (let j = i + 1; j < step.length; j += 1) {
          const l = step[j];
          if (l.trim() === '') continue;
          if (l.length - l.trimStart().length <= keyIndent) break;
          body.push(l);
        }
      }
      for (const cmd of body) {
        for (const match of cmd.matchAll(NPM_E2E_RUN)) names.add(match[1]);
      }
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

/** Playwright test options that take a separate value (`--grep foo`): that value is never a spec selector. */
const VALUE_OPTIONS = new Set([
  '--grep', '-g', '--grep-invert', '--project', '--config', '-c', '--reporter', '--output', '--workers', '-j',
  '--retries', '--timeout', '--shard', '--repeat-each', '--max-failures', '--global-timeout', '--trace',
  '--tsconfig', '--test-list', '--test-list-invert',
]);

export function extractPlaywrightSpecs(command: string): string[] {
  const tokens = command.split(/\s+/);
  const specs: string[] = [];
  let sawPlaywright = false;
  let skipValue = false;
  for (const token of tokens) {
    if (token === 'playwright' || token.endsWith('playwright')) {
      sawPlaywright = true;
      continue;
    }
    if (!sawPlaywright) continue;
    if (skipValue) { skipValue = false; continue; }
    if (token === 'test') continue;
    if (token.startsWith('-')) {
      if (!token.includes('=') && VALUE_OPTIONS.has(token)) skipValue = true;
      continue;
    }
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