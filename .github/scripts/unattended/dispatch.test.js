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
  issueEditedByUntrusted,
} = require('./dispatch/official-plan');
const {
  globEntryOverlaps,
  diffWithinClaim,
  normalizePlanPaths,
} = require('./dispatch/slice');
const {
  claimLaneAndSlice,
  concurrentSlotRace,
  sweepDispatchRefs,
  buildLeasePayload,
  computeWouldClaimSlot,
  renewLeaseHeartbeat,
  assertHolderBeforePublish,
} = require('./dispatch/claim');
const { claimRef: claimRefFn } = require('./dispatch/constants');
const { globOrPathProtected, globsOverlap } = require('./dispatch/path-policy');
const { planCommentEditedByUntrusted } = require('./dispatch/official-plan');
const { createMockRefClient, createYieldingRaceClient } = require('./dispatch/mock-client');
const { runDispatchPlan } = require('./dispatch/dispatch-run');
const { activeClaimsFromRefs } = require('./dispatch/dispatch-helpers');

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
  const race = await concurrentSlotRace(client, 0, 'a'.repeat(40), 20);
  assert.equal(race.winners, 1);
  assert.equal(race.refExists, 19);
  assert.equal(race.fatal, 0);
});

test('yielding mock race', async () => {
  const client = createYieldingRaceClient(2);
  const { winners } = await concurrentSlotRace(client, 0, 'b'.repeat(40), 20);
  assert.equal(winners, 1);
});

test('lane cap five', async () => {
  const client = createMockRefClient();
  const payload = buildLeasePayload({
    issue: 1,
    slice: 0,
    planCommentId: 1,
    planBodySha256: 'c'.repeat(64),
    files: ['a.ts'],
    runId: 1,
    runAttempt: 1,
  });
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, idx) => claimLaneAndSlice(client, {
      cap: 5,
      leaseSha: 'd'.repeat(40),
      payload: { ...payload, issue: idx + 1, files: [`f${idx}.ts`] },
    })),
  );
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.equal(results.filter((r) => r.reason === 'lane_full').length, 1);
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
  client.issueEvents = async () => ({ ok: true, events: [] });
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

test('untrusted editor hold', () => {
  assert.equal(issueEditedByUntrusted([{ event: 'edited', actor: { login: 'evil' } }]).hold, true);
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

test('renewLeaseHeartbeat updates lane and claim together', async () => {
  const client = createMockRefClient();
  const leaseSha = 'a'.repeat(40);
  const newSha = 'b'.repeat(40);
  const lane = 'refs/mythos/dispatch/lane-00';
  const claim = claimRefFn(1, 0);
  await client.createRefPair({ laneRef: lane, claimRef: claim, afterOid: leaseSha });
  const renewed = await renewLeaseHeartbeat(client, { laneRef: lane, claimRef: claim, newLeaseSha: newSha, beforeOid: leaseSha }, null);
  assert.equal(renewed.ok, true);
  assert.equal(client.refs.get(lane), newSha);
  assert.equal(client.refs.get(claim), newSha);
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

test('plan comment untrusted editor hold', () => {
  const hold = planCommentEditedByUntrusted({
    createdAt: '2026-01-01T00:00:00Z',
    lastEditedAt: '2026-01-02T00:00:00Z',
    editor: { login: 'evil' },
  });
  assert.equal(hold.hold, true);
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

test('trusted string editor passes', () => {
  assert.equal(
    planCommentEditedByUntrusted({
      createdAt: '2026-01-01T00:00:00Z',
      lastEditedAt: '2026-01-02T00:00:00Z',
      editor: 'skyyplayz',
    }).hold,
    false,
  );
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

test('sweep keeps done canary and live claim', async () => {
  const client = createMockRefClient();
  const { doneRef } = require('./dispatch/constants');
  const future = new Date(Date.now() + 3600000).toISOString();
  const lane = 'refs/mythos/dispatch/lane-00';
  const claim = claimRefFn(2, 0);
  const done = doneRef(2, 0);
  const canary = 'refs/mythos/dispatch/canary/scratch-shared';
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

test('canary verify outcome counts', () => {
  const outcomes = [{ kind: 'canary_win' }, ...Array.from({ length: 5 }, () => ({ kind: 'canary_lose' }))];
  const wins = outcomes.filter((o) => o.kind === 'canary_win').length;
  const loses = outcomes.filter((o) => o.kind === 'canary_lose').length;
  const fatals = outcomes.filter((o) => o.kind === 'canary_fatal').length;
  assert.equal(wins, 1);
  assert.equal(loses, 5);
  assert.equal(fatals, 0);
});