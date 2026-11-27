#!/usr/bin/env node
/**
 * Cost-balanced split of the oracle-sweeps test files across the CI shards (SHARD_COUNT, 3).
 *
 * Vitest's own `--shard=N/M` splits by a hash of the file path, so it balances file COUNT,
 * not cost. One file can take 20+ minutes, so the hash split left one slow shard and one fast
 * shard. This script assigns each file to a shard by measured cost (longest-first greedy,
 * ties broken by file name), so the same tree always gives the same split.
 *
 * The file set comes from the `test:oracle-sweeps` script in electron-main/package.json, the
 * same substring filters vitest uses, so there is one source of truth for "which files are
 * oracle sweeps". The guards below fail loudly if a file can fall outside every shard.
 *
 * Usage (from the repo root):
 *   node .github/scripts/oracle-shard.js --shard 1/3          files for one shard, one per line
 *   node .github/scripts/oracle-shard.js --flags              vitest flags from package.json
 *   node .github/scripts/oracle-shard.js --filters            vitest filters from package.json
 *   node .github/scripts/oracle-shard.js --verify [--vitest-list list.json]
 *   node .github/scripts/oracle-shard.js --check-run run.json --shard 1/3   (also prints planned vs measured seconds)
 *
 * To refresh WEIGHTS after a big change, run the sweep with `--reporter=json` and sum the
 * assertion durations per file (seconds).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const SHARD_COUNT = 3;

/**
 * Seconds per file, from the public CI run 46031457761 (pull_request, ubuntu-latest, 3 vitest
 * workers per leg), the per-file times in the vitest verbose log. That run's leg 1 landed on a
 * runner ~2.1x slower on EVERY file than leg 2 (median ci/local ratio 1.93 vs 0.91), so leg 1's
 * files are divided by 2.12 to put all files on one speed (leg 2's). The split is by relative
 * cost, so only the ratios between files matter.
 *
 * Refresh trigger: `--check-run` prints planned vs measured test seconds for the shard and warns
 * when they differ by more than 25%. Slow runners move BOTH legs, but a persistent skew of one
 * leg across two runs in a row means the weights are stale: re-measure from a CI log (or run the
 * sweep locally with `--reporter=json` and sum durations per file) and update this table.
 */
const WEIGHTS = {
  'src/uninstallVaultsNsh.guardRegionSweep.equiv.103-124.test.ts': 17,
  'src/uninstallVaultsNsh.guardRegionSweep.equiv.125-192.test.ts': 8,
  'src/uninstallVaultsNsh.guardRegionSweep.equiv.277-298.test.ts': 10,
  'src/uninstallVaultsNsh.guardRegionSweep.equiv.309-337.test.ts': 21,
  'src/uninstallVaultsNsh.guardRegionSweep.equiv.350-355.test.ts': 7,
  'src/uninstallVaultsNsh.guardRegionSweep.equiv.357-464.test.ts': 8,
  'src/uninstallVaultsNsh.guardRegionSweep.equiv.467-480.test.ts': 8,
  'src/uninstallVaultsNsh.guardRegionSweep.equiv.47-99.test.ts': 19,
  'src/uninstallVaultsNsh.guardRegionSweep.equiv.487-491.test.ts': 8,
  'src/uninstallVaultsNsh.guardRegionSweep.equiv.493-495.test.ts': 5,
  'src/uninstallVaultsNsh.hardAC.nestedDownloads.test.ts': 83,
  'src/uninstallVaultsNsh.oracleClassSweep.106-116.test.ts': 45,
  'src/uninstallVaultsNsh.oracleClassSweep.117-122.test.ts': 89,
  'src/uninstallVaultsNsh.oracleClassSweep.123-167.test.ts': 201,
  'src/uninstallVaultsNsh.oracleClassSweep.168-183.test.ts': 29,
  'src/uninstallVaultsNsh.oracleClassSweep.184-216.test.ts': 162,
  'src/uninstallVaultsNsh.oracleClassSweep.217-224.test.ts': 151,
  'src/uninstallVaultsNsh.oracleClassSweep.225-232.test.ts': 15,
  'src/uninstallVaultsNsh.oracleClassSweep.233-240.test.ts': 6,
  'src/uninstallVaultsNsh.oracleClassSweep.241-248.test.ts': 185,
  'src/uninstallVaultsNsh.oracleClassSweep.249-256.test.ts': 20,
  'src/uninstallVaultsNsh.oracleClassSweep.257-267.test.ts': 36,
  'src/uninstallVaultsNsh.oracleClassSweep.268-275.test.ts': 91,
  'src/uninstallVaultsNsh.oracleClassSweep.276-305.test.ts': 136,
  'src/uninstallVaultsNsh.oracleClassSweep.306-313.test.ts': 88,
  'src/uninstallVaultsNsh.oracleClassSweep.344-368.test.ts': 141,
  'src/uninstallVaultsNsh.oracleClassSweep.369-379.test.ts': 108,
  'src/uninstallVaultsNsh.oracleClassSweep.380-394.test.ts': 168,
  'src/uninstallVaultsNsh.oracleClassSweep.383-400.test.ts': 180,
  'src/uninstallVaultsNsh.oracleClassSweep.395-418.test.ts': 122,
  'src/uninstallVaultsNsh.oracleClassSweep.43-55.test.ts': 51,
  'src/uninstallVaultsNsh.oracleClassSweep.437-478.test.ts': 212,
  'src/uninstallVaultsNsh.oracleClassSweep.479-540.test.ts': 292,
  'src/uninstallVaultsNsh.oracleClassSweep.541-549.test.ts': 214,
  'src/uninstallVaultsNsh.oracleClassSweep.550-568.test.ts': 278,
  'src/uninstallVaultsNsh.oracleClassSweep.56-60.test.ts': 52,
  'src/uninstallVaultsNsh.oracleClassSweep.569-582.test.ts': 301,
  'src/uninstallVaultsNsh.oracleClassSweep.61-83.test.ts': 27,
  'src/uninstallVaultsNsh.oracleClassSweep.84-98.test.ts': 95,
  'src/uninstallVaultsNsh.oracleClassSweep.99-105.test.ts': 83,
  'src/uninstallVaultsNsh.oracleClassSweep.coverage.test.ts': 1,
  'src/uninstallVaultsNsh.oracleClassSweep.test.ts': 1,
};

/** Files with no measured weight get the median of the measured ones, and a warning. */
function defaultWeight() {
  const v = Object.values(WEIGHTS).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function readScript(repo) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'electron-main', 'package.json'), 'utf8'));
  const cmd = pkg.scripts && pkg.scripts['test:oracle-sweeps'];
  if (typeof cmd !== 'string') throw new Error('electron-main/package.json has no test:oracle-sweeps script');
  const m = cmd.match(/\bvitest run\s+(.*)$/);
  if (!m) throw new Error(`test:oracle-sweeps is not a plain "vitest run ..." command: ${cmd}`);
  const tokens = m[1].split(/\s+/).filter(Boolean);
  return {
    flags: tokens.filter((t) => t.startsWith('-')),
    filters: tokens.filter((t) => !t.startsWith('-')),
  };
}

/**
 * Test files under electron-main/src (any depth, like vitest's `src/**\/*.test.ts` include)
 * that vitest would select for these filters, as `src/...` paths, sorted.
 */
function discoverFiles(repo, filters) {
  const root = path.join(repo, 'electron-main');
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.test.ts')) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'src'));
  return out.filter((f) => filters.some((flt) => f.includes(flt))).sort();
}

function plan(files, weights, count) {
  const fallback = defaultWeight();
  const unknown = files.filter((f) => weights[f] === undefined);
  const cost = (f) => (weights[f] !== undefined ? weights[f] : fallback);
  const bins = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const f of [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1))) {
    let best = bins[0];
    for (const b of bins) if (b.seconds < best.seconds) best = b;
    best.files.push(f);
    best.seconds += cost(f);
  }
  for (const b of bins) b.files.sort();
  return { bins, unknown, stale: Object.keys(weights).filter((f) => !files.includes(f)) };
}

function verify(files, bins, vitestList) {
  const problems = [];
  const seen = new Map();
  bins.forEach((b, i) => {
    if (b.files.length === 0) problems.push(`shard ${i + 1} has no files`);
    for (const f of b.files) {
      if (seen.has(f)) problems.push(`${f} is in shards ${seen.get(f) + 1} and ${i + 1}`);
      seen.set(f, i);
    }
  });
  for (const f of files) if (!seen.has(f)) problems.push(`${f} is in no shard`);
  if (seen.size !== files.length) problems.push(`shards hold ${seen.size} files, expected ${files.length}`);
  if (vitestList) {
    const listed = new Set(vitestList);
    for (const f of files) if (!listed.has(f)) problems.push(`${f} is not in vitest's file list`);
    for (const f of listed) if (!files.includes(f)) problems.push(`vitest lists ${f} but the shard plan does not`);
  }
  return problems;
}

/** Files named in `vitest list --filesOnly --json=...` output, relative to electron-main. */
function readVitestList(file) {
  const root = path.join(REPO, 'electron-main') + path.sep;
  return JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => {
    const abs = typeof e === 'string' ? e : e.file;
    return abs.startsWith(root) ? abs.slice(root.length).split(path.sep).join('/') : abs;
  });
}

/** Files and test counts from a vitest `--reporter=json` result file. */
function readRun(file) {
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  const root = path.join(REPO, 'electron-main') + path.sep;
  const files = run.testResults.map((r) => (r.name.startsWith(root) ? r.name.slice(root.length) : r.name));
  const ms = run.testResults.reduce(
    (sum, r) => sum + (r.assertionResults || []).reduce((s2, a) => s2 + (a.duration || 0), 0),
    0,
  );
  return { files: files.sort(), tests: run.numTotalTests, failed: run.numFailedTests, testSeconds: ms / 1000 };
}

function parseShard(arg, count) {
  const m = /^(\d+)\/(\d+)$/.exec(arg || '');
  if (!m || Number(m[2]) !== count || Number(m[1]) < 1 || Number(m[1]) > count) {
    throw new Error(`--shard must look like N/${count}, got "${arg}"`);
  }
  return Number(m[1]);
}

function main(argv, repo = REPO) {
  const out = [];
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const { flags, filters } = readScript(repo);
  // Fail closed: an empty flag or filter list would make `vitest run` drop --isolate=false or
  // run the WHOLE electron-main suite, so refuse to print nothing.
  if (argv.includes('--flags')) {
    return flags.length ? { code: 0, out: flags } : { code: 1, out: [], err: ['ERROR: no vitest flags found in test:oracle-sweeps'] };
  }
  if (argv.includes('--filters')) {
    return filters.length ? { code: 0, out: filters } : { code: 1, out: [], err: ['ERROR: no vitest filters found in test:oracle-sweeps'] };
  }
  const files = discoverFiles(repo, filters);
  if (files.length === 0) return { code: 1, out: [], err: ['no oracle-sweep files found'] };
  const { bins, unknown, stale } = plan(files, WEIGHTS, SHARD_COUNT);
  const err = [];
  for (const f of unknown) err.push(`warning: no measured weight for ${f}, using the median`);
  for (const f of stale) err.push(`warning: WEIGHTS lists ${f} but it no longer exists`);

  if (argv.includes('--verify')) {
    const list = arg('--vitest-list');
    const problems = verify(files, bins, list ? readVitestList(list) : undefined);
    bins.forEach((b, i) => out.push(`shard ${i + 1}/${SHARD_COUNT}: ${b.files.length} files, ~${Math.round(b.seconds)} s of test time`));
    out.push(`all files: ${files.length}`);
    if (problems.length) return { code: 1, out, err: [...err, ...problems.map((p) => `ERROR: ${p}`)] };
    out.push('shard plan OK: union of shards == all oracle-sweep files, no overlap');
    return { code: 0, out, err };
  }
  const n = parseShard(arg('--shard'), SHARD_COUNT);
  if (argv.includes('--check-run')) {
    const run = readRun(arg('--check-run'));
    const expected = bins[n - 1].files;
    const problems = [];
    for (const f of expected) if (!run.files.includes(f)) problems.push(`${f} did not run`);
    for (const f of run.files) if (!expected.includes(f)) problems.push(`${f} ran but is not in this shard`);
    out.push(`oracle-sweeps shard ${n}/${SHARD_COUNT}: ${run.files.length} files, ${run.tests} tests, ${run.failed} failed`);
    // Balance drift is a warning, not a failure: a slow or fast runner moves the ratio too.
    const planned = bins[n - 1].seconds;
    const ratio = run.testSeconds / planned;
    out.push(`  planned ~${Math.round(planned)} s of test time, measured ${Math.round(run.testSeconds)} s (x${ratio.toFixed(2)})`);
    if (ratio < 0.75 || ratio > 1.25) {
      out.push('  WARNING: measured test time is more than 25% off the plan. If both legs show it, the runner was slow or fast; if one leg is off on two runs in a row, refresh WEIGHTS in oracle-shard.js.');
      err.push(`::warning title=oracle-sweeps weights::shard ${n}/${SHARD_COUNT} measured x${ratio.toFixed(2)} of plan`);
    }
    if (problems.length) return { code: 1, out, err: problems.map((p) => `ERROR: ${p}`) };
    return { code: 0, out, err };
  }
  if (bins[n - 1].files.length === 0) return { code: 1, out: [], err: [...err, `ERROR: shard ${n}/${SHARD_COUNT} has no files`] };
  return { code: 0, out: bins[n - 1].files, err };
}

module.exports = { WEIGHTS, SHARD_COUNT, readScript, discoverFiles, plan, verify, readVitestList, readRun, main };

if (require.main === module) {
  try {
    const r = main(process.argv.slice(2));
    for (const l of r.err || []) console.error(l);
    for (const l of r.out) console.log(l);
    process.exit(r.code);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
