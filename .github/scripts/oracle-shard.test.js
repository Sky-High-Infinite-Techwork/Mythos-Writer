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

function fakeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-shard-'));
  fs.mkdirSync(path.join(dir, 'electron-main', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'electron-main', 'package.json'),
    JSON.stringify({ scripts: { 'test:oracle-sweeps': 'vitest run --isolate=false src/a.sweep. src/b.only' } }),
  );
  for (const f of files) fs.writeFileSync(path.join(dir, 'electron-main', 'src', f), '');
  return dir;
}

test('real tree: every oracle-sweep file is in exactly one of the 2 shards', () => {
  const r = shard.main(['--verify']);
  assert.equal(r.code, 0, (r.err || []).join('\n'));
  const { filters } = shard.readScript(REPO);
  const files = shard.discoverFiles(REPO, filters);
  assert.ok(files.length > 30, `expected the full sweep file set, got ${files.length}`);
  const s1 = shard.main(['--shard', '1/2']).out;
  const s2 = shard.main(['--shard', '2/2']).out;
  assert.deepEqual([...s1, ...s2].sort(), files);
  assert.equal(new Set([...s1, ...s2]).size, files.length);
  assert.ok(s1.length > 0 && s2.length > 0);
});

test('real tree: weights table matches the files on disk (no unmeasured or stale file)', () => {
  const r = shard.main(['--verify']);
  assert.deepEqual((r.err || []).filter((l) => l.startsWith('warning')), []);
});

test('real tree: shards are cost balanced and the split is deterministic', () => {
  const { filters } = shard.readScript(REPO);
  const files = shard.discoverFiles(REPO, filters);
  const a = shard.plan(files, shard.WEIGHTS, 2);
  const b = shard.plan([...files].reverse(), shard.WEIGHTS, 2);
  assert.deepEqual(a.bins, b.bins);
  const [x, y] = a.bins.map((bin) => bin.seconds).sort((p, q) => q - p);
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
  const { bins } = shard.plan(files, {}, 2);
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
  const mine = shard.main(['--shard', '1/2']).out;
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
  assert.equal(shard.main(['--check-run', write(mine), '--shard', '1/2']).code, 0);
  const missing = shard.main(['--check-run', write(mine.slice(1)), '--shard', '1/2']);
  assert.equal(missing.code, 1);
  assert.match(missing.err.join('\n'), /did not run/);
  const foreign = shard.main(['--check-run', write([...mine, 'src/zzz.test.ts']), '--shard', '1/2']);
  assert.equal(foreign.code, 1);
  assert.match(foreign.err.join('\n'), /not in this shard/);
});

test('--shard rejects the wrong shard count', () => {
  assert.throws(() => shard.main(['--shard', '1/3']), /must look like N\/2/);
  assert.throws(() => shard.main(['--shard', '3/2']), /must look like N\/2/);
});
