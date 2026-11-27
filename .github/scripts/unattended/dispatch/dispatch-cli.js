'use strict';

const fs = require('node:fs');

const { REPO, canaryScratchRef } = require('./constants');
const { OID_HEX } = require('./refs-graphql');
const { createDispatchClients } = require('./dispatch-client');
const { runDispatchPlan } = require('./dispatch-run');
const { sweepDispatchRefs } = require('./claim');
const { readDispatchSwitches, actWritesEnabled } = require('./switch');
const { activeClaimsFromRefs } = require('./dispatch-helpers');
const { runCanaryVerify } = require('./canary-verify');

function parseGithubRunIds() {
  const runId = Number.parseInt(process.env.GITHUB_RUN_ID || '', 10);
  const runAttempt = Number.parseInt(process.env.GITHUB_RUN_ATTEMPT || '1', 10);
  if (!Number.isInteger(runId) || runId < 1) return { ok: false, reason: 'bad_run_id' };
  if (!Number.isInteger(runAttempt) || runAttempt < 1) return { ok: false, reason: 'bad_run_attempt' };
  return { ok: true, runId, runAttempt, scratchRef: canaryScratchRef(runId, runAttempt) };
}

const CANARY_OUTCOME_KEYS = ['kind', 'index', 'runId', 'runAttempt', 'scratchRef', 'reason'];
const STABLE_WRITE_REASONS = new Set([
  'switch_off',
  'switch_read',
  'switch_flipped',
  'no_write_token',
  'repo_node_id',
]);

function allowlistedCanaryOutcome(payload) {
  const out = {};
  for (const key of CANARY_OUTCOME_KEYS) {
    if (payload[key] !== undefined && payload[key] !== null) out[key] = payload[key];
  }
  return out;
}

function stableCanaryWriteReason(result) {
  const err = result && typeof result.error === 'string' ? result.error : '';
  if (STABLE_WRITE_REASONS.has(err)) return err;
  return 'write_failed';
}

function writeCanaryOutcome(payload) {
  const target = process.env.CANARY_OUTCOME_PATH;
  if (!target) return;
  const ids = parseGithubRunIds();
  if (!ids.ok) return;
  fs.writeFileSync(
    target,
    `${JSON.stringify(allowlistedCanaryOutcome({
      runId: ids.runId,
      runAttempt: ids.runAttempt,
      scratchRef: ids.scratchRef,
      ...payload,
    }))}\n`,
    'utf8',
  );
}

async function main(options = {}) {
  const {
    readDispatchSwitchesFn = readDispatchSwitches,
    actWritesEnabledFn = actWritesEnabled,
    createDispatchClientsFn = createDispatchClients,
    runDispatchPlanFn = runDispatchPlan,
    sweepDispatchRefsFn = sweepDispatchRefs,
    runCanaryVerifyFn = runCanaryVerify,
  } = options;
  const command = process.argv[2] || 'plan';
  const repo = process.env.REPO || REPO;
  const readToken = process.env.READ_TOKEN || process.env.GITHUB_TOKEN || '';
  const writeToken = process.env.WRITE_TOKEN || '';
  const controlToken = process.env.CONTROL_TOKEN || '';
  const reReadSwitch = async () => readDispatchSwitchesFn(repo, controlToken);
  const { combined: client } = createDispatchClientsFn({
    repo,
    readToken,
    writeToken,
    reReadSwitch,
    actWritesEnabledFn,
  });
  if (!client) {
    console.error('dispatch: invalid repo');
    return 1;
  }

  if (command === 'sweep') {
    const switches = await reReadSwitch();
    if (!switches.ok) {
      console.error('sweep: switch read failed');
      return 1;
    }
    if (!actWritesEnabledFn(switches)) {
      console.log('sweep: inert');
      return 0;
    }
    const result = await sweepDispatchRefsFn(client, { reReadSwitch });
    console.log(JSON.stringify({ kind: 'sweep', ...result }));
    return result.ok ? 0 : 1;
  }

  if (command === 'canary-ref') {
    const index = process.env.CANARY_INDEX;
    const sha = process.env.MAIN_SHA || '';
    if (!OID_HEX.test(sha)) {
      console.error('canary: MAIN_SHA must be 40 hex');
      writeCanaryOutcome({ kind: 'canary_fatal', index, reason: 'bad_main_sha' });
      return 1;
    }
    const switches = await reReadSwitch();
    if (!switches.ok) {
      console.error('canary: switch read failed');
      writeCanaryOutcome({ kind: 'canary_fatal', index, reason: 'switch_read' });
      return 1;
    }
    if (!actWritesEnabledFn(switches)) {
      console.log(JSON.stringify({ kind: 'canary_inert', index }));
      writeCanaryOutcome({ kind: 'canary_inert', index });
      return 0;
    }
    const sw2 = await reReadSwitch();
    if (!sw2 || !sw2.ok) {
      console.error('canary: switch re-read failed');
      writeCanaryOutcome({ kind: 'canary_fatal', index, reason: 'switch_read' });
      return 1;
    }
    if (!actWritesEnabledFn(sw2)) {
      console.log(JSON.stringify({ kind: 'canary_abort', index, reason: 'switch_flipped' }));
      writeCanaryOutcome({ kind: 'canary_abort', index, reason: 'switch_flipped' });
      return 0;
    }
    const ids = parseGithubRunIds();
    if (!ids.ok) {
      console.error(`canary: ${ids.reason}`);
      writeCanaryOutcome({ kind: 'canary_fatal', index, reason: ids.reason });
      return 1;
    }
    const ref = ids.scratchRef;
    const result = await client.createRef({ ref, sha });
    if (result.ok) {
      console.log(JSON.stringify({ kind: 'canary_win', index, status: 201 }));
      writeCanaryOutcome({ kind: 'canary_win', index });
      return 0;
    }
    if (result.refExists) {
      console.log(JSON.stringify(allowlistedCanaryOutcome({ kind: 'canary_lose', index })));
      writeCanaryOutcome({ kind: 'canary_lose', index });
      return 0;
    }
    const reason = stableCanaryWriteReason(result);
    console.error(JSON.stringify(allowlistedCanaryOutcome({ kind: 'canary_fatal', index, reason })));
    writeCanaryOutcome({ kind: 'canary_fatal', index, reason });
    return 1;
  }

  if (command === 'canary-verify') {
    return runCanaryVerifyFn(client, {
      reReadSwitch,
      mainSha: process.env.MAIN_SHA || '',
      artifactsDir: process.env.CANARY_ARTIFACTS_DIR || '',
      runId: process.env.GITHUB_RUN_ID || '0',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    });
  }

  if (command === 'plan') {
    const env = {
      MODE: process.env.MODE,
      REPO: repo,
      CONTROL_TOKEN: controlToken,
      RUN_ID: parseInt(process.env.GITHUB_RUN_ID || '0', 10),
      RUN_ATTEMPT: parseInt(process.env.GITHUB_RUN_ATTEMPT || '1', 10),
      MAIN_SHA: process.env.MAIN_SHA || '',
      client,
      activeClaimsFromRefs: (refs) => activeClaimsFromRefs(refs),
    };
    return runDispatchPlanFn(env);
  }

  console.error(`unknown command: ${command}`);
  return 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { main, writeCanaryOutcome, allowlistedCanaryOutcome, stableCanaryWriteReason, CANARY_OUTCOME_KEYS };