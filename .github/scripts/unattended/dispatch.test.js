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
} = require('./dispatch/claim');
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
  const { winners } = await concurrentSlotRace(client, 0, 'a'.repeat(40), 20);
  assert.equal(winners, 1);
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
  await client.createRef({ ref: bad, sha: 'e'.repeat(40) });
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