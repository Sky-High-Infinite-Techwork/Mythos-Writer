'use strict';

const {
  REPO,
  DEFAULT_LANE_CAP,
  DEFAULT_LEASE_MINUTES,
  parseLaneCap,
  clampLeaseMinutes,
} = require('./constants');
const { readDispatchSwitches, readRepoVariable, actWritesEnabled } = require('./switch');
const { findOfficialPlan, verifyPlanCommentEditors } = require('./official-plan');
const { defaultSlices, anyProtectedInPlanFiles } = require('./slice');
const {
  buildLeasePayload,
  claimLaneAndSlice,
  computeWouldClaimSlot,
  assertHolderBeforePublish,
  releaseClaimPair,
} = require('./claim');
const { parseBuildOrderIssues, issueBlockedByClaim } = require('./build-order');
const { leaseMessage: formatLeaseMessage } = require('./constants');
const {
  assessSliceProgress,
  recordDispatchAttempt,
} = require('./slice-progress');

function createDispatchClient(env) {
  return env.client || null;
}

async function reReadSwitchFn(repo, controlToken, readSwitches) {
  const s = await readSwitches(repo, controlToken);
  return { ok: s.ok, enabled: actWritesEnabled(s) };
}

const SKIP_TO_NEXT = new Set([
  'issue_not_open',
  'issue_is_pr',
  'no_official_plan',
  'slice_done',
  'max_attempts',
  'backoff',
  'slice_already_claimed',
]);

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
  const activeClaims = activeFrom ? activeFrom(listed.refs) : [];

  const findBoundPlanPass = env.findBoundPlanPass || null;

  for (const issueNumber of ordered) {
    if (issueBlockedByClaim(issueNumber, activeClaims)) continue;

    if (!issueMeta[issueNumber] && client.getIssue) {
      const meta = await client.getIssue({ issue: issueNumber });
      if (!meta.ok) {
        console.error('dispatch: issue fetch failed');
        return 1;
      }
      if (meta.issue.state !== 'open') {
        console.log(JSON.stringify({ kind: 'dispatch_skip', issue: issueNumber, reason: 'issue_not_open' }));
        continue;
      }
      if (meta.issue.pull_request) {
        console.log(JSON.stringify({ kind: 'dispatch_skip', issue: issueNumber, reason: 'issue_is_pr' }));
        continue;
      }
      issueMeta[issueNumber] = { state: 'OPEN' };
    }

    const comments = await client.issueComments({ issue: issueNumber });
    if (!comments.ok) {
      console.error('dispatch: failed to list comments');
      return 1;
    }
    const official = findOfficialPlan(comments.comments);
    if (!official) {
      console.log(JSON.stringify({ kind: 'dispatch_skip', issue: issueNumber, reason: 'no_official_plan' }));
      continue;
    }
    if (official.hold) {
      console.log(JSON.stringify({
        kind: 'dispatch_hold',
        issue: issueNumber,
        reason: official.reason,
        commentId: official.commentId,
      }));
      continue;
    }
    const edit = await verifyPlanCommentEditors(client, issueNumber, official);
    if (edit.hold) {
      console.log(JSON.stringify({
        kind: 'dispatch_hold',
        issue: issueNumber,
        reason: edit.reason || 'untrusted_editor',
        editor: edit.editor,
      }));
      continue;
    }
    if (anyProtectedInPlanFiles(official.files)) {
      console.log(JSON.stringify({ kind: 'dispatch_hold', issue: issueNumber, reason: 'protected_paths_in_plan' }));
      continue;
    }

    if (mode === 'act') {
      if (typeof findBoundPlanPass !== 'function') {
        console.log(JSON.stringify({
          kind: 'dispatch_hold',
          issue: issueNumber,
          reason: 'plan_not_graded',
        }));
        continue;
      }
      const gradePass = findBoundPlanPass(comments.comments, official);
      if (!gradePass.ok) {
        console.log(JSON.stringify({
          kind: 'dispatch_hold',
          issue: issueNumber,
          reason: gradePass.reason || 'plan_not_graded',
        }));
        continue;
      }
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

    const progress = await assessSliceProgress(client, issueNumber, slice.index);
    if (!progress.ok) {
      if (progress.hold) {
        const reason = progress.reason;
        if (SKIP_TO_NEXT.has(reason)) {
          console.log(JSON.stringify({
            kind: 'dispatch_skip',
            issue: issueNumber,
            slice: slice.index,
            reason,
            waitMinutes: progress.waitMinutes,
          }));
          continue;
        }
        console.log(JSON.stringify({
          kind: 'dispatch_hold',
          issue: issueNumber,
          slice: slice.index,
          reason,
          waitMinutes: progress.waitMinutes,
        }));
        continue;
      }
      console.error('dispatch: slice progress read failed');
      return 1;
    }

    const slotProbe = computeWouldClaimSlot(listed.refs, capParsed.value, leasePayload);
    if (!slotProbe.ok && slotProbe.reason === 'files_overlap') {
      console.log(JSON.stringify({ kind: 'dispatch_skip', issue: issueNumber, reason: slotProbe.reason }));
      continue;
    }

    if (mode === 'dry-run') {
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

    const reReadSwitch = () => reReadSwitchFn(repo, controlToken, readSwitches);
    const switchesNow = await reReadSwitch();
    if (!switchesNow.ok || !switchesNow.enabled) {
      console.log('dispatch: act aborted (switch off before lease commit)');
      return 0;
    }

    let leaseSha = env.LEASE_COMMIT_SHA;
    if (!leaseSha && env.MAIN_SHA && client.createLeaseCommit) {
      const message = formatLeaseMessage(leasePayload);
      const created = await client.createLeaseCommit(message, env.MAIN_SHA, {
        reReadSwitch,
        actWritesEnabled: actWritesEnabled,
      });
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

    const mintLeaseSha = async (message) => {
      if (!client.createLeaseCommit || !env.MAIN_SHA) return null;
      const created = await client.createLeaseCommit(message, env.MAIN_SHA, {
        reReadSwitch,
        actWritesEnabled: actWritesEnabled,
      });
      return created.ok ? created.sha : null;
    };

    const claim = await claimLaneAndSlice(client, {
      cap: capParsed.value,
      leaseSha,
      payload: leasePayload,
      recoverSameSha: true,
      reReadSwitch,
    });
    if (!claim.ok) {
      if (claim.fatal) {
        console.error(JSON.stringify({
          kind: 'dispatch_fail',
          issue: issueNumber,
          reason: claim.reason || 'claim_fatal',
          rolledBack: claim.rolledBack || [],
        }));
        return 1;
      }
      if (claim.reason === 'files_overlap' || claim.reason === 'slice_already_claimed') {
        console.log(JSON.stringify({ kind: 'dispatch_skip', issue: issueNumber, reason: claim.reason }));
        continue;
      }
      console.log(JSON.stringify({ kind: 'dispatch_skip', issue: issueNumber, reason: claim.reason }));
      return 0;
    }

    const holder = await assertHolderBeforePublish(client, [claim.ref, claim.claimRef], leaseSha);
    if (!holder.ok) {
      console.error(JSON.stringify({ kind: 'dispatch_fail', issue: issueNumber, reason: holder.reason }));
      const releaseResults = await releaseClaimPair(
        client,
        { laneRef: claim.ref, claimRef: claim.claimRef, leaseSha },
        reReadSwitch,
      );
      const releaseFailed = releaseResults.filter((row) => !row.ok);
      if (releaseFailed.length) {
        console.error(JSON.stringify({
          kind: 'dispatch_release_failed',
          laneRef: claim.ref,
          claimRef: claim.claimRef,
          results: releaseResults,
        }));
      }
      return 1;
    }

    const record = await recordDispatchAttempt(client, issueNumber, slice.index, { reReadSwitch, mintLeaseSha });
    if (!record.ok) {
      console.error(`dispatch: attempt record failed: ${record.reason}`);
      const releaseResults = await releaseClaimPair(
        client,
        { laneRef: claim.ref, claimRef: claim.claimRef, leaseSha },
        reReadSwitch,
      );
      const releaseFailed = releaseResults.filter((row) => !row.ok);
      if (releaseFailed.length) {
        console.error(JSON.stringify({
          kind: 'dispatch_release_failed',
          laneRef: claim.ref,
          claimRef: claim.claimRef,
          results: releaseResults,
        }));
      }
      return 1;
    }

    console.log(JSON.stringify({
      kind: 'dispatch_claimed',
      issue: issueNumber,
      slice: slice.index,
      slot: claim.slot,
      laneRef: claim.ref,
      claimRef: claim.claimRef,
      planCommentId: official.commentId,
    }));
    return 0;
  }

  console.log(JSON.stringify({ kind: 'dispatch_idle', reason: 'no_eligible_issue' }));
  return 0;
}

module.exports = {
  runDispatchPlan,
  reReadSwitchFn,
};