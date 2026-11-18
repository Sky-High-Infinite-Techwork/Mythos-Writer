#!/usr/bin/env node
/**
 * Uses js-yaml, which is only a transitive dependency (package-lock `node_modules/js-yaml`); if it disappears this test fails closed (red). js-yaml keeps `on` as a string key; a PyYAML reader must use `doc.get('on', doc.get(True))`.
 *
 * Run: node .github/scripts/workflow-rules.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const REPO = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(REPO, '.github', 'workflows');

function loadWorkflow(name) {
  const full = path.join(WORKFLOWS, name);
  return yaml.load(fs.readFileSync(full, 'utf8'));
}

function triggerOf(doc) {
  if (doc && Object.prototype.hasOwnProperty.call(doc, 'on')) return doc.on;
  if (doc && Object.prototype.hasOwnProperty.call(doc, true)) return doc[true];
  return undefined;
}

function workflowNames() {
  return fs.readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
}

function deletedWorkflows() {
  const root = '.github/workflows/';
  return [
    root + 'mythos-' + 'token-' + 'audit.yml',
    root + 'vr-' + 'baselines.yml',
    root + 'mythos-' + 'standing-' + 'context-' + 'compress.yml',
    root + 'issue-' + 'finder.yml',
  ];
}

test('ci pull_request branches are main and batch/**', () => {
  const on = triggerOf(loadWorkflow('ci.yml'));
  assert.deepEqual(on.pull_request.branches, ['main', 'batch/**']);
});

test('ci push branches stay main', () => {
  const on = triggerOf(loadWorkflow('ci.yml'));
  assert.deepEqual(on.push.branches, ['main']);
});

// Merge queue: every workflow that reports a check required on main must also run on merge_group,
// or a queued PR waits for a check that never reports. ci and screenshot-check are those checks
// (notes-windows and contracts are jobs in ci.yml). Privileged unattended workflows stay off merge_group.
const MERGE_GROUP_WORKFLOWS = ['ci.yml', 'screenshot-check.yml'];

test('merge_group is limited to required check workflows (ci, screenshot-check)', () => {
  for (const name of workflowNames()) {
    const on = triggerOf(loadWorkflow(name)) || {};
    const expected = MERGE_GROUP_WORKFLOWS.includes(name);
    assert.equal(JSON.stringify(on).includes('merge_group'), expected, name);
  }
});

test('merge_group triggers use checks_requested only', () => {
  for (const name of MERGE_GROUP_WORKFLOWS) {
    const on = triggerOf(loadWorkflow(name));
    assert.deepEqual(on.merge_group, { types: ['checks_requested'] }, name);
  }
});

test('packaging jobs skip merge_group like pull_request', () => {
  const jobs = loadWorkflow('ci.yml').jobs;
  for (const job of ['build-linux', 'build-windows']) {
    assert.match(jobs[job].if, /github\.event_name != 'pull_request'/, job);
    assert.match(jobs[job].if, /github\.event_name != 'merge_group'/, job);
  }
});

test('screenshot-check passes on a merge_group run without a PR payload', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'screenshot-check.yml'), 'utf8');
  const guard = text.indexOf("context.eventName === 'merge_group'");
  const prRead = text.indexOf('context.payload.pull_request');
  assert.ok(guard > -1 && guard < prRead, 'merge_group early return comes before the PR payload is read');
});

test('ci needs includes diff-guard and tier1-gate', () => {
  const doc = loadWorkflow('ci.yml');
  assert.ok(doc.jobs.ci.needs.includes('diff-guard'));
  assert.ok(doc.jobs.ci.needs.includes('tier1-gate'));
});

test('ci aggregator tier1 includes needs.diff-guard.result (not oracle-sweeps)', () => {
  const doc = loadWorkflow('ci.yml');
  const step = doc.jobs.ci.steps.find((s) => String(s.run || '').includes('ci-aggregator.sh'));
  assert.ok(step, 'ci aggregator step');
  assert.match(step.run, /ci-aggregator\.sh/);
  assert.equal(step.env.NEEDS_DIFF_GUARD_RESULT, '${{ needs.diff-guard.result }}');
  assert.ok(step.env.NEEDS_TIER1_GATE_RESULT);
  assert.ok(step.env.NEEDS_ORACLE_SWEEPS_RESULT);
  const agg = fs.readFileSync(path.join(REPO, '.github', 'scripts', 'ci-aggregator.sh'), 'utf8');
  assert.match(agg, /NEEDS_DIFF_GUARD_RESULT/);
  const tier1Loop = agg.match(/Tier 1 \(lint[\s\S]*?^done/m) || [''];
  assert.doesNotMatch(tier1Loop[0], /oracle/i);
});

const TIER1_JOBS = ['lint', 'typecheck', 'unit', 'diff-guard', 'paths-filter', 'contracts'];
const TIER2_JOBS = ['oracle-sweeps', 'build-electron', 'notes-windows', 'build-linux', 'build-windows'];

const FORBIDDEN_TIER2_IF = /\b(always|cancelled|failure)\s*\(\s*\)/;

test('mythos-automation-contracts is workflow_call only (no duplicate PR runs)', () => {
  const doc = loadWorkflow('mythos-automation-contracts.yml');
  const on = triggerOf(doc) || {};
  assert.deepEqual(Object.keys(on).sort(), ['workflow_call']);
  const ci = loadWorkflow('ci.yml');
  assert.ok(ci.jobs.contracts && ci.jobs.contracts.uses, 'ci.yml calls contracts reusable workflow');
  assert.match(ci.jobs.contracts.uses, /mythos-automation-contracts\.yml$/);
  assert.deepEqual(ci.jobs.contracts.permissions, { contents: 'read' });
  const contractsYaml = fs.readFileSync(path.join(WORKFLOWS, 'mythos-automation-contracts.yml'), 'utf8');
  assert.equal(contractsYaml.includes('secrets.'), false);
  assert.equal(JSON.stringify(ci.jobs.contracts).includes('secrets'), false);
});

test('tier1-gate needs every Tier 1 job plus setup', () => {
  const doc = loadWorkflow('ci.yml');
  const gate = doc.jobs['tier1-gate'];
  assert.ok(gate, 'tier1-gate job');
  assert.equal(gate.if, 'always()');
  for (const job of ['setup', ...TIER1_JOBS]) {
    assert.ok(gate.needs.includes(job), `tier1-gate needs ${job}`);
  }
  const gateStep = gate.steps.find((step) => String(step.run || '').includes('ci-tier1-gate.sh'));
  assert.ok(gateStep, 'tier1-gate bash step');
  const envBlob = JSON.stringify(gateStep.env || {});
  for (const job of ['setup', ...TIER1_JOBS]) {
    assert.ok(envBlob.includes(`needs.${job}.result`), `tier1-gate env references needs.${job}.result`);
  }
});

test('Tier 2 jobs need tier1-gate (not setup alone)', () => {
  const jobs = loadWorkflow('ci.yml').jobs;
  for (const job of TIER2_JOBS) {
    assert.ok(jobs[job].needs.includes('tier1-gate'), job);
    assert.equal(jobs[job].needs.includes('setup'), false, `${job} must not depend on setup without tier1-gate`);
  }
  for (const job of ['e2e-shard-1', 'e2e-shard-2', 'e2e-shard-3', 'e2e-shard-4']) {
    assert.ok(jobs[job].needs.includes('build-electron'), job);
    assert.ok(jobs[job].needs.includes('paths-filter'), job);
  }
});

test('notes-windows fails closed when tier1-gate is not success', () => {
  const job = loadWorkflow('ci.yml').jobs['notes-windows'];
  assert.equal(job.if, '${{ !cancelled() }}');
  assert.match(
    job['runs-on'],
    /needs\.tier1-gate\.result == 'success' && 'windows-latest' \|\| 'ubuntu-latest'/,
  );
  const gate = job.steps[0];
  assert.match(gate.name, /Tier 1/i);
  assert.equal(gate.if, 'always()');
  assert.notEqual(gate['continue-on-error'], true);
  assert.match(String(gate.run), /exit 1/);
  assert.match(String(gate.run), /needs\.tier1-gate\.result/);
});

test('Tier 2 jobs except notes-windows have no always/cancelled/failure job if', () => {
  const jobs = loadWorkflow('ci.yml').jobs;
  const e2e = ['e2e-shard-1', 'e2e-shard-2', 'e2e-shard-3', 'e2e-shard-4'];
  for (const job of [...TIER2_JOBS.filter((j) => j !== 'notes-windows'), ...e2e]) {
    const cond = jobs[job].if;
    if (cond == null || cond === '') continue;
    assert.equal(FORBIDDEN_TIER2_IF.test(cond), false, `${job} if: ${cond}`);
  }
});

test('e2e shards run on merge_group regardless of paths-filter', () => {
  const jobs = loadWorkflow('ci.yml').jobs;
  const mergeGroupClause = /\|\|\s*github\.event_name == 'merge_group'/;
  for (const job of ['e2e-shard-1', 'e2e-shard-2', 'e2e-shard-3', 'e2e-shard-4']) {
    assert.match(jobs[job].if, mergeGroupClause, job);
    const matches = String(jobs[job].if).match(/\|\|\s*github\.event_name == 'merge_group'/g) || [];
    assert.equal(matches.length, 1, `${job} must not duplicate merge_group clause`);
  }
});

const PATHS_FILTER_PIN = 'ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d';

test('paths-filter pins dorny/paths-filter to v4.0.3 commit SHA', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8');
  assert.match(text, new RegExp(`dorny/paths-filter@${PATHS_FILTER_PIN} # v4\\.0\\.3`));
  assert.equal((text.match(new RegExp(PATHS_FILTER_PIN, 'g')) || []).length, 2);
});

test('paths-filter resolve steps call extracted bash scripts with env (not inline ${{ }})', () => {
  const steps = loadWorkflow('ci.yml').jobs['paths-filter'].steps;
  const resolveDocs = steps.find((step) => step.id === 'resolve-docs');
  const resolveE2e = steps.find((step) => step.id === 'resolve-e2e');
  assert.match(resolveDocs.run, /ci-paths-filter-resolve-docs\.sh/);
  assert.match(resolveE2e.run, /ci-paths-filter-resolve-e2e\.sh/);
  assert.equal(String(resolveDocs.run).includes('${{'), false);
  assert.equal(String(resolveE2e.run).includes('${{'), false);
  assert.ok(resolveDocs.env.FILTER_DOCS_OUTCOME);
  assert.ok(resolveE2e.env.FILTER_E2E_RUN_E2E);
  const docsRun = fs.readFileSync(path.join(REPO, '.github', 'scripts', 'ci-paths-filter-resolve-docs.sh'), 'utf8');
  const e2eRun = fs.readFileSync(path.join(REPO, '.github', 'scripts', 'ci-paths-filter-resolve-e2e.sh'), 'utf8');
  assert.match(docsRun, /FILTER_DOCS/);
  assert.match(docsRun, /false/);
  assert.match(e2eRun, /merge_group/);
  assert.match(e2eRun, /run-e2e=true/);
});

const CHECKOUT_PIN = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';

function bashScriptSteps(doc) {
  const hits = [];
  for (const [jobName, job] of Object.entries(doc.jobs || {})) {
    for (let i = 0; i < (job.steps || []).length; i++) {
      const run = String(job.steps[i].run || '');
      if (run.includes('bash .github/scripts/')) {
        hits.push({ jobName, index: i, step: job.steps[i] });
      }
    }
  }
  return hits;
}

test('tier1-gate and ci aggregator call extracted bash scripts', () => {
  const doc = loadWorkflow('ci.yml');
  const tierStep = doc.jobs['tier1-gate'].steps.find((step) =>
    String(step.run || '').includes('ci-tier1-gate.sh'),
  );
  const ciStep = doc.jobs.ci.steps.find((step) => String(step.run || '').includes('ci-aggregator.sh'));
  assert.ok(tierStep, 'tier1-gate script step');
  assert.ok(ciStep, 'ci aggregator script step');
  assert.match(tierStep.run, /ci-tier1-gate\.sh/);
  assert.match(ciStep.run, /ci-aggregator\.sh/);
  assert.ok(tierStep.env.NEEDS_TIER1_RESULTS);
  assert.ok(ciStep.env.NEEDS_ORACLE_SWEEPS_RESULT);
});

test('ci.yml gate scripts: env vars map to needs.*.result and paths-filter run-e2e', () => {
  const doc = loadWorkflow('ci.yml');
  const tierStep = doc.jobs['tier1-gate'].steps.find((s) =>
    String(s.run || '').includes('ci-tier1-gate.sh'),
  );
  const ciStep = doc.jobs.ci.steps.find((s) => String(s.run || '').includes('ci-aggregator.sh'));
  assert.ok(tierStep?.env, 'tier1-gate step env');
  assert.ok(ciStep?.env, 'ci aggregator step env');

  const tier1Jobs = ['setup', 'lint', 'typecheck', 'unit', 'diff-guard', 'paths-filter', 'contracts'];
  const tier1Blob = String(tierStep.env.NEEDS_TIER1_RESULTS);
  for (const job of tier1Jobs) {
    const escaped = job.replace(/-/g, '\\-');
    assert.match(
      tier1Blob,
      new RegExp(`\\$\\{\\{\\s*needs\\.${escaped}\\.result\\s*\\}\\}`),
      `NEEDS_TIER1_RESULTS must include needs.${job}.result`,
    );
  }

  const aggEnvMap = {
    NEEDS_TIER1_GATE_RESULT: '${{ needs.tier1-gate.result }}',
    NEEDS_LINT_RESULT: '${{ needs.lint.result }}',
    NEEDS_TYPECHECK_RESULT: '${{ needs.typecheck.result }}',
    NEEDS_UNIT_RESULT: '${{ needs.unit.result }}',
    NEEDS_DIFF_GUARD_RESULT: '${{ needs.diff-guard.result }}',
    NEEDS_ORACLE_SWEEPS_RESULT: '${{ needs.oracle-sweeps.result }}',
    NEEDS_E2E_SHARD_1_RESULT: '${{ needs.e2e-shard-1.result }}',
    NEEDS_E2E_SHARD_2_RESULT: '${{ needs.e2e-shard-2.result }}',
    NEEDS_E2E_SHARD_3_RESULT: '${{ needs.e2e-shard-3.result }}',
    NEEDS_E2E_SHARD_4_RESULT: '${{ needs.e2e-shard-4.result }}',
    PATHS_FILTER_RUN_E2E: '${{ needs.paths-filter.outputs.run-e2e }}',
    GITHUB_EVENT_NAME: '${{ github.event_name }}',
  };
  for (const [key, value] of Object.entries(aggEnvMap)) {
    assert.equal(ciStep.env[key], value, `ci step env ${key}`);
  }

  const pathsSteps = doc.jobs['paths-filter'].steps;
  const resolveDocs = pathsSteps.find((s) => s.id === 'resolve-docs');
  const resolveE2e = pathsSteps.find((s) => s.id === 'resolve-e2e');
  assert.equal(resolveDocs.env.FILTER_DOCS_OUTCOME, '${{ steps.filter-docs.outcome }}');
  assert.equal(resolveDocs.env.FILTER_DOCS_DOCS_ONLY, '${{ steps.filter-docs.outputs.docs-only }}');
  assert.equal(resolveE2e.env.FILTER_E2E_OUTCOME, '${{ steps.filter-e2e.outcome }}');
  assert.equal(resolveE2e.env.FILTER_E2E_RUN_E2E, '${{ steps.filter-e2e.outputs.run-e2e }}');
  assert.equal(resolveE2e.env.GITHUB_EVENT_NAME, '${{ github.event_name }}');
});

function checkoutBeforeScript(steps, scriptIndex) {
  for (let i = scriptIndex - 1; i >= 0; i--) {
    if (String(steps[i].uses || '').startsWith('actions/checkout')) return steps[i];
  }
  return null;
}

test('bash .github/scripts steps are preceded by sparse checkout of .github/scripts', () => {
  const doc = loadWorkflow('ci.yml');
  const sparseGateJobs = new Set(['tier1-gate', 'ci']);
  for (const hit of bashScriptSteps(doc)) {
    const steps = doc.jobs[hit.jobName].steps;
    const checkout = checkoutBeforeScript(steps, hit.index);
    assert.ok(checkout, `${hit.jobName}: checkout before bash script`);
    if (!sparseGateJobs.has(hit.jobName)) continue;
    assert.equal(steps[hit.index - 1].uses, CHECKOUT_PIN, hit.jobName);
    assert.equal(checkout.with['persist-credentials'], false, hit.jobName);
    assert.equal(checkout.with['sparse-checkout-cone-mode'], true, hit.jobName);
    const sparse = checkout.with['sparse-checkout'];
    assert.ok(
      sparse === '.github/scripts' || (Array.isArray(sparse) && sparse.includes('.github/scripts')),
      hit.jobName,
    );
  }
});

test('ci aggregator regression: e2e skip logic lives in ci-aggregator.sh', () => {
  const agg = fs.readFileSync(path.join(REPO, '.github', 'scripts', 'ci-aggregator.sh'), 'utf8');
  assert.match(agg, /require_e2e/);
  assert.match(agg, /merge_group/);
  assert.match(agg, /PATHS_FILTER_RUN_E2E/);
  assert.doesNotMatch(
    agg,
    /skipped_count/,
    'old partial-skip guard must not replace all-shards-required when e2e is mandatory',
  );
});

test('ci concurrency cancels in-progress only for pull_request (not merge_group)', () => {
  const doc = loadWorkflow('ci.yml');
  const cancel = doc.concurrency['cancel-in-progress'];
  assert.match(String(cancel), /github\.event_name == 'pull_request'/);
  assert.doesNotMatch(String(cancel), /merge_group/);
});

const REQUIRED_CHECK_JOB_NAMES = ['ci', 'notes-windows'];

test('required ci.yml check job names are unchanged', () => {
  const jobs = loadWorkflow('ci.yml').jobs;
  for (const name of REQUIRED_CHECK_JOB_NAMES) {
    assert.ok(jobs[name], name);
    assert.equal((jobs[name].name ?? name) === name, true, `job id ${name} must match displayed check name`);
  }
});

test('draft-ready-on-green is retired so hygiene cannot undraft', () => {
  const doc = loadWorkflow('mythos-pr-hygiene.yml');
  assert.equal(doc.jobs['draft-ready-on-green'], undefined);
  const text = fs.readFileSync(path.join(WORKFLOWS, 'mythos-pr-hygiene.yml'), 'utf8');
  assert.equal(text.includes('gh pr ready'), false);
  assert.ok(doc.jobs['draft-ci-comment']);
});

test('ops health is quarterly secrets-rotation only', () => {
  const doc = loadWorkflow('mythos-ops-health.yml');
  assert.deepEqual(Object.keys(doc.jobs), ['secrets-rotation']);
  const dispatch = triggerOf(doc).workflow_dispatch;
  assert.ok(dispatch == null || dispatch.inputs == null);
  assert.deepEqual(doc.permissions, { issues: 'write' });
});

test('diff-guard permissions are contents read', () => {
  const doc = loadWorkflow('ci.yml');
  assert.deepEqual(doc.jobs['diff-guard'].permissions, { contents: 'read' });
});

function checkoutSteps(file, jobName) {
  return loadWorkflow(file).jobs[jobName].steps.filter((step) => String(step.uses || '').startsWith('actions/checkout'));
}

test('diff-guard and carve-out checkouts do not persist credentials', () => {
  for (const [file, jobName] of [['ci.yml', 'diff-guard'], ['carve-out-check.yml', 'carve-out-check']]) {
    const checkouts = checkoutSteps(file, jobName);
    assert.ok(checkouts.length >= 1, file);
    for (const step of checkouts) {
      assert.equal(step.with['persist-credentials'], false, file);
    }
  }
});

test('diff-guard steps do not name secrets in env', () => {
  const steps = loadWorkflow('ci.yml').jobs['diff-guard'].steps;
  for (const step of steps) {
    assert.equal(JSON.stringify(step.env || {}).includes('secrets.'), false);
  }
});

test('no workflow uses pull_request_target', () => {
  for (const name of workflowNames()) {
    const text = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
    assert.equal(text.includes('pull_request_target'), false, name);
  }
});

test('carve-out-check checks out the PR head and can create a label', () => {
  const doc = loadWorkflow('carve-out-check.yml');
  const checkout = checkoutSteps('carve-out-check.yml', 'carve-out-check')[0];
  assert.equal(checkout.with.ref, 'refs/pull/${{ github.event.pull_request.number }}/head');
  assert.equal(doc.permissions.issues, 'write');
  assert.equal(doc.permissions['pull-requests'], 'write');
  assert.equal(doc.permissions.contents, 'read');
});

test('carve-out-check loads migration-flag from the base ref and skips when it is absent', () => {
  const doc = loadWorkflow('carve-out-check.yml');
  const on = triggerOf(doc);
  assert.ok(on.pull_request);
  assert.equal(JSON.stringify(on).includes('pull_request_target'), false);
  assert.deepEqual(Object.keys(doc.permissions).sort(), ['contents', 'issues', 'pull-requests']);
  assert.equal(doc.permissions.contents, 'read');

  const steps = doc.jobs['carve-out-check'].steps;
  const rmAt = steps.findIndex((step) => String(step.run || '').includes('rm -rf trusted-base'));
  const checkouts = steps.filter((step) => String(step.uses || '').startsWith('actions/checkout'));
  assert.equal(checkouts.length, 2);
  const trusted = checkouts[1];
  const trustedAt = steps.indexOf(trusted);
  assert.ok(rmAt >= 0, 'clear step');
  assert.ok(trustedAt > rmAt);
  assert.equal(trusted.with.ref, '${{ github.event.pull_request.base.sha }}');
  assert.equal(trusted.with.path, 'trusted-base');
  assert.equal(trusted.with['persist-credentials'], false);
  assert.equal(trusted.with['sparse-checkout-cone-mode'], false);
  assert.match(String(trusted.with['sparse-checkout']), /^\.github\/scripts\/migration-flag\.js$/);

  const script = steps.map((step) => (step.with && step.with.script) || '').join('\n');
  assert.match(script, /trusted-base\/\.github\/scripts\/migration-flag\.js/);
  assert.equal(script.includes("GITHUB_WORKSPACE + '/.github/scripts/migration-flag.js'"), false);
  assert.match(script, /skipping the migration label step/);
  assert.match(script, /if \(!migrationFlag\) return/);
  assert.match(script, /fs\.existsSync\(flagPath\)/);
});

test('deleted workflows are absent', () => {
  for (const rel of deletedWorkflows()) {
    assert.equal(fs.existsSync(path.join(REPO, rel)), false, rel);
  }
});

// batch-automerge.yml rules and run-step behavior (kept in its own file; loaded here so CI runs it).
require('./batch-automerge.test.js');
// ci-tier1-gate / ci-aggregator bash scenarios (same scripts as ci.yml).
require('./ci-gate-scripts.test.js');
// Phase 1 unattended controller and workflow contracts. Loaded here so CI runs it.
require('./unattended.test.js');
