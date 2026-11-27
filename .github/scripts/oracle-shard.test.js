#!/usr/bin/env node
/**
 * Tests for the oracle-sweeps shard planner.
 * Run: node .github/scripts/oracle-shard.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const shard = require('./oracle-shard.js');

const REPO = path.resolve(__dirname, '..', '..');
const N = shard.SHARD_COUNT;

function fakeRepo(files, script = 'vitest run --isolate=false src/a.sweep. src/b.only') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-shard-'));
  fs.mkdirSync(path.join(dir, 'electron-main', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'electron-main', 'package.json'),
    JSON.stringify({ scripts: { 'test:oracle-sweeps': script } }),
  );
  for (const f of files) fs.writeFileSync(path.join(dir, 'electron-main', 'src', f), '');
  return dir;
}

test('real tree: every oracle-sweep file is in exactly one of the shards', () => {
  const r = shard.main(['--verify']);
  assert.equal(r.code, 0, (r.err || []).join('\n'));
  const { filters } = shard.readScript(REPO);
  const files = shard.discoverFiles(REPO, filters);
  assert.ok(files.length > 30, `expected the full sweep file set, got ${files.length}`);
  const parts = Array.from({ length: N }, (_, i) => shard.main(['--shard', `${i + 1}/${N}`]).out);
  const all = parts.flat();
  assert.deepEqual([...all].sort(), files);
  assert.equal(new Set(all).size, files.length);
  assert.ok(parts.every((p) => p.length > 0));
});

test('real tree: weights table matches the files on disk (no unmeasured or stale file)', () => {
  const r = shard.main(['--verify']);
  assert.deepEqual((r.err || []).filter((l) => l.startsWith('warning')), []);
});

test('real tree: shards are cost balanced and the split is deterministic', () => {
  const { filters } = shard.readScript(REPO);
  const files = shard.discoverFiles(REPO, filters);
  const a = shard.plan(files, shard.WEIGHTS, N);
  const b = shard.plan([...files].reverse(), shard.WEIGHTS, N);
  assert.deepEqual(a.bins, b.bins);
  const secs = a.bins.map((bin) => bin.seconds).sort((p, q) => q - p);
  const x = secs[0];
  const y = secs[secs.length - 1];
  assert.ok(x / y < 1.1, `shards differ by more than 10%: ${x} vs ${y}`);
});

test('the sweep script flags and filters come from package.json', () => {
  assert.deepEqual(shard.main(['--flags']).out, ['--isolate=false']);
  assert.ok(shard.main(['--filters']).out.includes('src/uninstallVaultsNsh.oracleClassSweep.'));
});

test('verify fails when vitest lists a file the plan lacks, or the plan has a file vitest lacks', () => {
  const dir = fakeRepo(['a.sweep.1.test.ts', 'a.sweep.2.test.ts', 'b.only.test.ts', 'c.other.test.ts']);
  const { filters } = shard.readScript(dir);
  const files = shard.discoverFiles(dir, filters);
  assert.deepEqual(files, ['src/a.sweep.1.test.ts', 'src/a.sweep.2.test.ts', 'src/b.only.test.ts']);
  const { bins } = shard.plan(files, {}, N);
  assert.deepEqual(shard.verify(files, bins, files), []);
  assert.match(shard.verify(files, bins, [...files, 'src/new.test.ts']).join('\n'), /vitest lists src\/new\.test\.ts/);
  assert.match(shard.verify(files, bins, files.slice(1)).join('\n'), /src\/a\.sweep\.1\.test\.ts is not in vitest/);
});

test('verify fails on a dropped file, a duplicated file and an empty shard', () => {
  const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
  const dropped = [{ files: ['src/a.test.ts'] }, { files: ['src/b.test.ts'] }];
  assert.match(shard.verify(files, dropped).join('\n'), /src\/c\.test\.ts is in no shard/);
  const dup = [{ files }, { files: ['src/a.test.ts'] }];
  assert.match(shard.verify(files, dup).join('\n'), /src\/a\.test\.ts is in shards 1 and 2/);
  assert.match(shard.verify(files, [{ files }, { files: [] }]).join('\n'), /shard 2 has no files/);
});

test('check-run fails if a shard skipped a file or ran a foreign one', () => {
  const mine = shard.main(['--shard', `1/${N}`]).out;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-run-'));
  const root = path.join(REPO, 'electron-main') + path.sep;
  const write = (names) => {
    const f = path.join(dir, 'run.json');
    fs.writeFileSync(
      f,
      JSON.stringify({ numTotalTests: 10, numFailedTests: 0, testResults: names.map((n) => ({ name: root + n })) }),
    );
    return f;
  };
  assert.equal(shard.main(['--check-run', write(mine), '--shard', `1/${N}`]).code, 0);
  const missing = shard.main(['--check-run', write(mine.slice(1)), '--shard', `1/${N}`]);
  assert.equal(missing.code, 1);
  assert.match(missing.err.join('\n'), /did not run/);
  const foreign = shard.main(['--check-run', write([...mine, 'src/zzz.test.ts']), '--shard', `1/${N}`]);
  assert.equal(foreign.code, 1);
  assert.match(foreign.err.join('\n'), /not in this shard/);
});

test('--shard rejects the wrong shard count', () => {
  assert.throws(() => shard.main(['--shard', `1/${N + 1}`]), new RegExp(`must look like N/${N}`));
  assert.throws(() => shard.main(['--shard', `${N + 1}/${N}`]), new RegExp(`must look like N/${N}`));
});

/** Independent walk of ALL of electron-main (not just src/), so a bug in discoverFiles cannot hide itself. */
function independentScan(filters) {
  const root = path.join(REPO, 'electron-main');
  const found = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'coverage') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.test.ts')) found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return found.filter((f) => filters.some((flt) => f.includes(flt))).sort();
}

test('real tree: an independent scan, discoverFiles and the WEIGHTS table agree on the file set', () => {
  const { filters } = shard.readScript(REPO);
  const scanned = independentScan(filters);
  assert.deepEqual(shard.discoverFiles(REPO, filters), scanned);
  assert.deepEqual(Object.keys(shard.WEIGHTS).sort(), scanned);
});

test('--shard, --flags and --filters fail closed instead of printing nothing', () => {
  const one = fakeRepo(['a.sweep.1.test.ts']);
  const { bins } = shard.plan(['src/a.sweep.1.test.ts'], {}, N);
  assert.equal(bins[N - 1].files.length, 0);
  const empty = shard.main(['--shard', `${N}/${N}`], one);
  assert.equal(empty.code, 1);
  assert.match(empty.err.join('\n'), new RegExp(`shard ${N}/${N} has no files`));
  const noFlags = fakeRepo(['a.sweep.1.test.ts'], 'vitest run src/a.sweep.');
  const f = shard.main(['--flags'], noFlags);
  assert.equal(f.code, 1);
  assert.deepEqual(f.out, []);
  const noFilters = fakeRepo(['a.sweep.1.test.ts'], 'vitest run --isolate=false');
  assert.equal(shard.main(['--filters'], noFilters).code, 1);
  assert.equal(shard.main(['--shard', `1/${N}`], noFilters).code, 1);
});

test('check-run reports planned vs measured seconds and only warns on drift', () => {
  const mine = shard.main(['--shard', `1/${N}`]).out;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-run2-'));
  const root = path.join(REPO, 'electron-main') + path.sep;
  const planned = shard.plan(shard.discoverFiles(REPO, shard.readScript(REPO).filters), shard.WEIGHTS, N).bins[0].seconds;
  const write = (seconds) => {
    const f = path.join(dir, 'run.json');
    const per = (seconds * 1000) / mine.length;
    fs.writeFileSync(
      f,
      JSON.stringify({
        numTotalTests: 1,
        numFailedTests: 0,
        testResults: mine.map((n) => ({ name: root + n, assertionResults: [{ duration: per }] })),
      }),
    );
    return f;
  };
  const ok = shard.main(['--check-run', write(planned), '--shard', `1/${N}`]);
  assert.equal(ok.code, 0);
  assert.match(ok.out.join('\n'), /planned ~\d+ s of test time, measured \d+ s \(x1\.00\)/);
  assert.doesNotMatch(ok.out.join('\n'), /WARNING/);
  const slow = shard.main(['--check-run', write(planned * 2), '--shard', `1/${N}`]);
  assert.equal(slow.code, 0, 'drift must warn, not fail');
  assert.match(slow.out.join('\n'), /WARNING: measured test time is more than 25% off/);
  assert.match(slow.err.join('\n'), /::warning title=oracle-sweeps weights::/);
});
