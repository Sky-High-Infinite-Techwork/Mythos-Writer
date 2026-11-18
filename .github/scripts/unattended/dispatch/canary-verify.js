'use strict';

const { CANARY_SCRATCH_SHARED_REF } = require('./constants');
const { OID_HEX } = require('./refs-graphql');
const { actWritesEnabled } = require('./switch');
const { readCanaryOutcomesFromDir, evaluateCanaryOutcomes } = require('./canary-artifacts');

async function runCanaryVerify(client, {
  reReadSwitch,
  mainSha,
  artifactsDir,
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

  const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/canary/' });
  if (!listed.ok) {
    console.error('canary-verify: list failed');
    return 1;
  }

  const scratchRows = (listed.refs || []).filter((r) => r.ref === CANARY_SCRATCH_SHARED_REF);
  if (scratchRows.length !== 1) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'scratch_missing', count: scratchRows.length }));
    return 1;
  }

  const row = scratchRows[0];
  if (row.sha !== main) {
    console.error(JSON.stringify({
      kind: 'canary_verify_fail',
      reason: 'scratch_sha_mismatch',
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
    console.error(JSON.stringify({ kind: 'canary_verify_delete_fail', error: del.error }));
    return 1;
  }
  const deletedRef = row.ref;

  if (!artifactsDir) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'missing_artifacts_dir', deleted: deletedRef }));
    return 1;
  }

  const outcomes = readCanaryOutcomesFromDir(artifactsDir);
  if (outcomes === null) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', reason: 'artifact_parse', deleted: deletedRef }));
    return 1;
  }

  const scored = evaluateCanaryOutcomes(outcomes);
  if (!scored.ok) {
    console.error(JSON.stringify({ kind: 'canary_verify_fail', deleted: deletedRef, ...scored }));
    return 1;
  }

  console.log(JSON.stringify({ kind: 'canary_verify_ok', deleted: deletedRef }));
  return 0;
}

module.exports = { runCanaryVerify };