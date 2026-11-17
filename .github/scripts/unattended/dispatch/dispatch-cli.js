'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REPO, CANARY_SCRATCH_SHARED_REF } = require('./constants');
const { OID_HEX, UPDATE_REFS_REF_EXISTS } = require('./refs-graphql');
const { createDispatchClients } = require('./dispatch-client');
const { runDispatchPlan } = require('./dispatch-run');
const { sweepDispatchRefs } = require('./claim');
const { readDispatchSwitches, actWritesEnabled } = require('./switch');
const { activeClaimsFromRefs } = require('./dispatch-helpers');

function writeCanaryOutcome(payload) {
  const target = process.env.CANARY_OUTCOME_PATH;
  if (!target) return;
  fs.writeFileSync(target, `${JSON.stringify(payload)}\n`, 'utf8');
}

function readCanaryOutcomesFromDir(dir) {
  const outcomes = [];
  if (!dir || !fs.existsSync(dir)) return outcomes;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    try {
      outcomes.push(JSON.parse(fs.readFileSync(full, 'utf8')));
    } catch {
      return null;
    }
  }
  return outcomes;
}

async function main() {
  const command = process.argv[2] || 'plan';
  const repo = process.env.REPO || REPO;
  const readToken = process.env.READ_TOKEN || process.env.GITHUB_TOKEN || '';
  const writeToken = process.env.WRITE_TOKEN || '';
  const controlToken = process.env.CONTROL_TOKEN || '';
  const { combined: client } = createDispatchClients({
    repo,
    readToken,
    writeToken,
  });

  const reReadSwitch = async () => readDispatchSwitches(repo, controlToken);

  if (command === 'sweep') {
    const switches = await reReadSwitch();
    if (!actWritesEnabled(switches)) {
      console.log('sweep: inert');
      return 0;
    }
    const result = await sweepDispatchRefs(client, { reReadSwitch });
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
    if (!actWritesEnabled(switches)) {
      console.log(JSON.stringify({ kind: 'canary_inert', index }));
      writeCanaryOutcome({ kind: 'canary_inert', index });
      return 0;
    }
    const sw2 = await reReadSwitch();
    if (!actWritesEnabled(sw2)) {
      console.log(JSON.stringify({ kind: 'canary_abort', index, reason: 'switch_flipped' }));
      writeCanaryOutcome({ kind: 'canary_abort', index, reason: 'switch_flipped' });
      return 0;
    }
    const ref = CANARY_SCRATCH_SHARED_REF;
    const result = await client.createRef({ ref, sha });
    if (result.ok) {
      console.log(JSON.stringify({ kind: 'canary_win', index, status: 201 }));
      writeCanaryOutcome({ kind: 'canary_win', index });
      return 0;
    }
    if (result.refExists) {
      console.log(JSON.stringify({
        kind: 'canary_lose',
        index,
        errors: result.errors || [{ message: UPDATE_REFS_REF_EXISTS }],
      }));
      writeCanaryOutcome({ kind: 'canary_lose', index });
      return 0;
    }
    console.error(JSON.stringify({ kind: 'canary_fatal', index, errors: result.errors, error: result.error }));
    writeCanaryOutcome({ kind: 'canary_fatal', index, errors: result.errors });
    return 1;
  }

  if (command === 'canary-verify') {
    const switches = await reReadSwitch();
    if (!actWritesEnabled(switches)) {
      console.log(JSON.stringify({ kind: 'canary_verify_inert' }));
      return 0;
    }

    const artifactsDir = process.env.CANARY_ARTIFACTS_DIR || '';
    const outcomes = readCanaryOutcomesFromDir(artifactsDir);
    if (artifactsDir) {
      if (outcomes === null) {
        console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'artifact_parse' }));
        return 1;
      }
      const wins = outcomes.filter((o) => o.kind === 'canary_win').length;
      const loses = outcomes.filter((o) => o.kind === 'canary_lose').length;
      const fatals = outcomes.filter((o) => o.kind === 'canary_fatal').length;
      if (wins !== 1 || loses !== 5 || fatals !== 0) {
        console.error(JSON.stringify({ kind: 'canary_verify_fail', wins, loses, fatals, total: outcomes.length }));
        return 1;
      }
    }

    const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/canary/' });
    if (!listed.ok) {
      console.error('canary-verify: list failed');
      return 1;
    }
    const scratch = (listed.refs || []).filter((r) => r.ref === CANARY_SCRATCH_SHARED_REF);
    if (scratch.length !== 1) {
      console.error(JSON.stringify({ kind: 'canary_verify_fail', count: scratch.length }));
      return 1;
    }
    const row = scratch[0];
    const mainSha = process.env.MAIN_SHA || '';
    if (!OID_HEX.test(mainSha) || row.sha !== mainSha) {
      console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'main_sha_mismatch', refSha: row.sha }));
      return 1;
    }
    const sw2 = await reReadSwitch();
    if (!actWritesEnabled(sw2)) {
      console.error('canary-verify: switch off before delete');
      return 1;
    }
    const del = await client.deleteRef({ ref: row.ref, beforeOid: row.sha });
    if (!del.ok) {
      console.error(JSON.stringify({ kind: 'canary_verify_delete_fail', error: del.error }));
      return 1;
    }
    console.log(JSON.stringify({ kind: 'canary_verify_ok', deleted: row.ref }));
    return 0;
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
    return runDispatchPlan(env);
  }

  console.error(`unknown command: ${command}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });