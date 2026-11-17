#!/usr/bin/env node
/**
 * Bash scenario tests for ci-tier1-gate.sh and ci-aggregator.sh (same files CI runs).
 * Loaded from workflow-rules.test.js.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPO = path.resolve(__dirname, '..', '..');
const TIER1_SCRIPT = path.join(__dirname, 'ci-tier1-gate.sh');
const AGG_SCRIPT = path.join(__dirname, 'ci-aggregator.sh');
const RESOLVE_DOCS = path.join(__dirname, 'ci-paths-filter-resolve-docs.sh');
const RESOLVE_E2E = path.join(__dirname, 'ci-paths-filter-resolve-e2e.sh');

const ALL_TIER1_OK =
  'success success success success success success success';

function runBash(scriptPath, env) {
  return spawnSync('bash', [scriptPath], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function runMutantScript(source, env) {
  return spawnSync('bash', ['-c', source], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function withGithubOutput(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-out-'));
  const outFile = path.join(dir, 'out');
  try {
    const result = fn(outFile);
    return { result, lines: fs.readFileSync(outFile, 'utf8').trim() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function aggEnv(over) {
  return {
    NEEDS_TIER1_GATE_RESULT: 'success',
    NEEDS_LINT_RESULT: 'success',
    NEEDS_TYPECHECK_RESULT: 'success',
    NEEDS_UNIT_RESULT: 'success',
    NEEDS_DIFF_GUARD_RESULT: 'success',
    NEEDS_ORACLE_SWEEPS_RESULT: 'success',
    NEEDS_E2E_SHARD_1_RESULT: 'success',
    NEEDS_E2E_SHARD_2_RESULT: 'success',
    NEEDS_E2E_SHARD_3_RESULT: 'success',
    NEEDS_E2E_SHARD_4_RESULT: 'success',
    PATHS_FILTER_RUN_E2E: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    ...over,
  };
}

// ---- tier1-gate ------------------------------------------------------------------------------
test('ci-tier1-gate: all Tier 1 success exits 0', () => {
  const r = runBash(TIER1_SCRIPT, { NEEDS_TIER1_RESULTS: ALL_TIER1_OK });
  assert.equal(r.status, 0, r.stderr);
});

test('ci-tier1-gate: one failure exits 1', () => {
  const r = runBash(TIER1_SCRIPT, {
    NEEDS_TIER1_RESULTS: 'success success failure success success success success',
  });
  assert.equal(r.status, 1);
});

test('ci-tier1-gate: cancelled exits 1', () => {
  const r = runBash(TIER1_SCRIPT, {
    NEEDS_TIER1_RESULTS: 'success cancelled success success success success success',
  });
  assert.equal(r.status, 1);
});

test('ci-tier1-gate: skipped exits 1', () => {
  const r = runBash(TIER1_SCRIPT, {
    NEEDS_TIER1_RESULTS: 'success success success skipped success success success',
  });
  assert.equal(r.status, 1);
});

test('ci-tier1-gate: regression catches exit-0 mutant on failure input', () => {
  const failureEnv = {
    NEEDS_TIER1_RESULTS: 'success failure success success success success success',
  };
  const real = runBash(TIER1_SCRIPT, failureEnv);
  assert.equal(real.status, 1, 'production script must fail closed');
  const mutant = fs.readFileSync(TIER1_SCRIPT, 'utf8').replace(/\bexit 1\b/g, 'exit 0');
  const broken = runMutantScript(mutant, failureEnv);
  assert.equal(broken.status, 0, 'mutant incorrectly passes');
  assert.notEqual(real.status, broken.status, 'test must distinguish mutant from production');
});

// ---- aggregator oracle-sweeps ----------------------------------------------------------------
test('ci-aggregator: oracle-sweeps failure exits 1', () => {
  const r = runBash(AGG_SCRIPT, aggEnv({ NEEDS_ORACLE_SWEEPS_RESULT: 'failure' }));
  assert.equal(r.status, 1);
});

test('ci-aggregator: oracle-sweeps cancelled exits 1', () => {
  const r = runBash(AGG_SCRIPT, aggEnv({ NEEDS_ORACLE_SWEEPS_RESULT: 'cancelled' }));
  assert.equal(r.status, 1);
});

test('ci-aggregator: oracle-sweeps skipped exits 1', () => {
  const r = runBash(AGG_SCRIPT, aggEnv({ NEEDS_ORACLE_SWEEPS_RESULT: 'skipped' }));
  assert.equal(r.status, 1);
});

test('ci-aggregator: regression catches exit-0 mutant on oracle failure', () => {
  const env = aggEnv({ NEEDS_ORACLE_SWEEPS_RESULT: 'failure' });
  const real = runBash(AGG_SCRIPT, env);
  assert.equal(real.status, 1);
  const mutant = fs.readFileSync(AGG_SCRIPT, 'utf8').replace(/\bexit 1\b/g, 'exit 0');
  const broken = runMutantScript(mutant, env);
  assert.equal(broken.status, 0);
  assert.notEqual(real.status, broken.status);
});

// ---- aggregator e2e --------------------------------------------------------------------------
test('ci-aggregator: all skipped e2e shards fail when RUN_E2E true', () => {
  const r = runBash(
    AGG_SCRIPT,
    aggEnv({
      PATHS_FILTER_RUN_E2E: 'true',
      NEEDS_E2E_SHARD_1_RESULT: 'skipped',
      NEEDS_E2E_SHARD_2_RESULT: 'skipped',
      NEEDS_E2E_SHARD_3_RESULT: 'skipped',
      NEEDS_E2E_SHARD_4_RESULT: 'skipped',
    }),
  );
  assert.equal(r.status, 1, 'build-electron failure must not pass via skipped shards');
});

test('ci-aggregator: merge_group requires e2e success not skipped', () => {
  const r = runBash(
    AGG_SCRIPT,
    aggEnv({
      GITHUB_EVENT_NAME: 'merge_group',
      PATHS_FILTER_RUN_E2E: 'false',
      NEEDS_E2E_SHARD_1_RESULT: 'skipped',
      NEEDS_E2E_SHARD_2_RESULT: 'success',
      NEEDS_E2E_SHARD_3_RESULT: 'success',
      NEEDS_E2E_SHARD_4_RESULT: 'success',
    }),
  );
  assert.equal(r.status, 1);
});

test('ci-aggregator: docs-only allows all e2e skipped when RUN_E2E false', () => {
  const r = runBash(
    AGG_SCRIPT,
    aggEnv({
      PATHS_FILTER_RUN_E2E: 'false',
      NEEDS_E2E_SHARD_1_RESULT: 'skipped',
      NEEDS_E2E_SHARD_2_RESULT: 'skipped',
      NEEDS_E2E_SHARD_3_RESULT: 'skipped',
      NEEDS_E2E_SHARD_4_RESULT: 'skipped',
    }),
  );
  assert.equal(r.status, 0, r.stderr);
});

test('ci-aggregator: green path when RUN_E2E true and all shards success', () => {
  assert.equal(runBash(AGG_SCRIPT, aggEnv()).status, 0);
});

// ---- paths-filter resolve --------------------------------------------------------------------
test('ci-paths-filter-resolve-docs: non true/false values fail closed to false', () => {
  const { lines } = withGithubOutput((out) =>
    runBash(RESOLVE_DOCS, {
      GITHUB_OUTPUT: out,
      FILTER_DOCS_OUTCOME: 'success',
      FILTER_DOCS_DOCS_ONLY: 'maybe',
    }),
  );
  assert.equal(lines, 'docs-only=false');
});

test('ci-paths-filter-resolve-e2e: non true/false values fail closed to true', () => {
  const { lines } = withGithubOutput((out) =>
    runBash(RESOLVE_E2E, {
      GITHUB_OUTPUT: out,
      GITHUB_EVENT_NAME: 'pull_request',
      FILTER_E2E_OUTCOME: 'success',
      FILTER_E2E_RUN_E2E: '1',
    }),
  );
  assert.equal(lines, 'run-e2e=true');
});