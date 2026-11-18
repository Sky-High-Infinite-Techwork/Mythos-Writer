'use strict';

const { canaryScratchRef } = require('./constants');
const { OID_HEX } = require('./refs-graphql');
const { actWritesEnabled } = require('./switch');
const { readCanaryOutcomesFromDir, evaluateCanaryOutcomes } = require('./canary-artifacts');

function outcomesMatchRun(outcomes, runId, runAttempt) {
  const rid = Number.parseInt(String(runId), 10);
  const att = Number.parseInt(String(runAttempt), 10);
  if (!Array.isArray(outcomes)) return false;
  for (const row of outcomes) {
    if (!row || Number(row.runId) !== rid || Number(row.runAttempt) !== att) {
      return false;
    }
    if (row.scratchRef && row.scratchRef !== canaryScratchRef(rid, att)) {
      return false;
    }
  }
  return true;
}

async function runCanaryVerify(client, {
  reReadSwitch,
  mainSha,
  artifactsDir,
  runId,
  runAttempt,
}) {
  const switches = await reReadSwitch();
  if (!switches.ok) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'switch_read' }));
    return 1;
  }
  if (!actWritesEnabled(switches)) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'switch_off' }));
    return 1;
  }

  const main = String(mainSha || '');
  if (!OID_HEX.test(main)) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'invalid_main_sha' }));
    return 1;
  }

  if (!artifactsDir) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'missing_artifacts_dir' }));
    return 1;
  }

  const outcomes = readCanaryOutcomesFromDir(artifactsDir);
  if (outcomes === null) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'artifact_parse' }));
    return 1;
  }

  if (!outcomesMatchRun(outcomes, runId, runAttempt)) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'run_binding_mismatch' }));
    return 1;
  }

  const scored = evaluateCanaryOutcomes(outcomes);
  if (!scored.ok) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', ...scored }));
    return 1;
  }

  let scratchRef;
  try {
    scratchRef = canaryScratchRef(runId, runAttempt);
  } catch {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'invalid_run_binding' }));
    return 1;
  }

  const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/canary/' });
  if (!listed.ok) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'list_failed' }));
    return 1;
  }

  const scratchRows = (listed.refs || []).filter((r) => r.ref === scratchRef);
  if (scratchRows.length !== 1) {
    console.error(JSON.stringify({
      kind: 'canary_verify_fail',
      reason: 'scratch_missing',
      ref: scratchRef,
      count: scratchRows.length,
    }));
    return 1;
  }

  const row = scratchRows[0];
  if (row.sha !== main) {
    console.error(JSON.stringify({
      kind: 'canary_verify_fail',
      reason: 'scratch_sha_mismatch',
      ref: scratchRef,
      expected: main,
      got: row.sha,
    }));
    return 1;
  }

  const sw2 = await reReadSwitch();
  if (!sw2.ok) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'switch_read' }));
    return 1;
  }
  if (!actWritesEnabled(sw2)) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'switch_off' }));
    return 1;
  }
  const del = await client.deleteRef({ ref: row.ref, beforeOid: row.sha });
  if (!del.ok) {
    console.error(JSON.stringify({ kind: 'canary_verify_delete_fail', error: del.error, ref: scratchRef }));
    return 1;
  }

  console.log(JSON.stringify({ kind: 'canary_verify_ok', deleted: scratchRef, runId, runAttempt }));
  return 0;
}

module.exports = { runCanaryVerify, outcomesMatchRun };