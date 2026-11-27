#!/usr/bin/env node
/**
 * Pins the shape of the oracle-sweeps job in ci.yml. Loaded from workflow-rules.test.js so CI
 * runs it in `unit`. Uses js-yaml (transitive dependency; fails closed if it disappears).
 *
 * Run: node .github/scripts/oracle-sweeps-workflow.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const { SHARD_COUNT } = require('./oracle-shard.js');

const REPO = path.resolve(__dirname, '..', '..');
const CHECK_STEP = 'Check this shard ran exactly its files';
const VERIFY_STEP = 'Verify the shard plan covers every oracle-sweep file';

function loadCi() {
  return yaml.load(fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8'));
}

/** Returns a list of problems; empty means the workflow shape is right. */
function checkOracleSweepsWorkflow(doc) {
  const problems = [];
  const job = doc.jobs && doc.jobs['oracle-sweeps'];
  if (!job) return ['ci.yml has no oracle-sweeps job'];
  const shards = job.strategy && job.strategy.matrix && job.strategy.matrix.shard;
  const want = Array.from({ length: SHARD_COUNT }, (_, i) => i + 1);
  if (JSON.stringify(shards) !== JSON.stringify(want)) {
    problems.push(`matrix.shard must be ${JSON.stringify(want)} (planner SHARD_COUNT=${SHARD_COUNT}), got ${JSON.stringify(shards)}`);
  }
  if (job.name !== `oracle-sweeps (\${{ matrix.shard }}/${SHARD_COUNT})`) problems.push(`job name must stay "oracle-sweeps (n/${SHARD_COUNT})", got ${job.name}`);
  const needs = doc.jobs.ci && doc.jobs.ci.needs;
  if (!Array.isArray(needs) || !needs.includes('oracle-sweeps')) problems.push('the ci aggregator must need oracle-sweeps');
  if (job['continue-on-error'] !== undefined) problems.push('oracle-sweeps must not set continue-on-error');
  if (job.if !== undefined) problems.push('oracle-sweeps must not have an if:');
  const steps = job.steps || [];
  for (const step of steps) {
    if (step['continue-on-error'] !== undefined) problems.push(`step "${step.name}" must not set continue-on-error`);
  }
  const byName = (n) => steps.find((s) => s.name === n);
  const verify = byName(VERIFY_STEP);
  const check = byName(CHECK_STEP);
  const sweep = steps.find((s) => String(s.run || '').includes('vitest run'));
  if (!verify) problems.push(`missing step "${VERIFY_STEP}"`);
  else if (verify.shell !== 'bash') problems.push(`step "${VERIFY_STEP}" needs shell: bash`);
  if (!sweep) problems.push('missing the vitest run step');
  else {
    if (sweep.shell !== 'bash') problems.push('the vitest run step needs shell: bash (pipefail)');
    if (!/oracle-shard\.js --shard/.test(sweep.run)) problems.push('the vitest run step must take its files from oracle-shard.js --shard');
    if (!/-gt 0|-n "\$files"/.test(sweep.run)) problems.push('the vitest run step must fail when the planner returns no files');
    if (/<\(node /.test(sweep.run)) problems.push('the vitest run step must not read planner output through process substitution (hides a crash)');
  }
  if (!check) problems.push(`missing step "${CHECK_STEP}"`);
  else {
    // The default shell is `bash -e` with no pipefail, so `| tee` hides a failing check.
    if (check.shell !== 'bash') problems.push(`step "${CHECK_STEP}" needs shell: bash so a failing check through | tee still fails`);
    if (check.if !== undefined) problems.push(`step "${CHECK_STEP}" must not have an if:`);
    if (!/--check-run/.test(check.run || '')) problems.push(`step "${CHECK_STEP}" must run --check-run`);
  }
  if (verify && check && sweep && !(steps.indexOf(verify) < steps.indexOf(sweep) && steps.indexOf(sweep) < steps.indexOf(check))) {
    problems.push('step order must be verify, run, check');
  }
  return problems;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
function mutate(fn) {
  const doc = clone(loadCi());
  fn(doc, doc.jobs['oracle-sweeps']);
  return checkOracleSweepsWorkflow(doc);
}
const stepOf = (job, name) => job.steps.find((s) => s.name === name);

test('ci.yml oracle-sweeps job has the required shape', () => {
  assert.deepEqual(checkOracleSweepsWorkflow(loadCi()), []);
});

test('the shape check fails on the bad forms (self-test)', () => {
  const cases = {
    'check step without shell: bash (pipe into tee hides failure)': (d, j) => { delete stepOf(j, CHECK_STEP).shell; },
    'check step gated by if: always()': (d, j) => { stepOf(j, CHECK_STEP).if = 'always()'; },
    'check step removed': (d, j) => { j.steps = j.steps.filter((s) => s.name !== CHECK_STEP); },
    'continue-on-error on the sweep': (d, j) => { j.steps.find((s) => String(s.run || '').includes('vitest run'))['continue-on-error'] = true; },
    'oracle-sweeps dropped from ci.needs': (d) => { d.jobs.ci.needs = d.jobs.ci.needs.filter((n) => n !== 'oracle-sweeps'); },
    'matrix shrunk to one shard': (d, j) => { j.strategy.matrix.shard = [1]; },
    'matrix grew beyond the planner SHARD_COUNT': (d, j) => { j.strategy.matrix.shard = [...j.strategy.matrix.shard, j.strategy.matrix.shard.length + 1]; },
    'sweep reads planner through process substitution': (d, j) => {
      const s = j.steps.find((x) => String(x.run || '').includes('vitest run'));
      s.run = s.run.replace('files=$(node', 'mapfile -t FILES < <(node');
    },
    'sweep without a non-empty files guard': (d, j) => {
      const s = j.steps.find((x) => String(x.run || '').includes('vitest run'));
      s.run = s.run.replace(/\[ -n "\$flags" \][^\n]*\n/, '');
    },
  };
  for (const [name, fn] of Object.entries(cases)) {
    assert.notDeepEqual(mutate(fn), [], `bad form not caught: ${name}`);
  }
});

module.exports = { checkOracleSweepsWorkflow };
