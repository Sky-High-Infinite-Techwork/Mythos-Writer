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
    assert.equal(result.status, 0, result.stderr || result.stdout);
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

/** Production must fail closed; mutant must incorrectly pass (proves test would catch revert). */
function assertMutantKilled(label, scriptPath, env, makeMutant) {
  const prod = runBash(scriptPath, env);
  assert.equal(prod.status, 1, `${label}: production must exit 1 (${prod.stderr})`);
  const mutant = makeMutant(fs.readFileSync(scriptPath, 'utf8'));
  const broken = runMutantScript(mutant, env);
  assert.equal(broken.status, 0, `${label}: mutant must incorrectly exit 0`);
}

// ---- tier1-gate ------------------------------------------------------------------------------
test('ci-tier1-gate: all Tier 1 success exits 0', () => {
  const r = runBash(TIER1_SCRIPT, { NEEDS_TIER1_RESULTS: ALL_TIER1_OK });
  assert.equal(r.status, 0, r.stderr);
});

test('ci-tier1-gate: glob token matching cwd decoys fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier1-glob-'));
  try {
    fs.writeFileSync(path.join(dir, 'success'), 'decoy');
    const env = {
      NEEDS_TIER1_RESULTS: 'success success success success success success *',
    };
    const prod = spawnSync('bash', [TIER1_SCRIPT], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(prod.status, 1, 'literal * token must not succeed');
    const src = fs.readFileSync(TIER1_SCRIPT, 'utf8');
    const mutant = src.replace(
      /set -f\nIFS=' ' read -r -a results <<<"\$flat"\nset \+f/,
      '# shellcheck disable=SC2206\nresults=($flat)\n',
    );
    const broken = spawnSync('bash', ['-c', mutant], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(broken.status, 0, 'mutant must incorrectly pass via glob expansion');
    assert.notEqual(prod.status, broken.status);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// ---- tier1-gate empty / count ----------------------------------------------------------------
test('ci-tier1-gate: empty NEEDS_TIER1_RESULTS exits 1', () => {
  assert.equal(runBash(TIER1_SCRIPT, { NEEDS_TIER1_RESULTS: '' }).status, 1);
});

test('ci-tier1-gate: unset NEEDS_TIER1_RESULTS exits 1', () => {
  const env = { ...process.env };
  delete env.NEEDS_TIER1_RESULTS;
  assert.equal(runBash(TIER1_SCRIPT, env).status, 1);
});

test('ci-tier1-gate: six results (missing shard) exits 1', () => {
  assert.equal(
    runBash(TIER1_SCRIPT, { NEEDS_TIER1_RESULTS: 'success success success success success success' })
      .status,
    1,
  );
});

test('ci-tier1-gate: eighth token on following line exits 1', () => {
  assert.equal(
    runBash(TIER1_SCRIPT, {
      NEEDS_TIER1_RESULTS: `success success success success success success success
failure`,
    }).status,
    1,
  );
});

test('ci-tier1-gate: eight results (extra job) exits 1', () => {
  assert.equal(
    runBash(TIER1_SCRIPT, { NEEDS_TIER1_RESULTS: `${ALL_TIER1_OK} success` }).status,
    1,
  );
});

test('ci-tier1-gate: mutant accepting six tier1 results is killed', () => {
  const env = { NEEDS_TIER1_RESULTS: 'success success success success success success' };
  assertMutantKilled('drop requires-7 guard', TIER1_SCRIPT, env, (src) =>
    src.replace(/if \[ "\$\{#results\[@\]\}" -ne 7 \]; then[\s\S]*?fi\n\n/, ''),
  );
});

// ---- aggregator tier1-gate + Tier1 deps ------------------------------------------------------
test('ci-aggregator: tier1-gate failure exits 1', () => {
  assert.equal(runBash(AGG_SCRIPT, aggEnv({ NEEDS_TIER1_GATE_RESULT: 'failure' })).status, 1);
});

test('ci-aggregator: mutant removing tier1-gate check is killed', () => {
  assertMutantKilled(
    'drop tier1-gate require_success',
    AGG_SCRIPT,
    aggEnv({ NEEDS_TIER1_GATE_RESULT: 'failure' }),
    (src) => src.replace(/require_success "NEEDS_TIER1_GATE_RESULT"[^\n]*\n/, ''),
  );
});

test('ci-aggregator: empty NEEDS_TIER1_GATE_RESULT exits 1', () => {
  assert.equal(runBash(AGG_SCRIPT, aggEnv({ NEEDS_TIER1_GATE_RESULT: '' })).status, 1);
});

test('ci-aggregator: lint failure exits 1', () => {
  assert.equal(runBash(AGG_SCRIPT, aggEnv({ NEEDS_LINT_RESULT: 'failure' })).status, 1);
});

test('ci-aggregator: typecheck failure exits 1', () => {
  assert.equal(runBash(AGG_SCRIPT, aggEnv({ NEEDS_TYPECHECK_RESULT: 'failure' })).status, 1);
});

test('ci-aggregator: unit failure exits 1', () => {
  assert.equal(runBash(AGG_SCRIPT, aggEnv({ NEEDS_UNIT_RESULT: 'failure' })).status, 1);
});

test('ci-aggregator: diff-guard failure exits 1', () => {
  assert.equal(runBash(AGG_SCRIPT, aggEnv({ NEEDS_DIFF_GUARD_RESULT: 'failure' })).status, 1);
});

test('ci-aggregator: empty GITHUB_EVENT_NAME exits 1', () => {
  assert.equal(runBash(AGG_SCRIPT, aggEnv({ GITHUB_EVENT_NAME: '' })).status, 1);
});

test('ci-aggregator: empty PATHS_FILTER_RUN_E2E on pull_request exits 1', () => {
  assert.equal(
    runBash(AGG_SCRIPT, aggEnv({ PATHS_FILTER_RUN_E2E: '', GITHUB_EVENT_NAME: 'pull_request' }))
      .status,
    1,
  );
});

test('ci-aggregator: unknown PATHS_FILTER_RUN_E2E on pull_request exits 1', () => {
  assert.equal(
    runBash(AGG_SCRIPT, aggEnv({ PATHS_FILTER_RUN_E2E: 'maybe', GITHUB_EVENT_NAME: 'pull_request' }))
      .status,
    1,
  );
});

test('ci-aggregator: mutant empty RUN_E2E treated as skip is killed', () => {
  assertMutantKilled(
    'empty PATHS_FILTER_RUN_E2E allows skip',
    AGG_SCRIPT,
    aggEnv({
      PATHS_FILTER_RUN_E2E: '',
      GITHUB_EVENT_NAME: 'pull_request',
      NEEDS_E2E_SHARD_1_RESULT: 'skipped',
      NEEDS_E2E_SHARD_2_RESULT: 'skipped',
      NEEDS_E2E_SHARD_3_RESULT: 'skipped',
      NEEDS_E2E_SHARD_4_RESULT: 'skipped',
    }),
    (src) =>
      src.replace(
        'else\n  fail "PATHS_FILTER_RUN_E2E must be \'true\' or \'false\' for pull_request (got \'${run_e2e}\')"\nfi',
        'else\n  require_e2e=false\nfi',
      ),
  );
});

// ---- aggregator e2e shards -------------------------------------------------------------------
test('ci-aggregator: shard 4 failure when RUN_E2E true exits 1', () => {
  assert.equal(
    runBash(AGG_SCRIPT, aggEnv({ NEEDS_E2E_SHARD_4_RESULT: 'failure', PATHS_FILTER_RUN_E2E: 'true' }))
      .status,
    1,
  );
});

test('ci-aggregator: empty shard 4 result exits 1', () => {
  assert.equal(runBash(AGG_SCRIPT, aggEnv({ NEEDS_E2E_SHARD_4_RESULT: '' })).status, 1);
});

test('ci-aggregator: mutant dropping shard 4 from checks is killed', () => {
  assertMutantKilled(
    'omit shard 4 require_nonempty',
    AGG_SCRIPT,
    aggEnv({ NEEDS_E2E_SHARD_4_RESULT: '', PATHS_FILTER_RUN_E2E: 'true' }),
    (src) => src.replace(/\n  "\$\{NEEDS_E2E_SHARD_4_RESULT:-\}"\n/, '\n'),
  );
});

test('ci-aggregator: mutant dropping shard 3 from checks is killed', () => {
  assertMutantKilled(
    'omit shard 3 require_nonempty',
    AGG_SCRIPT,
    aggEnv({ NEEDS_E2E_SHARD_3_RESULT: '', PATHS_FILTER_RUN_E2E: 'true' }),
    (src) => src.replace(/\n  "\$\{NEEDS_E2E_SHARD_3_RESULT:-\}"\n/, '\n'),
  );
});

test('ci-aggregator: partial e2e skip when RUN_E2E true exits 1', () => {
  assert.equal(
    runBash(
      AGG_SCRIPT,
      aggEnv({
        PATHS_FILTER_RUN_E2E: 'true',
        NEEDS_E2E_SHARD_1_RESULT: 'success',
        NEEDS_E2E_SHARD_2_RESULT: 'skipped',
        NEEDS_E2E_SHARD_3_RESULT: 'success',
        NEEDS_E2E_SHARD_4_RESULT: 'success',
      }),
    ).status,
    1,
  );
});

test('ci-aggregator: e2e shard failure when RUN_E2E false exits 1', () => {
  assert.equal(
    runBash(
      AGG_SCRIPT,
      aggEnv({
        PATHS_FILTER_RUN_E2E: 'false',
        NEEDS_E2E_SHARD_2_RESULT: 'failure',
      }),
    ).status,
    1,
  );
});

test('ci-aggregator: push requires e2e success when PATHS_FILTER_RUN_E2E false', () => {
  assert.equal(
    runBash(
      AGG_SCRIPT,
      aggEnv({
        GITHUB_EVENT_NAME: 'push',
        PATHS_FILTER_RUN_E2E: 'false',
        NEEDS_E2E_SHARD_1_RESULT: 'skipped',
      }),
    ).status,
    1,
  );
});

test('ci-aggregator: workflow_dispatch requires e2e success when PATHS_FILTER_RUN_E2E false', () => {
  assert.equal(
    runBash(
      AGG_SCRIPT,
      aggEnv({
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        PATHS_FILTER_RUN_E2E: 'false',
        NEEDS_E2E_SHARD_1_RESULT: 'skipped',
      }),
    ).status,
    1,
  );
});

// ---- paths-filter resolve-docs ---------------------------------------------------------------
test('ci-paths-filter-resolve-docs: filter step failure defaults docs-only=false', () => {
  const { lines } = withGithubOutput((out) =>
    runBash(RESOLVE_DOCS, {
      GITHUB_OUTPUT: out,
      FILTER_DOCS_OUTCOME: 'failure',
      FILTER_DOCS_DOCS_ONLY: 'true',
    }),
  );
  assert.equal(lines, 'docs-only=false');
});

test('ci-paths-filter-resolve-docs: empty outcome defaults docs-only=false', () => {
  const { lines } = withGithubOutput((out) =>
    runBash(RESOLVE_DOCS, { GITHUB_OUTPUT: out, FILTER_DOCS_OUTCOME: '', FILTER_DOCS_DOCS_ONLY: 'true' }),
  );
  assert.equal(lines, 'docs-only=false');
});

test('ci-paths-filter-resolve-docs: success outcome with false passes docs-only=false', () => {
  const { lines } = withGithubOutput((out) =>
    runBash(RESOLVE_DOCS, {
      GITHUB_OUTPUT: out,
      FILTER_DOCS_OUTCOME: 'success',
      FILTER_DOCS_DOCS_ONLY: 'false',
    }),
  );
  assert.equal(lines, 'docs-only=false');
});

test('ci-paths-filter-resolve-docs: mutant true on explicit false input is killed', () => {
  const prod = withGithubOutput((out) =>
    runBash(RESOLVE_DOCS, {
      GITHUB_OUTPUT: out,
      FILTER_DOCS_OUTCOME: 'success',
      FILTER_DOCS_DOCS_ONLY: 'false',
    }),
  );
  assert.equal(prod.lines, 'docs-only=false');
  const src = fs.readFileSync(RESOLVE_DOCS, 'utf8');
  const mutant = src.replace('false) value="false"', 'false) value="true"');
  const broken = withGithubOutput((out) =>
    runMutantScript(mutant, {
      GITHUB_OUTPUT: out,
      FILTER_DOCS_OUTCOME: 'success',
      FILTER_DOCS_DOCS_ONLY: 'false',
    }),
  );
  assert.equal(broken.lines, 'docs-only=true');
  assert.notEqual(prod.lines, broken.lines);
});

test('ci-paths-filter-resolve-docs: passes docs-only=true through', () => {
  const { lines } = withGithubOutput((out) =>
    runBash(RESOLVE_DOCS, {
      GITHUB_OUTPUT: out,
      FILTER_DOCS_OUTCOME: 'success',
      FILTER_DOCS_DOCS_ONLY: 'true',
    }),
  );
  assert.equal(lines, 'docs-only=true');
});

test('ci-paths-filter-resolve-docs: mutant default docs-only=true on filter fail is killed', () => {
  const env = {
    GITHUB_OUTPUT: path.join(os.tmpdir(), 'should-not-write'),
    FILTER_DOCS_OUTCOME: 'failure',
    FILTER_DOCS_DOCS_ONLY: 'true',
  };
  const prod = withGithubOutput((out) => runBash(RESOLVE_DOCS, { ...env, GITHUB_OUTPUT: out }));
  assert.equal(prod.lines, 'docs-only=false');
  const src = fs.readFileSync(RESOLVE_DOCS, 'utf8');
  const mutant = src.replace('value="false"', 'value="true"');
  const broken = withGithubOutput((out) => runMutantScript(mutant, { ...env, GITHUB_OUTPUT: out }));
  assert.equal(broken.lines, 'docs-only=true');
  assert.notEqual(prod.lines, broken.lines);
});

// ---- paths-filter resolve-e2e ----------------------------------------------------------------
test('ci-paths-filter-resolve-e2e: filter failure defaults run-e2e=true', () => {
  const { lines } = withGithubOutput((out) =>
    runBash(RESOLVE_E2E, {
      GITHUB_OUTPUT: out,
      GITHUB_EVENT_NAME: 'pull_request',
      FILTER_E2E_OUTCOME: 'failure',
      FILTER_E2E_RUN_E2E: 'false',
    }),
  );
  assert.equal(lines, 'run-e2e=true');
});

test('ci-paths-filter-resolve-e2e: empty raw on success outcome defaults run-e2e=true', () => {
  const { lines } = withGithubOutput((out) =>
    runBash(RESOLVE_E2E, {
      GITHUB_OUTPUT: out,
      GITHUB_EVENT_NAME: 'pull_request',
      FILTER_E2E_OUTCOME: 'success',
      FILTER_E2E_RUN_E2E: '',
    }),
  );
  assert.equal(lines, 'run-e2e=true');
});

test('ci-paths-filter-resolve-e2e: passes run-e2e=false through on PR', () => {
  const { lines } = withGithubOutput((out) =>
    runBash(RESOLVE_E2E, {
      GITHUB_OUTPUT: out,
      GITHUB_EVENT_NAME: 'pull_request',
      FILTER_E2E_OUTCOME: 'success',
      FILTER_E2E_RUN_E2E: 'false',
    }),
  );
  assert.equal(lines, 'run-e2e=false');
});

test('ci-paths-filter-resolve-e2e: passes run-e2e=true through on PR', () => {
  const { lines } = withGithubOutput((out) =>
    runBash(RESOLVE_E2E, {
      GITHUB_OUTPUT: out,
      GITHUB_EVENT_NAME: 'pull_request',
      FILTER_E2E_OUTCOME: 'success',
      FILTER_E2E_RUN_E2E: 'true',
    }),
  );
  assert.equal(lines, 'run-e2e=true');
});

for (const ev of ['merge_group', 'push', 'workflow_dispatch']) {
  test(`ci-paths-filter-resolve-e2e: ${ev} forces run-e2e=true`, () => {
    const { lines } = withGithubOutput((out) =>
      runBash(RESOLVE_E2E, {
        GITHUB_OUTPUT: out,
        GITHUB_EVENT_NAME: ev,
        FILTER_E2E_OUTCOME: 'failure',
        FILTER_E2E_RUN_E2E: 'false',
      }),
    );
    assert.equal(lines, 'run-e2e=true');
  });
}

test('ci-paths-filter-resolve-e2e: mutant default run-e2e=false on filter fail is killed', () => {
  const prod = withGithubOutput((out) =>
    runBash(RESOLVE_E2E, {
      GITHUB_OUTPUT: out,
      GITHUB_EVENT_NAME: 'pull_request',
      FILTER_E2E_OUTCOME: 'failure',
      FILTER_E2E_RUN_E2E: 'false',
    }),
  );
  assert.equal(prod.lines, 'run-e2e=true');
  const src = fs.readFileSync(RESOLVE_E2E, 'utf8');
  const mutant = src.replace(
    'if [ "$outcome" != "success" ] || [ -z "$raw" ]; then\n  echo "paths-filter run-e2e step did not produce a valid value — defaulting run-e2e=true (fail-safe)." >&2\n  github_out "run-e2e=true"',
    'if [ "$outcome" != "success" ] || [ -z "$raw" ]; then\n  echo "paths-filter run-e2e step did not produce a valid value — defaulting run-e2e=false (fail-safe)." >&2\n  github_out "run-e2e=false"',
  );
  const broken = withGithubOutput((out) =>
    runMutantScript(mutant, {
      GITHUB_OUTPUT: out,
      GITHUB_EVENT_NAME: 'pull_request',
      FILTER_E2E_OUTCOME: 'failure',
      FILTER_E2E_RUN_E2E: 'false',
    }),
  );
  assert.equal(broken.lines, 'run-e2e=false');
  assert.notEqual(prod.lines, broken.lines);
});