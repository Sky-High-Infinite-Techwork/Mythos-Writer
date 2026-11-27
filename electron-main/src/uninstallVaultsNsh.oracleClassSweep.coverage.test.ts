import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generateOracleClassMutants } from './sidecarOracleMutants.test-helpers.js';
import { loadUninstallVaultsNsh } from './uninstallVaultsNsh.path.js';

/**
 * Coverage guard for the oracle-class sweep wrappers.
 *
 * Each `uninstallVaultsNsh.oracleClassSweep.<lo>-<hi>.test.ts` wrapper calls
 * `registerOracleClassLineSweep(lo, hi)` for one slice of the nsh file, and CI splits the
 * wrappers across the `oracle-sweeps` shards. A mutant line that no wrapper registers would
 * never run in any shard, so this guard fails when the registered ranges stop tiling the
 * whole mutated range (gap, overlap) or when any mutated line is outside every range.
 * Wrapper file names are not trusted (older ones are stale); the registered ranges are.
 */
type LineRange = { readonly file: string; readonly lo: number; readonly hi: number };

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = 'uninstallVaultsNsh.oracleClassSweep.coverage.test.ts';
const SWEEP_FILE = /^uninstallVaultsNsh\.oracleClassSweep\..+\.test\.ts$/;
const REGISTER_CALL = /\bregisterOracleClassLineSweep\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;

/** Pure check so the guard itself can be tested against synthetic gaps and overlaps. */
function checkOracleRangeCoverage(
  ranges: readonly LineRange[],
  mutatedLines: readonly number[],
): string[] {
  const problems: string[] = [];
  const sorted = [...ranges].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  for (const r of sorted) {
    if (r.lo > r.hi) {
      problems.push(`${r.file}: range :${r.lo}-:${r.hi} is reversed`);
    }
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.lo <= prev.hi) {
      problems.push(`overlap: ${prev.file} :${prev.lo}-:${prev.hi} and ${cur.file} :${cur.lo}-:${cur.hi}`);
    } else if (cur.lo > prev.hi + 1) {
      problems.push(`gap: lines :${prev.hi + 1}-:${cur.lo - 1} between ${prev.file} and ${cur.file}`);
    }
  }
  for (const line of mutatedLines) {
    if (!sorted.some((r) => line >= r.lo && line <= r.hi)) {
      problems.push(`mutated line :${line} is outside every wrapper range`);
    }
  }
  return problems;
}

function readRegisteredRanges(): { ranges: LineRange[]; problems: string[] } {
  const ranges: LineRange[] = [];
  const problems: string[] = [];
  for (const file of readdirSync(SRC_DIR).sort()) {
    if (!file.endsWith('.test.ts') || file === SELF) {
      continue;
    }
    const calls = [...readFileSync(join(SRC_DIR, file), 'utf8').matchAll(REGISTER_CALL)];
    if (calls.length === 0) {
      continue;
    }
    if (!SWEEP_FILE.test(file)) {
      problems.push(`${file} registers an oracle-class sweep but is outside the oracle-sweeps file filter`);
    }
    if (calls.length !== 1) {
      problems.push(`${file} has ${calls.length} registerOracleClassLineSweep calls, expected exactly 1`);
    }
    for (const call of calls) {
      ranges.push({ file, lo: Number(call[1]), hi: Number(call[2]) });
    }
  }
  return { ranges, problems };
}

describe('oracle-class sweep wrapper coverage guard', () => {
  it('registered wrapper ranges tile every mutated line with no gap and no overlap', () => {
    const { ranges, problems } = readRegisteredRanges();
    const mutatedLines = [...new Set(generateOracleClassMutants(loadUninstallVaultsNsh()).map((m) => m.fileLine))]
      .sort((a, b) => a - b);
    expect(ranges.length).toBeGreaterThan(0);
    expect(mutatedLines.length).toBeGreaterThan(0);
    // Contiguity is also required at the edges: the first range starts at or before the first
    // mutated line and the last range ends at or after the last one.
    expect([...problems, ...checkOracleRangeCoverage(ranges, mutatedLines)]).toEqual([]);
  });

  it('the checker reports a gap, an overlap and an uncovered line (self-test)', () => {
    const f = (lo: number, hi: number): LineRange => ({ file: `w${lo}-${hi}`, lo, hi });
    expect(checkOracleRangeCoverage([f(1, 5), f(6, 9)], [1, 9])).toEqual([]);
    expect(checkOracleRangeCoverage([f(1, 5), f(7, 9)], [1, 9])).toEqual([
      'gap: lines :6-:6 between w1-5 and w7-9',
    ]);
    expect(checkOracleRangeCoverage([f(1, 5), f(5, 9)], [1, 9])).toEqual([
      'overlap: w1-5 :1-:5 and w5-9 :5-:9',
    ]);
    expect(checkOracleRangeCoverage([f(1, 5), f(6, 9)], [1, 10])).toEqual([
      'mutated line :10 is outside every wrapper range',
    ]);
  });
});
