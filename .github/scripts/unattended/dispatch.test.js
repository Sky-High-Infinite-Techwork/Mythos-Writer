'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseLaneCap,
  slotRef,
  claimRef,
  leaseMessage,
  clampLeaseMinutes,
} = require('./dispatch/constants');
const {
  findOfficialPlan,
  parseFilesSection,
  canonicalAuthorLogin,
  verifyPlanCommentEditors,
} = require('./dispatch/official-plan');
const {
  globEntryOverlaps,
  diffWithinClaim,
  normalizePlanPaths,
} = require('./dispatch/slice');
const {
  claimLaneAndSlice,
  sweepDispatchRefs,
  buildLeasePayload,
  computeWouldClaimSlot,
  assertHolderBeforePublish,
  tryCreateRefPair,
  REF_EXISTS,
  activeLeasesAll,
} = require('./dispatch/claim');

function workerLeaseSha(index, prefix = 'a') {
  const hex = String(index).padStart(39, '0');
  return `${prefix}${hex}`.slice(0, 40);
}

async function concurrentSlotRace(client, slotIndex, workers, leaseShaForIndex) {
  const ref = slotRef(slotIndex);
  const claimRefName = claimRef(0, 99);
  const attempts = await Promise.all(
    Array.from({ length: workers }, (_, i) => {
      const leaseSha = leaseShaForIndex(i);
      return tryCreateRefPair(client, { laneRef: ref, claimRef: claimRefName, leaseSha })
        .then((row) => ({ ...row, leaseSha }));
    }),
  );
  const wins = attempts.filter((row) => row.ok);
  const refExists = attempts.filter((row) => row.refExists || row.reason === REF_EXISTS).length;
  const fatal = attempts.filter((row) => row.fatal).length;
  return { ref, winners: wins.length, attempts, refExists, fatal };
}
const { claimRef: claimRefFn } = require('./dispatch/constants');
const { globOrPathProtected, globsOverlap } = require('./dispatch/path-policy');
const { createMockRefClient, createYieldingRaceClient } = require('./dispatch/mock-client');
const { runDispatchPlan } = require('./dispatch/dispatch-run');
const { activeClaimsFromRefs } = require('./dispatch/dispatch-helpers');
const { canaryScratchRef } = require('./dispatch/constants');

const CANARY_RUN_ID = 9001;
const CANARY_RUN_ATTEMPT = 1;
const CANARY_SCRATCH_REF = canaryScratchRef(CANARY_RUN_ID, CANARY_RUN_ATTEMPT);

function bindCanaryOutcome(row) {
  return {
    runId: CANARY_RUN_ID,
    runAttempt: CANARY_RUN_ATTEMPT,
    scratchRef: CANARY_SCRATCH_REF,
    ...row,
  };
}

function canaryVerifyOpts(client, extra = {}) {
  return {
    reReadSwitch: async () => ({ ok: true, enabled: true }),
    runId: CANARY_RUN_ID,
    runAttempt: CANARY_RUN_ATTEMPT,
    ...extra,
  };
}

test('parseLaneCap rejects zero and non-numeric', () => {
  assert.equal(parseLaneCap('0').ok, false);
  assert.equal(parseLaneCap('').ok, false);
  assert.equal(parseLaneCap('5').ok, true);
  assert.equal(parseLaneCap('21').ok, false);
});

test('clampLeaseMinutes bounds 30..360', () => {
  assert.equal(clampLeaseMinutes('10'), 30);
  assert.equal(clampLeaseMinutes('500'), 360);
});

test('untrusted author ignored for official plan', () => {
  const plan = findOfficialPlan([{
    id: '1',
    author: { login: 'random' },
    body: '## Files\nfrontend/a.ts',
    createdAt: '2026-01-02T00:00:00Z',
  }]);
  assert.equal(plan, null);
});

test('bot canonicalization', () => {
  assert.equal(canonicalAuthorLogin({ login: 'cursor', __typename: 'Bot' }), 'cursor[bot]');
});

test('empty ## Files holds', () => {
  const hold = findOfficialPlan([{
    id: '1',
    author: { login: 'SkyyPlayz' },
    body: '## Files\n',
    createdAt: '2026-01-02T00:00:00Z',
  }]);
  assert.equal(hold.hold, true);
});

test('## Files inside fences ignored', () => {
  const section = parseFilesSection('```\n## Files\nfoo\n```\n## Files\nfrontend/x.ts');
  assert.equal(section.kind, 'ok');
  assert.deepEqual(section.files, ['frontend/x.ts']);
});

test('glob prefix overlap rule', () => {
  assert.equal(globEntryOverlaps('frontend/**', 'frontend/foo.ts'), true);
  assert.equal(globEntryOverlaps('frontend/**', 'electron/**'), false);
});

test('reject dotdot paths', () => {
  assert.equal(normalizePlanPaths(['../x']).ok, false);
});

test('previous_filename must be in claim', () => {
  const check = diffWithinClaim(
    [{ filename: 'frontend/new.ts', previous_filename: 'frontend/old.ts' }],
    ['frontend/new.ts'],
  );
  assert.equal(check.ok, false);
});

test('20-way concurrent race', async () => {
  const client = createMockRefClient();
  const race = await concurrentSlotRace(client, 0, 20, (i) => workerLeaseSha(i, 'a'));
  assert.equal(race.winners, 1);
  const lostToHolder = race.attempts.filter(
    (row) => !row.ok && (row.refExists || row.reason === REF_EXISTS || row.reason === 'slice_already_claimed'),
  );
  assert.equal(lostToHolder.length, 19);
  assert.equal(race.fatal, 0);
  const win = race.attempts.find((row) => row.ok);
  assert.ok(win);
  const claimRefName = claimRef(0, 99);
  assert.equal(client.refs.get(race.ref), win.leaseSha);
  assert.equal(client.refs.get(claimRefName), win.leaseSha);
  const future = new Date(Date.now() + 3600000).toISOString();
  const msg = leaseMessage({
    issue: 1,
    slice: 0,
    planCommentId: 1,
    planBodySha256: 'c'.repeat(64),
    files: ['a.ts'],
    runId: 1,
    runAttempt: 1,
    claimedAt: new Date().toISOString(),
    expiresAt: future,
  });
  client.setRefMessage(race.ref, msg);
  client.setRefMessage(claimRefName, msg);
  const laneGot = await client.getRef({ ref: race.ref });
  assert.equal(laneGot.sha, win.leaseSha);
  const claimGot = await client.getRef({ ref: claimRefName });
  assert.equal(claimGot.sha, win.leaseSha);
});

test('ref_exists loser with different sha does not delete holder refs', async () => {
  const client = createMockRefClient();
  const lane = slotRef(0);
  const claim = claimRef(1, 0);
  const holderSha = 'a'.repeat(40);
  const loserSha = 'b'.repeat(40);
  const holder = await tryCreateRefPair(client, { laneRef: lane, claimRef: claim, leaseSha: holderSha });
  assert.equal(holder.ok, true);
  const lost = await tryCreateRefPair(client, { laneRef: lane, claimRef: claim, leaseSha: loserSha });
  assert.equal(lost.ok, false);
  assert.ok(lost.refExists || lost.reason === 'slice_already_claimed');
  assert.equal(client.refs.get(lane), holderSha);
  assert.equal(client.refs.get(claim), holderSha);
});

test('yielding mock race', async () => {
  const client = createYieldingRaceClient(2);
  const { winners } = await concurrentSlotRace(client, 0, 20, (i) => workerLeaseSha(i, 'b'));
  assert.equal(winners, 1);
});

test('lane cap five', async () => {
  const client = createMockRefClient();
  const basePayload = {
    slice: 0,
    planCommentId: 1,
    planBodySha256: 'c'.repeat(64),
    runId: 1,
    runAttempt: 1,
  };
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, idx) => {
      const leaseSha = workerLeaseSha(idx, 'd');
      const payload = buildLeasePayload({
        ...basePayload,
        issue: idx + 1,
        files: [`f${idx}.ts`],
      });
      return claimLaneAndSlice(client, {
        cap: 5,
        leaseSha,
        payload,
      }).then((row) => ({ ...row, leaseSha }));
    }),
  );
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.equal(results.filter((r) => r.reason === 'lane_full').length, 1);
  const future = new Date(Date.now() + 3600000).toISOString();
  for (const row of results.filter((r) => r.ok)) {
    const msg = leaseMessage({ ...row.payload, expiresAt: future });
    client.setRefMessage(row.ref, msg);
    client.setRefMessage(row.claimRef, msg);
    assert.equal(client.refs.get(row.ref), row.leaseSha);
    assert.equal(client.refs.get(row.claimRef), row.leaseSha);
  }
  const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/' });
  assert.equal(activeLeasesAll(listed.refs).length, 5);
});

test('different-lane race on overlapping files yields one winner', async () => {
  const client = createMockRefClient();
  const future = new Date(Date.now() + 3600000).toISOString();
  const files = ['frontend/shared-overlap.ts'];
  const basePayload = buildLeasePayload({
    issue: 1,
    slice: 0,
    planCommentId: 1,
    planBodySha256: 'c'.repeat(64),
    files,
    runId: 1,
    runAttempt: 1,
  });
  const claimOne = async (issue, n) => {
    const leaseSha = workerLeaseSha(n, 'e');
    const r = await claimLaneAndSlice(client, {
      cap: 5,
      leaseSha,
      payload: { ...basePayload, issue },
    });
    if (r.ok) {
      client.setRefMessage(r.ref, leaseMessage({ ...r.payload, expiresAt: future }));
    }
    return r;
  };
  const [a, b] = await Promise.all([claimOne(10, 10), claimOne(11, 11)]);
  const winners = [a, b].filter((r) => r.ok);
  assert.equal(winners.length, 1);
  assert.equal([a, b].filter((r) => r.reason === 'files_overlap').length, 1);
});

test('identity ref is issue-slice only', () => {
  assert.equal(claimRef(42, 0), 'refs/mythos/dispatch/claim/42-0');
});

test('sweep stale and unparseable', async () => {
  const client = createMockRefClient();
  const ref = slotRef(0);
  await client.createRef({ ref, sha: 'e'.repeat(40) });
  const past = new Date(Date.now() - 1000).toISOString();
  client.setRefMessage(ref, leaseMessage({
    issue: 1,
    slice: 0,
    files: ['a.ts'],
    planCommentId: 1,
    planBodySha256: 'x',
    runId: 1,
    runAttempt: 1,
    claimedAt: past,
    expiresAt: past,
  }));
  const bad = slotRef(1);
  await client.createRef({ ref: bad, sha: 'f'.repeat(40) });
  client.setRefMessage(bad, 'garbage');
  const swept = await sweepDispatchRefs(client, {});
  assert.ok(swept.deleted.length >= 2);
});

test('cap above N does not block lower slots', () => {
  const probe = computeWouldClaimSlot([], 3, {
    issue: 1,
    slice: 0,
    files: ['z.ts'],
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.slot, 0);
});

test('dry-run switches off', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => ({
    ok: true,
    comments: [{ id: '1', databaseId: 1, author: { login: 'SkyyPlayz' }, body: '## Files\na.ts', createdAt: '1' }],
  });
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (c) => { lines.push(String(c)); return true; };
  try {
    const code = await runDispatchPlan({
      MODE: 'dry-run',
      client,
      readDispatchSwitchesFn: async () => ({ ok: true, enabled: false }),
      readRepoVariableFn: async (_r, _t, n) => {
        if (n === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '1' };
        if (n === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
        return { ok: true, value: null };
      },
      activeClaimsFromRefs: (refs) => activeClaimsFromRefs(refs),
    });
    assert.equal(code, 0);
    assert.ok(lines.some((l) => l.includes('would_claim') && l.includes('"slot"')));
  } finally {
    process.stdout.write = orig;
  }
});

test('cap read failure is exit 1', async () => {
  const code = await runDispatchPlan({
    MODE: 'dry-run',
    client: createMockRefClient(),
    readDispatchSwitchesFn: async () => ({ ok: true, enabled: false }),
    readRepoVariableFn: async (_r, _t, n) => (n === 'MYTHOS_DISPATCH_LANE_CAP' ? { ok: false } : { ok: true, value: '1' }),
  });
  assert.equal(code, 1);
});

test('max attempts backoff hold', async () => {
  const client = createMockRefClient();
  const { attemptsRef, doneRef } = require('./dispatch/constants');
  const { attemptsMessage, assessSliceProgress } = require('./dispatch/slice-progress');
  const ref = attemptsRef(1, 0);
  const sha = 'b'.repeat(40);
  await client.createRef({ ref, sha });
  client.setRefMessage(ref, attemptsMessage({ count: 5, lastAttemptAt: new Date().toISOString() }));
  const state = await assessSliceProgress(client, 1, 0);
  assert.equal(state.hold, true);
  assert.equal(state.reason, 'max_attempts');
  assert.equal(doneRef(1, 0).includes('done/'), true);
});

test('assertHolderBeforePublish detects lost lease', async () => {
  const client = createMockRefClient();
  const leaseSha = 'c'.repeat(40);
  const lane = 'refs/mythos/dispatch/lane-01';
  await client.createRef({ ref: lane, sha: leaseSha });
  client.refs.set(lane, 'd'.repeat(40));
  const h = await assertHolderBeforePublish(client, [lane], leaseSha);
  assert.equal(h.ok, false);
});

test('claim identity ref taken yields slice_already_claimed', async () => {
  const client = createMockRefClient();
  const otherSha = 'e'.repeat(40);
  const name = claimRefFn(9, 0);
  await client.createRef({ ref: name, sha: otherSha });
  const payload = buildLeasePayload({ issue: 9, slice: 0, planCommentId: 1, planBodySha256: 'x', files: ['z.ts'] });
  const result = await claimLaneAndSlice(client, { cap: 5, leaseSha: 'f'.repeat(40), payload });
  assert.equal(result.reason, 'slice_already_claimed');
  assert.equal(client.refs.has('refs/mythos/dispatch/lane-00'), false);
});

test('sweep leaves live lease and attempts refs', async () => {
  const client = createMockRefClient();
  const { attemptsRef } = require('./dispatch/constants');
  const lane = 'refs/mythos/dispatch/lane-00';
  const attempts = attemptsRef(1, 0);
  const future = new Date(Date.now() + 3600000).toISOString();
  await client.createRef({ ref: lane, sha: '1'.repeat(40) });
  client.setRefMessage(lane, leaseMessage({
    issue: 1, slice: 0, files: ['a.ts'], planCommentId: 1, planBodySha256: 'x', runId: 1, runAttempt: 1,
    claimedAt: new Date().toISOString(), expiresAt: future,
  }));
  await client.createRef({ ref: attempts, sha: '2'.repeat(40) });
  const swept = await sweepDispatchRefs(client, {});
  assert.equal(swept.deleted.includes(lane), false);
  assert.equal(swept.deleted.includes(attempts), false);
});

test('cap lowering counts high slot toward overlap', async () => {
  const client = createMockRefClient();
  const lane = 'refs/mythos/dispatch/lane-09';
  const future = new Date(Date.now() + 3600000).toISOString();
  await client.createRef({ ref: lane, sha: '3'.repeat(40) });
  client.setRefMessage(lane, leaseMessage({
    issue: 1, slice: 0, files: ['shared.ts'], planCommentId: 1, planBodySha256: 'x', runId: 1, runAttempt: 1,
    claimedAt: new Date().toISOString(), expiresAt: future,
  }));
  const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/' });
  const probe = computeWouldClaimSlot(listed.refs, 3, {
    issue: 2, slice: 0, files: ['shared.ts'],
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.reason, 'files_overlap');
});

test('dry-run performs zero ref writes', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => ({
    ok: true,
    comments: [{ id: '1', databaseId: 1, author: { login: 'SkyyPlayz' }, body: '## Files\na.ts', createdAt: '1' }],
  });
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const code = await runDispatchPlan({
    MODE: 'dry-run',
    client,
    readDispatchSwitchesFn: async () => ({ ok: true, enabled: false }),
    readRepoVariableFn: async (_r, _t, n) => {
      if (n === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '1' };
      if (n === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
      return { ok: true, value: null };
    },
    activeClaimsFromRefs: (refs) => activeClaimsFromRefs(refs),
  });
  assert.equal(code, 0);
  assert.equal(client.updateLog.length, 0);
});

test('glob-vs-glob overlap frontend patterns', () => {
  assert.equal(globsOverlap(['frontend/*.ts'], ['frontend/a*']), true);
});

test('glob star-star is protected in plan', () => {
  assert.equal(globOrPathProtected('**/*'), true);
});

test('list refs failure fails dispatch dry-run', async () => {
  const client = createMockRefClient();
  client.listRefs = async () => ({ ok: false, refs: [] });
  const code = await runDispatchPlan({
    MODE: 'dry-run',
    client,
    readDispatchSwitchesFn: async () => ({ ok: true, enabled: false }),
    readRepoVariableFn: async () => ({ ok: true, value: '1' }),
  });
  assert.equal(code, 1);
});

test('CAS release race surfaces failure', async () => {
  const client = createMockRefClient();
  const { releaseRefCas } = require('./dispatch/claim');
  const { releaseResultsOk } = require('./dispatch/slice-progress');
  const ref = 'refs/mythos/dispatch/lane-00';
  const leaseSha = 'c'.repeat(40);
  client.refs.set(ref, leaseSha);
  client.refs.set(ref, 'd'.repeat(40));
  const del = await releaseRefCas(client, ref, leaseSha, null);
  assert.equal(del.ok, false);
  assert.equal(releaseResultsOk([del]), false);
});

test('lane full when live leases meet cap regardless of slot index', () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  const refs = [5, 6, 7].map((slot) => ({
    ref: slotRef(slot),
    sha: `${slot}`.repeat(40).slice(0, 40),
    message: leaseMessage({
      issue: slot,
      slice: 0,
      files: [`f${slot}.ts`],
      planCommentId: 1,
      planBodySha256: 'a'.repeat(64),
      runId: 1,
      runAttempt: 1,
      claimedAt: new Date().toISOString(),
      expiresAt: future,
    }),
  }));
  const probe = computeWouldClaimSlot(refs, 3, { issue: 99, slice: 0, files: ['other.ts'] });
  assert.equal(probe.ok, false);
  assert.equal(probe.reason, 'lane_full');
});

test('ref renew update sets force', () => {
  const { refUpdateRenew } = require('./dispatch/refs-graphql');
  const row = refUpdateRenew('refs/mythos/dispatch/lane-00', 'a'.repeat(40), 'b'.repeat(40));
  assert.equal(row.force, true);
});

test('protected glob prefixes', () => {
  const { protectedLiteralPrefix } = require('./dispatch/constants');
  assert.equal(protectedLiteralPrefix('.gi'), true);
  assert.equal(protectedLiteralPrefix('.'), true);
  assert.equal(globOrPathProtected('.gi*/**'), true);
  assert.equal(globOrPathProtected('.g?thub/**'), true);
  assert.equal(globOrPathProtected('.*/**'), true);
});

test('plan path rejects bracket globs', () => {
  assert.equal(normalizePlanPaths(['src/[id].ts']).ok, false);
});

test('renew pair CAS mismatch rolls back both', async () => {
  const client = createMockRefClient();
  const lane = 'refs/mythos/dispatch/lane-00';
  const claim = claimRefFn(1, 0);
  const before = 'a'.repeat(40);
  await client.createRefPair({ laneRef: lane, claimRef: claim, afterOid: before });
  client.refs.set(claim, 'b'.repeat(40));
  const renewed = await client.renewRefPair({ laneRef: lane, claimRef: claim, afterOid: 'c'.repeat(40), beforeOid: before });
  assert.equal(renewed.ok, false);
  assert.equal(client.refs.get(lane), before);
});

test('assertHolder missing ref', async () => {
  const client = createMockRefClient();
  const h = await assertHolderBeforePublish(client, ['refs/mythos/dispatch/lane-02'], 'a'.repeat(40));
  assert.equal(h.ok, false);
});

test('assertHolder lane SHA matches leaseSha', async () => {
  const client = createMockRefClient();
  const lane = 'refs/mythos/dispatch/lane-00';
  const sha = 'b'.repeat(40);
  await client.createRef({ ref: lane, sha });
  const h = await assertHolderBeforePublish(client, [lane], sha);
  assert.equal(h.ok, true);
});

test('sweep keeps done canary and live claim', async () => {
  const client = createMockRefClient();
  const { doneRef } = require('./dispatch/constants');
  const future = new Date(Date.now() + 3600000).toISOString();
  const lane = 'refs/mythos/dispatch/lane-00';
  const claim = claimRefFn(2, 0);
  const done = doneRef(2, 0);
  const canary = CANARY_SCRATCH_REF;
  await client.createRef({ ref: lane, sha: '1'.repeat(40) });
  client.setRefMessage(lane, leaseMessage({
    issue: 2, slice: 0, files: ['a.ts'], planCommentId: 1, planBodySha256: 'x', runId: 1, runAttempt: 1,
    claimedAt: new Date().toISOString(), expiresAt: future,
  }));
  await client.createRef({ ref: claim, sha: '1'.repeat(40) });
  await client.createRef({ ref: done, sha: '2'.repeat(40) });
  await client.createRef({ ref: canary, sha: '3'.repeat(40) });
  const swept = await sweepDispatchRefs(client, {});
  assert.equal(swept.deleted.includes(lane), false);
  assert.equal(swept.deleted.includes(claim), false);
  assert.equal(swept.deleted.includes(done), false);
  assert.equal(swept.deleted.includes(canary), false);
});

test('dry-run with switches on performs zero writes', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => ({
    ok: true,
    comments: [{ id: '1', databaseId: 1, author: { login: 'SkyyPlayz' }, body: '## Files\na.ts', createdAt: '1' }],
  });
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const code = await runDispatchPlan({
    MODE: 'dry-run',
    client,
    readDispatchSwitchesFn: async () => ({ ok: true, enabled: true, unattended: true, dispatch: true }),
    readRepoVariableFn: async (_r, _t, n) => {
      if (n === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '1' };
      if (n === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
      return { ok: true, value: null };
    },
    activeClaimsFromRefs: (refs) => activeClaimsFromRefs(refs),
  });
  assert.equal(code, 0);
  assert.equal(client.updateLog.length, 0);
});

test('switch read failure exits 1 on dry-run', async () => {
  const code = await runDispatchPlan({
    MODE: 'dry-run',
    client: createMockRefClient(),
    readDispatchSwitchesFn: async () => ({ ok: false }),
    readRepoVariableFn: async () => ({ ok: true, value: '1' }),
  });
  assert.equal(code, 1);
});

test('path policy reject table', () => {
  const { validatePlanPathEntry } = require('./dispatch/path-policy');
  for (const entry of ['', '..', '/x', 'x\\y', '*', '**', 'a[b]']) {
    assert.equal(validatePlanPathEntry(entry).ok, false, entry);
  }
});

test('negative glob vs glob overlap', () => {
  assert.equal(globsOverlap(['docs/**'], ['src/**']), false);
});

test('mock rejects oid key in updateRefs', async () => {
  const client = createMockRefClient();
  const bad = await client.updateRefs([{ name: 'refs/mythos/dispatch/lane-00', afterOid: 'a'.repeat(40), beforeOid: '0'.repeat(40), oid: 'x' }]);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors && bad.errors[0].message === 'unexpected_oid_key');
});

test('claimLaneAndSlice lane_full when three live high slots', async () => {
  const client = createMockRefClient();
  const future = new Date(Date.now() + 3600000).toISOString();
  for (const slot of [5, 6, 7]) {
    const ref = slotRef(slot);
    await client.createRef({ ref, sha: `${slot}`.repeat(40).slice(0, 40) });
    client.setRefMessage(ref, leaseMessage({
      issue: slot,
      slice: 0,
      files: [`f${slot}.ts`],
      planCommentId: 1,
      planBodySha256: 'a'.repeat(64),
      runId: 1,
      runAttempt: 1,
      claimedAt: new Date().toISOString(),
      expiresAt: future,
    }));
  }
  const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/' });
  const payload = buildLeasePayload({
    issue: 99,
    slice: 0,
    planCommentId: 1,
    planBodySha256: 'b'.repeat(64),
    files: ['new.ts'],
    runId: 1,
    runAttempt: 1,
  });
  const result = await claimLaneAndSlice(client, { cap: 3, leaseSha: 'c'.repeat(40), payload });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lane_full');
  assert.equal(listed.refs.length, 3);
});

test('refUpdateRenew rejects zero beforeOid', () => {
  const { refUpdateRenew } = require('./dispatch/refs-graphql');
  assert.throws(() => refUpdateRenew('refs/mythos/dispatch/lane-00', 'a'.repeat(40), '0'.repeat(40)));
});

test('refUpdateRenew rejects zero afterOid', () => {
  const { refUpdateRenew } = require('./dispatch/refs-graphql');
  assert.throws(() => refUpdateRenew('refs/mythos/dispatch/lane-00', '0'.repeat(40), 'a'.repeat(40)));
});

test('mock rejects undefined afterOid and records rejection', async () => {
  const client = createMockRefClient();
  const bad = await client.updateRefs([{ name: 'refs/mythos/dispatch/lane-00', beforeOid: 'a'.repeat(40) }]);
  assert.equal(bad.ok, false);
  assert.equal(client.updateLog.length, 1);
  assert.equal(client.updateLog[0].rejected, true);
  assert.equal(client.updateLog[0].message, 'missing_after_oid');
});

test('dry-run never calls createLeaseCommit', async () => {
  const client = createMockRefClient();
  let leaseCalls = 0;
  client.createLeaseCommit = async () => {
    leaseCalls += 1;
    return { ok: true, sha: 'a'.repeat(40) };
  };
  client.issueComments = async () => ({
    ok: true,
    comments: [{ id: '1', databaseId: 1, author: { login: 'SkyyPlayz' }, body: '## Files\na.ts', createdAt: '1' }],
  });
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const code = await runDispatchPlan({
    MODE: 'dry-run',
    client,
    MAIN_SHA: 'a'.repeat(40),
    readDispatchSwitchesFn: async () => ({ ok: true, enabled: true }),
    readRepoVariableFn: async (_r, _t, n) => {
      if (n === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '1' };
      if (n === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
      return { ok: true, value: null };
    },
    activeClaimsFromRefs: (refs) => activeClaimsFromRefs(refs),
  });
  assert.equal(code, 0);
  assert.equal(leaseCalls, 0);
});

test('malformed official plan hold logs reason and commentId without raw comment text', async () => {
  const secretLine = 'TOP-SECRET-PLAN-LINE-xyzzy !!!';
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const client = createMockRefClient();
    client.issueComments = async () => ({
      ok: true,
      comments: [{
        id: '4242',
        databaseId: 4242,
        author: { login: 'SkyyPlayz' },
        body: `## Files\n${secretLine}\n`,
        createdAt: '2026-01-02T00:00:00Z',
      }],
    });
    client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
    const code = await runDispatchPlan({
      MODE: 'dry-run',
      client,
      MAIN_SHA: 'a'.repeat(40),
      readDispatchSwitchesFn: async () => ({ ok: true, enabled: true }),
      readRepoVariableFn: async (_r, _t, n) => {
        if (n === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '99' };
        if (n === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
        return { ok: true, value: null };
      },
      activeClaimsFromRefs: (refs) => activeClaimsFromRefs(refs),
    });
    assert.equal(code, 0);
    const holdLine = logs.find((l) => l.includes('dispatch_hold'));
    assert.ok(holdLine);
    const row = JSON.parse(holdLine);
    assert.equal(row.reason, 'invalid_entry');
    assert.equal(row.commentId, '4242');
    assert.equal(row.detail, undefined);
    assert.ok(!logs.join('\n').includes(secretLine));
  } finally {
    console.log = origLog;
  }
});

test('canary verify six legs passes and deletes scratch ref', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-pass-'));
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify(bindCanaryOutcome({ kind: i === 0 ? 'canary_win' : 'canary_lose', index: i })),
    );
  }
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: main });
  const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
  assert.equal(code, 0);
  assert.equal(client.exists(CANARY_SCRATCH_REF), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify bad indexes keeps scratch ref on failure', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-fail-'));
  const outcomes = Array.from({ length: 6 }, (_, i) => ({ kind: 'canary_lose', index: i }));
  outcomes[0].kind = 'canary_win';
  outcomes[1].index = 0;
  for (let i = 0; i < outcomes.length; i += 1) {
    fs.writeFileSync(path.join(dir, `canary-outcome-${i}.json`), JSON.stringify(bindCanaryOutcome(outcomes[i])));
  }
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: main });
  const logs = [];
  const origErr = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
    assert.equal(code, 1);
    assert.ok(logs.some((line) => line.includes('index_duplicate')));
  } finally {
    console.error = origErr;
  }
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify rejects foreign runId binding and keeps scratch', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-bind-'));
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify(bindCanaryOutcome({
        kind: i === 0 ? 'canary_win' : 'canary_lose',
        index: i,
        runId: 99999,
      })),
    );
  }
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: main });
  const logs = [];
  const origErr = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
    assert.equal(code, 1);
    assert.ok(logs.some((l) => l.includes('run_binding_mismatch')));
  } finally {
    console.error = origErr;
  }
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify rejects outcomes missing scratchRef', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-no-scratch-field-'));
  for (let i = 0; i < 6; i += 1) {
    const row = bindCanaryOutcome({ kind: i === 0 ? 'canary_win' : 'canary_lose', index: i });
    delete row.scratchRef;
    fs.writeFileSync(path.join(dir, `canary-outcome-${i}.json`), JSON.stringify(row));
  }
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: main });
  const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify rejects wrong scratchRef binding and keeps scratch', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const { canaryScratchRef } = require('./dispatch/constants');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-scratch-bind-'));
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify(bindCanaryOutcome({
        kind: i === 0 ? 'canary_win' : 'canary_lose',
        index: i,
        scratchRef: canaryScratchRef(1, 99),
      })),
    );
  }
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: main });
  const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify missing artifacts dir keeps scratch ref on failure', async () => {
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: main });
  const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: '' }));
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
});

test('canary verify bad counts keeps scratch ref on failure', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-counts-'));
  const rows = [
    { kind: 'canary_win', index: 0 },
    { kind: 'canary_win', index: 1 },
    { kind: 'canary_fatal', index: 2 },
    { kind: 'canary_lose', index: 3 },
    { kind: 'canary_lose', index: 4 },
    { kind: 'canary_lose', index: 5 },
  ];
  for (let i = 0; i < rows.length; i += 1) {
    fs.writeFileSync(path.join(dir, `canary-outcome-${i}.json`), JSON.stringify(bindCanaryOutcome(rows[i])));
  }
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: main });
  const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify sha mismatch keeps scratch ref', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mismatch-'));
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify(bindCanaryOutcome({ kind: i === 0 ? 'canary_win' : 'canary_lose', index: i })),
    );
  }
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: other });
  const logs = [];
  const origErr = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
    assert.equal(code, 1);
    assert.ok(logs.some((line) => line.includes('scratch_sha_mismatch')));
  } finally {
    console.error = origErr;
  }
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify delete failure keeps scratch ref', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-del-fail-'));
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify(bindCanaryOutcome({ kind: i === 0 ? 'canary_win' : 'canary_lose', index: i })),
    );
  }
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: main });
  const realDelete = client.deleteRef.bind(client);
  client.deleteRef = async (opts) => {
    if (opts.ref === CANARY_SCRATCH_REF) return { ok: false, error: 'cas_mismatch' };
    return realDelete(opts);
  };
  const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify scratch missing fails without delete', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-noref-'));
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify(bindCanaryOutcome({ kind: i === 0 ? 'canary_win' : 'canary_lose', index: i })),
    );
  }
  const client = createMockRefClient();
  const logs = [];
  const origErr = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
    assert.equal(code, 1);
    assert.ok(logs.some((line) => line.includes('scratch_missing')));
  } finally {
    console.error = origErr;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify list failure exits 1 without deleting scratch ref', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-list-'));
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify(bindCanaryOutcome({ kind: i === 0 ? 'canary_win' : 'canary_lose', index: i })),
    );
  }
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: main });
  client.listRefs = async () => ({ ok: false, refs: [] });
  const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify artifact parse failure exits 1 without deleting scratch ref', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-parse-'));
  fs.writeFileSync(path.join(dir, 'canary-outcome-0.json'), '{ not-json');
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: main });
  const code = await runCanaryVerify(client, canaryVerifyOpts(client, { mainSha: main, artifactsDir: dir }));
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sweep deletes lane ref with unparseable lease expiresAt', async () => {
  const client = createMockRefClient();
  const lane = 'refs/mythos/dispatch/lane-07';
  await client.createRef({ ref: lane, sha: '7'.repeat(40) });
  client.setRefMessage(lane, JSON.stringify({
    schema: 'mythos-dispatch-lease/v1',
    issue: 1,
    slice: 0,
    files: ['a.ts'],
    expiresAt: 'not-a-valid-date',
  }));
  const swept = await sweepDispatchRefs(client, {});
  assert.equal(swept.deleted.includes(lane), true);
  assert.equal(client.exists(lane), false);
});

test('closing fence marker with trailing text leaves embedded ## Files inside the fence', () => {
  const body = [
    '```',
    'example plan:',
    '## Files',
    '- quoted.js',
    '```not-a-close',
    '## Files',
    '- attacker.js',
    '```',
    '## Files',
    '- frontend/real.ts',
  ].join('\n');
  const section = parseFilesSection(body);
  assert.equal(section.kind, 'ok');
  assert.deepEqual(section.files, ['frontend/real.ts']);
});

test('parseBuildOrderIssues rejects malformed entries such as 12oops', () => {
  const { parseBuildOrderIssues } = require('./dispatch/build-order');
  const ok = parseBuildOrderIssues('11,12');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.issues, [11, 12]);
  assert.equal(parseBuildOrderIssues(null).ok, true);
  assert.deepEqual(parseBuildOrderIssues(undefined).issues, []);
  const cases = [
    '12oops',
    '+12',
    '0x12',
    '1e2',
    '12.0',
    '1.0',
    '0x10',
    '-1',
    '0',
    '\u0661\u0662', // Arabic-Indic 12
    '\uff11\uff12', // full-width 12
    '9007199254740993', // 2^53+1
    ' 12',
    '12 ',
    '012',
    '\u00a012', // NBSP then 12
    '',
    '  ',
    ',',
    '12,,13',
    '12,',
    ',12',
    '12\n',
  ];
  for (const value of cases) {
    const parsed = parseBuildOrderIssues(value);
    assert.equal(parsed.ok, false, value);
    assert.equal(parsed.reason, 'invalid_build_order', value);
  }
  const shrunk = parseBuildOrderIssues('12,,13');
  assert.equal(shrunk.ok, false);
  assert.equal(Array.isArray(shrunk.issues), false);
  const prefix = parseBuildOrderIssues('12oops');
  assert.equal(prefix.ok, false);
  assert.equal(prefix.entry, '12oops');
});

test('closing fence requires the same marker and at least the opener length', () => {
  const { stripFencedRegions } = require('./dispatch/official-plan');
  const tildeClose = [
    '```',
    '## Files',
    '- trapped.ts',
    '~~~',
    '```',
    '## Files',
    '- frontend/real.ts',
  ].join('\n');
  assert.equal(stripFencedRegions(tildeClose).includes('trapped.ts'), false);
  const tilde = parseFilesSection(tildeClose);
  assert.equal(tilde.kind, 'ok');
  assert.deepEqual(tilde.files, ['frontend/real.ts']);

  const shortClose = [
    '````',
    '## Files',
    '- trapped.ts',
    '```',
    '````',
    '## Files',
    '- frontend/real.ts',
  ].join('\n');
  assert.equal(stripFencedRegions(shortClose).includes('trapped.ts'), false);
  const shorter = parseFilesSection(shortClose);
  assert.equal(shorter.kind, 'ok');
  assert.deepEqual(shorter.files, ['frontend/real.ts']);
});

test('canary verify reports retry_requires_all_six_legs for previous-attempt outcomes', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const { canaryScratchRef } = require('./dispatch/constants');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-retry-attempt-'));
  const previousAttempt = 1;
  const currentAttempt = 2;
  const previousScratch = canaryScratchRef(CANARY_RUN_ID, previousAttempt);
  const currentScratch = canaryScratchRef(CANARY_RUN_ID, currentAttempt);
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify({
        runId: CANARY_RUN_ID,
        runAttempt: previousAttempt,
        scratchRef: previousScratch,
        kind: i === 0 ? 'canary_win' : 'canary_lose',
        index: i,
      }),
    );
  }
  const client = createMockRefClient();
  await client.createRef({ ref: currentScratch, sha: main });
  await client.createRef({ ref: previousScratch, sha: main });
  const logs = [];
  const origErr = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    const code = await runCanaryVerify(client, canaryVerifyOpts(client, {
      mainSha: main,
      artifactsDir: dir,
      runId: CANARY_RUN_ID,
      runAttempt: currentAttempt,
    }));
    assert.equal(code, 1);
    assert.ok(logs.some((l) => l.includes('retry_requires_all_six_legs')));
    assert.ok(!logs.some((l) => l.includes('run_binding_mismatch')));
  } finally {
    console.error = origErr;
  }
  assert.equal(client.exists(currentScratch), true);
  assert.equal(client.exists(previousScratch), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary verify maps delete failures to a fixed reason and never logs raw error text', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify, STABLE_DELETE_REASONS } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-del-reason-'));
  const scratch = canaryScratchRef(CANARY_RUN_ID, CANARY_RUN_ATTEMPT);
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify({
        runId: CANARY_RUN_ID,
        runAttempt: CANARY_RUN_ATTEMPT,
        scratchRef: scratch,
        kind: i === 0 ? 'canary_win' : 'canary_lose',
        index: i,
      }),
    );
  }
  const leak = 'GraphQL: expected OID 0000 was 1111, stderr=ghp_leaked_token HTTP 500 boom';
  const client = createMockRefClient();
  await client.createRef({ ref: scratch, sha: main });
  const orig = client.deleteRef;
  client.deleteRef = async (args) => {
    const result = await orig.call(client, args);
    return { ok: false, error: leak, stderr: leak, errors: [{ message: leak }], status: 500 };
  };
  const logs = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...args) => { logs.push(args.join(' ')); };
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    const code = await runCanaryVerify(client, canaryVerifyOpts(client, {
      mainSha: main,
      artifactsDir: dir,
    }));
    assert.equal(code, 1);
    const rows = logs.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['kind', 'reason', 'ref'].sort());
      assert.equal(row.kind, 'canary_verify_fail');
      assert.equal(STABLE_DELETE_REASONS.has(row.reason), true, row.reason);
      assert.equal(row.ref, scratch);
      assert.equal(row.error, undefined);
      assert.equal(row.stderr, undefined);
      assert.equal(row.errors, undefined);
    }
    const dumped = logs.join('\n');
    assert.equal(dumped.includes(leak), false);
    assert.equal(dumped.includes('ghp_leaked_token'), false);
    assert.equal(dumped.includes('GraphQL'), false);
    assert.equal(dumped.includes('stderr'), false);
    assert.equal(dumped.includes('HTTP 500'), false);
  } finally {
    console.error = origErr;
    console.log = origLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('canary verify reports retry_requires_all_six_legs when a retry downloads fewer than six outcomes', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const currentAttempt = 2;
  const scratch = canaryScratchRef(CANARY_RUN_ID, currentAttempt);
  const client = createMockRefClient();
  await client.createRef({ ref: scratch, sha: main });

  async function runWithFiles(count) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-retry-missing-'));
    for (let i = 0; i < count; i += 1) {
      fs.writeFileSync(
        path.join(dir, `canary-outcome-${i}.json`),
        JSON.stringify({
          runId: CANARY_RUN_ID,
          runAttempt: currentAttempt,
          scratchRef: scratch,
          kind: 'canary_lose',
          index: i,
        }),
      );
    }
    const logs = [];
    const origErr = console.error;
    console.error = (...args) => { logs.push(args.join(' ')); };
    try {
      const code = await runCanaryVerify(client, canaryVerifyOpts(client, {
        mainSha: main,
        artifactsDir: dir,
        runId: CANARY_RUN_ID,
        runAttempt: currentAttempt,
      }));
      return { code, logs, dir };
    } finally {
      console.error = origErr;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const count of [0, 5]) {
    const { code, logs } = await runWithFiles(count);
    assert.equal(code, 1, `count=${count}`);
    assert.ok(logs.some((l) => l.includes('retry_requires_all_six_legs')), `count=${count}`);
    assert.ok(!logs.some((l) => l.includes('run_binding_mismatch')), `count=${count}`);
    assert.equal(client.exists(scratch), true);
  }

  const firstAttemptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-first-empty-'));
  const firstLogs = [];
  const origErr = console.error;
  console.error = (...args) => { firstLogs.push(args.join(' ')); };
  try {
    const code = await runCanaryVerify(client, canaryVerifyOpts(client, {
      mainSha: main,
      artifactsDir: firstAttemptDir,
      runId: CANARY_RUN_ID,
      runAttempt: 1,
    }));
    assert.equal(code, 1);
    assert.ok(firstLogs.some((l) => l.includes('run_binding_mismatch')));
    assert.ok(!firstLogs.some((l) => l.includes('retry_requires_all_six_legs')));
  } finally {
    console.error = origErr;
    fs.rmSync(firstAttemptDir, { recursive: true, force: true });
  }
});

async function runCanaryVerifyPinned({ attempt, files = 6, deleteResult = null, kinds = null }) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const scratch = canaryScratchRef(CANARY_RUN_ID, attempt);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-pin-'));
  for (let i = 0; i < files; i += 1) {
    const kind = kinds ? kinds[i] : (i === 0 ? 'canary_win' : 'canary_lose');
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify({ runId: CANARY_RUN_ID, runAttempt: attempt, scratchRef: scratch, kind, index: i }),
    );
  }
  const client = createMockRefClient();
  await client.createRef({ ref: scratch, sha: main });
  if (deleteResult) client.deleteRef = async () => deleteResult;
  const logs = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => logs.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  let code;
  try {
    code = await runCanaryVerify(client, canaryVerifyOpts(client, {
      mainSha: main,
      artifactsDir: dir,
      runAttempt: attempt,
    }));
  } finally {
    console.error = origErr;
    console.log = origLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const rows = logs.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  return { code, logs, rows, scratch, exists: client.exists(scratch) };
}

test('canary verify with all six legs passes on attempts 1, 2 and 3 and deletes that attempt scratch ref', async () => {
  for (const attempt of [1, 2, 3]) {
    const out = await runCanaryVerifyPinned({ attempt });
    assert.equal(out.code, 0, `attempt ${attempt}`);
    assert.equal(out.exists, false);
    const ok = out.rows.find((r) => r.kind === 'canary_verify_ok');
    assert.ok(ok);
    assert.equal(ok.deleted, out.scratch);
    assert.equal(ok.runAttempt, attempt);
    assert.equal(out.rows.some((r) => r.kind === 'canary_verify_fail'), false);
  }
});

test('canary verify retry with fewer than six legs fails closed as retry_requires_all_six_legs, a first attempt does not', async () => {
  for (const attempt of [2, 3]) {
    for (const files of [0, 1, 5]) {
      const out = await runCanaryVerifyPinned({ attempt, files });
      assert.equal(out.code, 1, `attempt ${attempt} files ${files}`);
      assert.equal(out.rows.find((r) => r.kind === 'canary_verify_fail').reason, 'retry_requires_all_six_legs');
      assert.equal(out.exists, true);
    }
  }
  const first = await runCanaryVerifyPinned({ attempt: 1, files: 5 });
  assert.equal(first.code, 1);
  assert.notEqual(first.rows.find((r) => r.kind === 'canary_verify_fail').reason, 'retry_requires_all_six_legs');
});

test('canary verify delete failure logs a fixed reason: keyword-free leak is write_failed, 404 is not_found, 409 is ref_changed', async () => {
  const leak = 'HTTP 500 ghp_x boom';
  const cases = [
    [{ ok: false, error: leak }, 'write_failed'],
    [{ ok: false, error: leak, status: 500, stderr: leak, errors: [{ message: leak }] }, 'write_failed'],
    [{ ok: false, error: 'ghp_SECRETTOKEN GraphQL: Resource not accessible stderr' }, 'write_failed'],
    [{ ok: false }, 'write_failed'],
    [{ ok: false, error: leak, status: 404 }, 'not_found'],
    [{ ok: false, error: 'HTTP 404 ghp_x boom' }, 'not_found'],
    [{ ok: false, error: leak, status: 409 }, 'ref_changed'],
    [{ ok: false, error: 'conflict ghp_x boom' }, 'ref_changed'],
  ];
  for (const [deleteResult, reason] of cases) {
    const out = await runCanaryVerifyPinned({ attempt: 1, deleteResult });
    assert.equal(out.code, 1, JSON.stringify(deleteResult));
    assert.equal(out.exists, true);
    const fail = out.rows.find((r) => r.kind === 'canary_verify_fail');
    assert.deepEqual(fail, { kind: 'canary_verify_fail', reason, ref: out.scratch }, JSON.stringify(deleteResult));
    assert.doesNotMatch(out.logs.join('\n'), /ghp_|boom|HTTP 500|GraphQL|stderr|Resource not accessible/);
  }
});

test('outcomesMatchRun rejects six outcomes with the same runId but a different runAttempt', () => {
  const { outcomesMatchRun } = require('./dispatch/canary-verify');
  const runId = CANARY_RUN_ID;
  const attempt = 2;
  const other = 1;
  const scratch = canaryScratchRef(runId, attempt);
  const otherScratch = canaryScratchRef(runId, other);
  function rows(runAttempt, scratchRef) {
    return Array.from({ length: 6 }, (_, i) => ({
      runId,
      runAttempt,
      scratchRef,
      kind: i === 0 ? 'canary_win' : 'canary_lose',
      index: i,
    }));
  }
  assert.equal(outcomesMatchRun(rows(attempt, scratch), runId, attempt), true);
  assert.equal(outcomesMatchRun(rows(other, scratch), runId, attempt), false);
  assert.equal(outcomesMatchRun(rows(other, otherScratch), runId, attempt), false);
});

test('canary verify fails closed when six artifacts share runId and scratch but not runAttempt', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runCanaryVerify } = require('./dispatch/canary-verify');
  const main = 'a'.repeat(40);
  const attempt = 2;
  const other = 1;
  const scratch = canaryScratchRef(CANARY_RUN_ID, attempt);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-att-'));
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, `canary-outcome-${i}.json`),
      JSON.stringify({
        runId: CANARY_RUN_ID,
        runAttempt: other,
        scratchRef: scratch,
        kind: i === 0 ? 'canary_win' : 'canary_lose',
        index: i,
      }),
    );
  }
  const client = createMockRefClient();
  await client.createRef({ ref: scratch, sha: main });
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  let code;
  try {
    code = await runCanaryVerify(client, canaryVerifyOpts(client, {
      mainSha: main,
      artifactsDir: dir,
      runAttempt: attempt,
    }));
  } finally {
    console.error = origErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.equal(client.exists(scratch), true);
  const fail = logs.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((row) => row && row.kind === 'canary_verify_fail');
  assert.ok(fail);
  assert.ok(['run_binding_mismatch', 'retry_requires_all_six_legs'].includes(fail.reason), fail.reason);
});

test('outcomesMatchRun treats string and number runAttempt as the same attempt', () => {
  const { outcomesMatchRun } = require('./dispatch/canary-verify');
  const runId = CANARY_RUN_ID;
  const scratch = canaryScratchRef(runId, 2);
  function rows(runAttempt) {
    return Array.from({ length: 6 }, (_, i) => ({
      runId,
      runAttempt,
      scratchRef: scratch,
      kind: i === 0 ? 'canary_win' : 'canary_lose',
      index: i,
    }));
  }
  // Match: string "2" against number 2, both directions. STR2 (raw
  // row.runAttempt !== runAttempt) dies on numeric rows vs a string arg.
  // STR1 (drop Number() on row.runAttempt vs parsed att) dies when the
  // row field is the string "2" and att is the number 2.
  assert.equal(outcomesMatchRun(rows(2), runId, '2'), true);
  assert.equal(outcomesMatchRun(rows('2'), runId, 2), true);
  // Mismatched pairs must not match.
  assert.equal(outcomesMatchRun(rows('2'), runId, 3), false);
  assert.equal(outcomesMatchRun(rows(2), runId, '3'), false);
});
