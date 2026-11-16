'use strict';

const { REPO, DEFAULT_LANE_CAP, DEFAULT_LEASE_MINUTES } = require('./constants');
const { readDispatchSwitches, readRepoVariable } = require('./switch');
const { findOfficialPlan } = require('./official-plan');
const { defaultSlices, anyProtectedInClaim } = require('./slice');
const { buildLeasePayload, claimLaneSlot, claimSliceIdentity, releaseRefs } = require('./claim');
const { parseBuildOrderIssues, pickNextBuildOrderIssue } = require('./build-order');
const { parseLeaseMessage, isExpired, leaseMessage: formatLeaseMessage } = require('./constants');

function createDispatchClient(env) {
  return env.client || null;
}

function activeClaimsFromRefs(refs, now = new Date()) {
  return (refs || []).map((row) => {
    const lease = parseLeaseMessage(row.message);
    if (!lease) return null;
    return {
      issue: lease.issue,
      slice: lease.slice,
      expired: isExpired(lease, now),
      ref: row.ref,
    };
  }).filter(Boolean);
}

function logWouldClaim(entry) {
  process.stdout.write(`${JSON.stringify({ kind: 'would_claim', ...entry })}\n`);
}

async function runDispatchPlan(env) {
  const mode = env.MODE === 'act' ? 'act' : 'dry-run';
  const repo = env.REPO || REPO;
  const controlToken = env.CONTROL_TOKEN;
  const readSwitches = env.readDispatchSwitchesFn || ((r, t) => readDispatchSwitches(r, t));
  const readVariable = env.readRepoVariableFn || ((r, t, name) => readRepoVariable(r, t, name));
  const switches = readSwitches(repo, controlToken);
  if (!switches.ok) {
    console.error('dispatch: switch read failed; no writes');
    return 1;
  }
  if (!switches.enabled) {
    console.log('dispatch: inert (UNATTENDED_ENABLED and MYTHOS_DISPATCH_ENABLED must both be true)');
    return 0;
  }

  const capVar = readVariable(repo, controlToken, 'MYTHOS_DISPATCH_LANE_CAP');
  const laneCap = capVar.ok ? capVar.value : String(DEFAULT_LANE_CAP);
  const orderVar = readVariable(repo, controlToken, 'MYTHOS_BUILD_ORDER_ISSUES');
  const leaseVar = readVariable(repo, controlToken, 'MYTHOS_DISPATCH_LEASE_MINUTES');
  const ordered = parseBuildOrderIssues(orderVar.ok ? orderVar.value : '');
  const leaseMinutes = parseInt(leaseVar.ok && leaseVar.value ? leaseVar.value : String(DEFAULT_LEASE_MINUTES), 10);

  const client = createDispatchClient(env);
  if (!client) {
    console.error('dispatch: missing client');
    return 1;
  }

  const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/' });
  const activeClaims = activeClaimsFromRefs(listed.refs || []);
  const pick = pickNextBuildOrderIssue(ordered, activeClaims, env.issueMeta || {});
  if (!pick.ok) {
    console.log(JSON.stringify({ kind: 'dispatch_idle', reason: pick.reason }));
    return 0;
  }

  const issueNumber = pick.issue;
  const comments = await client.issueComments({ issue: issueNumber });
  if (!comments.ok) {
    console.error('dispatch: failed to list comments');
    return 1;
  }
  const official = findOfficialPlan(comments.comments);
  if (!official) {
    console.log(JSON.stringify({ kind: 'dispatch_hold', issue: issueNumber, reason: 'no_official_plan' }));
    return 0;
  }
  if (anyProtectedInClaim(official.files)) {
    console.log(JSON.stringify({
      kind: 'dispatch_hold',
      issue: issueNumber,
      reason: 'protected_paths_in_plan',
    }));
    return 0;
  }

  const slices = defaultSlices(official.files);
  const slice = slices[0];
  const leasePayload = buildLeasePayload({
    issue: issueNumber,
    slice: slice.index,
    planCommentId: official.databaseId || official.commentId,
    planBodySha256: official.bodySha256,
    runId: env.RUN_ID || 0,
    runAttempt: env.RUN_ATTEMPT || 1,
  }, Number.isFinite(leaseMinutes) ? leaseMinutes : DEFAULT_LEASE_MINUTES);

  if (mode === 'dry-run') {
    logWouldClaim({
      mode,
      issue: issueNumber,
      slice: slice.index,
      files: slice.files,
      laneCap,
      planCommentId: leasePayload.planCommentId,
      planBodySha256: leasePayload.planBodySha256,
    });
    return 0;
  }

  let leaseSha = env.LEASE_COMMIT_SHA;
  if (!leaseSha && env.MAIN_SHA && client.createLeaseCommit) {
    const message = formatLeaseMessage(leasePayload);
    const created = await client.createLeaseCommit(message, env.MAIN_SHA);
    if (!created.ok) {
      console.error('dispatch: lease commit failed');
      return 1;
    }
    leaseSha = created.sha;
  }
  if (!leaseSha) {
    console.error('dispatch: missing lease commit sha');
    return 1;
  }

  const identity = await claimSliceIdentity(client, {
    issue: issueNumber,
    slice: slice.index,
    planBodySha256: official.bodySha256,
    leaseSha,
  });
  if (!identity.ok) {
    console.log(JSON.stringify({ kind: 'dispatch_skip', reason: identity.reason }));
    return 0;
  }

  const lane = await claimLaneSlot(client, {
    cap: laneCap,
    leaseSha,
    payload: leasePayload,
  });
  if (!lane.ok) {
    await releaseRefs(client, [identity.ref]);
    console.log(JSON.stringify({ kind: 'dispatch_skip', reason: lane.reason }));
    return 0;
  }

  console.log(JSON.stringify({
    kind: 'dispatch_claimed',
    issue: issueNumber,
    slice: slice.index,
    slot: lane.slot,
    laneRef: lane.ref,
    claimRef: identity.ref,
  }));
  return 0;
}

module.exports = {
  activeClaimsFromRefs,
  runDispatchPlan,
};