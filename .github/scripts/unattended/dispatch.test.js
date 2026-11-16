'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { clampLaneCap, slotRef, claimRef, leaseMessage, parseLeaseMessage, isExpired } = require('./dispatch/constants');
const { findOfficialPlan, parseFilesSection } = require('./dispatch/official-plan');
const { pathsOverlap, diffWithinClaim, anyProtectedInClaim } = require('./dispatch/slice');
const {
  claimLaneSlot,
  claimSliceIdentity,
  concurrentSlotRace,
  sweepExpiredLeases,
  buildLeasePayload,
} = require('./dispatch/claim');
const { parseBuildOrderIssues, pickNextBuildOrderIssue } = require('./dispatch/build-order');
const { createMockRefClient } = require('./dispatch/mock-client');
const { activeClaimsFromRefs, runDispatchPlan } = require('./dispatch/dispatch-run');

test('clampLaneCap bounds 1..20', () => {
  assert.equal(clampLaneCap('0'), 1);
  assert.equal(clampLaneCap('5'), 5);
  assert.equal(clampLaneCap('99'), 20);
  assert.equal(clampLaneCap(''), 5);
});

test('official plan requires exact ## Files heading', () => {
  const plan = findOfficialPlan([
    {
      id: '1',
      databaseId: 1,
      author: { login: 'SkyyPlayz' },
      body: '### Files\nfrontend/a.ts',
      createdAt: '2026-01-02T00:00:00Z',
    },
    {
      id: '2',
      databaseId: 2,
      author: { login: 'SkyyPlayz' },
      body: '## Files\nfrontend/a.ts\nfrontend/b.ts',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]);
  assert.equal(plan.databaseId, 2);
  assert.deepEqual(plan.files, ['frontend/a.ts', 'frontend/b.ts']);
});

test('parseFilesSection accepts bullet lines', () => {
  const files = parseFilesSection('## Files\n- `frontend/x.ts`\n- frontend/y.ts');
  assert.deepEqual(files, ['frontend/x.ts', 'frontend/y.ts']);
});

test('pathsOverlap detects shared globs', () => {
  assert.equal(pathsOverlap(['frontend/**'], ['frontend/a.ts']), true);
  assert.equal(pathsOverlap(['electron-main/foo.ts'], ['frontend/**']), false);
});

test('diffWithinClaim rejects paths outside slice', () => {
  const result = diffWithinClaim([{ filename: 'other.ts' }], ['frontend/a.ts']);
  assert.equal(result.ok, false);
});

test('protected plan files trigger hold', () => {
  assert.equal(anyProtectedInClaim(['.github/workflows/ci.yml']), true);
  assert.equal(anyProtectedInClaim(['frontend/a.ts']), false);
});

test('parseBuildOrderIssues preserves order', () => {
  assert.deepEqual(parseBuildOrderIssues('12, 8, 8 , foo'), [12, 8, 8]);
});

test('pickNextBuildOrderIssue skips claimed issues', () => {
  const pick = pickNextBuildOrderIssue([10, 11], [{ issue: 10, expired: false }], {
    10: { state: 'OPEN' },
    11: { state: 'OPEN' },
  });
  assert.equal(pick.issue, 11);
});

test('20-way concurrent race yields one winner per slot', async () => {
  const client = createMockRefClient();
  const sha = 'a'.repeat(40);
  const { winners, ref } = await concurrentSlotRace(client, 0, sha, 20);
  assert.equal(ref, slotRef(0));
  assert.equal(winners, 1);
  assert.equal(client.refs.size, 1);
});

test('lane cap five allows five concurrent slots', async () => {
  const client = createMockRefClient();
  const sha = 'b'.repeat(40);
  const payload = buildLeasePayload({
    issue: 1,
    slice: 0,
    planCommentId: 9,
    planBodySha256: 'c'.repeat(64),
    runId: 1,
    runAttempt: 1,
  });
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, idx) => claimLaneSlot(client, {
      cap: 5,
      leaseSha: sha,
      payload: { ...payload, issue: idx + 1 },
    })),
  );
  const ok = results.filter((row) => row.ok);
  const full = results.filter((row) => !row.ok && row.reason === 'lane_full');
  assert.equal(ok.length, 5);
  assert.equal(full.length, 1);
});

test('slice identity ref prevents duplicate slice claim', async () => {
  const client = createMockRefClient();
  const sha = 'd'.repeat(40);
  const first = await claimSliceIdentity(client, {
    issue: 42,
    slice: 0,
    planBodySha256: 'e'.repeat(64),
    leaseSha: sha,
  });
  const second = await claimSliceIdentity(client, {
    issue: 42,
    slice: 0,
    planBodySha256: 'e'.repeat(64),
    leaseSha: sha,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'slice_already_claimed');
  assert.equal(claimRef(42, 0, 'e'.repeat(64)), first.ref);
});

test('sweepExpiredLeases deletes stale refs only', async () => {
  const client = createMockRefClient();
  const ref = slotRef(0);
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  await client.createRef({ ref, sha: 'f'.repeat(40) });
  client.setRefMessage(ref, leaseMessage({
    issue: 1,
    slice: 0,
    planCommentId: 1,
    planBodySha256: 'a',
    runId: 1,
    runAttempt: 1,
    claimedAt: past,
    expiresAt: past,
  }));
  const ref2 = slotRef(1);
  await client.createRef({ ref: ref2, sha: 'f'.repeat(40) });
  client.setRefMessage(ref2, leaseMessage({
    issue: 2,
    slice: 0,
    planCommentId: 2,
    planBodySha256: 'b',
    runId: 1,
    runAttempt: 1,
    claimedAt: new Date().toISOString(),
    expiresAt: future,
  }));
  const swept = await sweepExpiredLeases(client, { now: new Date() });
  assert.equal(swept.deleted.length, 1);
  assert.equal(swept.deleted[0], ref);
  assert.equal(client.exists(ref2), true);
});

test('lease message round-trip', () => {
  const raw = leaseMessage({
    issue: 3,
    slice: 1,
    planCommentId: 88,
    planBodySha256: 'aa',
    runId: 9,
    runAttempt: 2,
    claimedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T02:00:00.000Z',
  });
  const parsed = parseLeaseMessage(raw);
  assert.equal(parsed.issue, 3);
  assert.equal(isExpired(parsed, new Date('2026-01-01T01:00:00.000Z')), false);
  assert.equal(isExpired(parsed, new Date('2026-01-01T03:00:00.000Z')), true);
});

test('activeClaimsFromRefs marks expiry', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const rows = activeClaimsFromRefs([{
    ref: slotRef(0),
    message: leaseMessage({
      issue: 5,
      slice: 0,
      planCommentId: 1,
      planBodySha256: 'x',
      runId: 1,
      runAttempt: 1,
      claimedAt: past,
      expiresAt: past,
    }),
  }]);
  assert.equal(rows[0].expired, true);
});

test('dry-run dispatch logs would_claim without ref writes', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => ({
    ok: true,
    comments: [{
      id: 'c1',
      databaseId: 100,
      author: { login: 'SkyyPlayz' },
      createdAt: '2026-01-01T00:00:00Z',
      body: '## Files\nfrontend/dry.ts',
    }],
  });
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const code = await runDispatchPlan({
      MODE: 'dry-run',
      CONTROL_TOKEN: 'fake',
      client,
      issueMeta: { 99: { state: 'OPEN' } },
      readDispatchSwitchesFn: () => ({ ok: true, enabled: true }),
      readRepoVariableFn: (_repo, _token, name) => {
        if (name === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '99' };
        if (name === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
        return { ok: true, value: null };
      },
    });
    assert.equal(code, 0);
    assert.equal(client.refs.size, 0);
    assert.ok(lines.some((line) => line.includes('would_claim')));
  } finally {
    process.stdout.write = orig;
  }
});