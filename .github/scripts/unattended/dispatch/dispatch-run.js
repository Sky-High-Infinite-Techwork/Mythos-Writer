'use strict';

const {
  REPO,
  DEFAULT_LANE_CAP,
  DEFAULT_LEASE_MINUTES,
  parseLaneCap,
  clampLeaseMinutes,
} = require('./constants');
const { readDispatchSwitches, readRepoVariable, actWritesEnabled } = require('./switch');
const { findOfficialPlan, issueEditedByUntrusted, isTrustedPlanAuthor } = require('./official-plan');
const { defaultSlices, anyProtectedInPlanFiles } = require('./slice');
const {
  buildLeasePayload,
  claimLaneAndSlice,
  computeWouldClaimSlot,
  releaseClaimPair,
  assertHolderBeforePublish,
} = require('./claim');
const { parseBuildOrderIssues, pickNextBuildOrderIssue } = require('./build-order');
const { leaseMessage: formatLeaseMessage } = require('./constants');

function createDispatchClient(env) {
  return env.client || null;
}

async function reReadSwitchFn(repo, controlToken, readSwitches) {
  return readSwitches(repo, controlToken);
}

async function runDispatchPlan(env) {
  const mode = env.MODE === 'act' ? 'act' : 'dry-run';
  const repo = env.REPO || REPO;
  const controlToken = env.CONTROL_TOKEN;
  const readSwitches = env.readDispatchSwitchesFn || readDispatchSwitches;
  const readVariable = env.readRepoVariableFn || readRepoVariable;
  const switches = await readSwitches(repo, controlToken);

  if (mode === 'act') {
    if (!switches.ok) {
      console.error('dispatch: switch read failed; no writes');
      return 1;
    }
    if (!actWritesEnabled(switches)) {
      console.log('dispatch: act inert (switches not true)');
      return 0;
    }
  } else if (!switches.ok) {
    console.error('dispatch: switch read failed');
    return 1;
  }

  const capVar = await readVariable(repo, controlToken, 'MYTHOS_DISPATCH_LANE_CAP');
  if (!capVar.ok) {
    console.error('dispatch: lane cap read failed');
    return 1;
  }
  const capParsed = parseLaneCap(capVar.value == null ? String(DEFAULT_LANE_CAP) : capVar.value);
  if (!capParsed.ok) {
    console.log(JSON.stringify({ kind: 'dispatch_hold', reason: 'invalid_lane_cap' }));
    return mode === 'act' ? 1 : 0;
  }
  const orderVar = await readVariable(repo, controlToken, 'MYTHOS_BUILD_ORDER_ISSUES');
  if (!orderVar.ok) {
    console.error('dispatch: build order read failed');
    return 1;
  }
  const leaseVar = await readVariable(repo, controlToken, 'MYTHOS_DISPATCH_LEASE_MINUTES');
  const leaseMinutes = clampLeaseMinutes(
    leaseVar.ok && leaseVar.value ? leaseVar.value : DEFAULT_LEASE_MINUTES,
  );
  const ordered = parseBuildOrderIssues(orderVar.value || '');

  const client = createDispatchClient(env);
  if (!client) {
    console.error('dispatch: missing client');
    return 1;
  }

  const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/' });
  if (!listed.ok) {
    console.error('dispatch: list refs failed');
    return 1;
  }

  const issueMeta = { ...(env.issueMeta || {}) };
  const activeFrom = env.activeClaimsFromRefs || null;
  const pick = pickNextBuildOrderIssue(
    ordered,
    activeFrom ? activeFrom(listed.refs) : [],
    issueMeta,
  );
  if (!pick.ok) {
    console.log(JSON.stringify({ kind: 'dispatch_idle', reason: pick.reason }));
    return 0;
  }

  const issueNumber = pick.issue;
  if (!issueMeta[issueNumber] && client.getIssue) {
    const meta = await client.getIssue({ issue: issueNumber });
    if (!meta.ok) {
      console.error('dispatch: issue fetch failed');
      return 1;
    }
    if (meta.issue.state !== 'open') {
      console.log(JSON.stringify({ kind: 'dispatch_hold', issue: issueNumber, reason: 'issue_not_open' }));
      return 0;
    }
    if (meta.issue.pull_request) {
      console.log(JSON.stringify({ kind: 'dispatch_hold', issue: issueNumber, reason: 'issue_is_pr' }));
      return 0;
    }
    issueMeta[issueNumber] = { state: 'OPEN' };
  }

  if (client.issueEvents) {
    const events = await client.issueEvents({ issue: issueNumber });
    if (events.ok) {
      const edit = issueEditedByUntrusted(events.events);
      if (edit.hold) {
        console.log(JSON.stringify({ kind: 'dispatch_hold', issue: issueNumber, reason: 'untrusted_editor', editor: edit.editor }));
        return 0;
      }
    }
  }

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
  if (official.hold) {
    console.log(JSON.stringify({ kind: 'dispatch_hold', issue: issueNumber, reason: official.reason, detail: official.detail }));
    return 0;
  }
  if (anyProtectedInPlanFiles(official.files)) {
    console.log(JSON.stringify({ kind: 'dispatch_hold', issue: issueNumber, reason: 'protected_paths_in_plan' }));
    return 0;
  }

  const slices = defaultSlices(official.files);
  const slice = slices[0];
  const leasePayload = buildLeasePayload({
    issue: issueNumber,
    slice: slice.index,
    planCommentId: official.databaseId || official.commentId,
    planBodySha256: official.bodySha256,
    files: slice.files,
    runId: env.RUN_ID || 0,
    runAttempt: env.RUN_ATTEMPT || 1,
  }, leaseMinutes);

  if (mode === 'dry-run') {
    const slotProbe = computeWouldClaimSlot(listed.refs, capParsed.value, leasePayload);
    const wouldSlot = slotProbe.ok ? slotProbe.slot : null;
    const holdReason = slotProbe.ok ? null : slotProbe.reason;
    process.stdout.write(`${JSON.stringify({
      kind: 'would_claim',
      mode,
      issue: issueNumber,
      slice: slice.index,
      files: slice.files,
      laneCap: capParsed.value,
      slot: wouldSlot,
      holdReason,
      planCommentId: leasePayload.planCommentId,
      planBodySha256: leasePayload.planBodySha256,
    })}\n`);
    return 0;
  }

  await readSwitches(repo, controlToken);
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

  const claim = await claimLaneAndSlice(client, {
    cap: capParsed.value,
    leaseSha,
    payload: leasePayload,
    recoverSameSha: true,
  });
  if (!claim.ok) {
    if (claim.fatal) return 1;
    console.log(JSON.stringify({ kind: 'dispatch_skip', reason: claim.reason }));
    return 0;
  }

  const holder = await assertHolderBeforePublish(client, [claim.ref, claim.claimRef], leaseSha);
  if (!holder.ok) {
    await releaseClaimPair(client, { laneRef: claim.ref, claimRef: claim.claimRef, leaseSha }, null);
    console.log(JSON.stringify({ kind: 'dispatch_skip', reason: holder.reason }));
    return 0;
  }

  console.log(JSON.stringify({
    kind: 'dispatch_claimed',
    issue: issueNumber,
    slice: slice.index,
    slot: claim.slot,
    laneRef: claim.ref,
    claimRef: claim.claimRef,
  }));
  return 0;
}

module.exports = {
  runDispatchPlan,
  reReadSwitchFn,
};