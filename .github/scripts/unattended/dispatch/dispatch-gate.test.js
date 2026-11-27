'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDispatchClients } = require('./dispatch-client');
const { createMockRefClient } = require('./mock-client');
const { runDispatchPlan } = require('./dispatch-run');
const { sweepDispatchRefs } = require('./claim');
const { recordDispatchAttempt } = require('./slice-progress');
const { attemptsRef, claimRef, leaseMessage, canaryScratchRef, doneRef, MAX_DISPATCH_ATTEMPTS } = require('./constants');
const { attemptsMessage } = require('./slice-progress');
const { readDispatchSwitches } = require('./switch');
const { runCanaryVerify } = require('./canary-verify');
const { tryCreateRefPair } = require('./claim');
const { verifyPlanCommentEditors, findOfficialPlan, canonicalAuthorLogin } = require('./official-plan');
const { ATTEMPTS_SCHEMA } = require('./slice-progress');
const { activeClaimsFromRefs } = require('./dispatch-helpers');
const { refUpdateCreate, refUpdateDelete, refUpdateRenew } = require('./refs-graphql');

const MAIN = 'a'.repeat(40);
const CANARY_RUN_ID = 4242;
const CANARY_RUN_ATTEMPT = 1;
const CANARY_SCRATCH_REF = canaryScratchRef(CANARY_RUN_ID, CANARY_RUN_ATTEMPT);
const gradePassOk = () => ({ ok: true, marker: {} });

function bindCanaryArtifact(row) {
  return {
    runId: CANARY_RUN_ID,
    runAttempt: CANARY_RUN_ATTEMPT,
    scratchRef: CANARY_SCRATCH_REF,
    ...row,
  };
}

function assertNoLaneOrClaimWrites(client) {
  assert.equal(client.updateLog.length, 0);
  for (const ref of client.refs.keys()) {
    assert.doesNotMatch(ref, /\/lane-\d{2}$/);
    assert.doesNotMatch(ref, /\/claim\/\d+-\d+$/);
  }
}

function actEnv(client, extra = {}) {
  return {
    MODE: 'act',
    client,
    MAIN_SHA: MAIN,
    readDispatchSwitchesFn: async () => ({ ok: true, enabled: true, unattended: true, dispatch: true }),
    readRepoVariableFn: async (_r, _t, n) => {
      if (n === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '1' };
      if (n === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
      return { ok: true, value: null };
    },
    findBoundPlanPass: gradePassOk,
    activeClaimsFromRefs: (refs) => activeClaimsFromRefs(refs),
    ...extra,
  };
}

function planComments() {
  const body = '## Files\n- a.ts';
  return {
    ok: true,
    comments: [{
      id: '99',
      databaseId: 99,
      nodeId: 'IC_kwDOPlan99',
      author: { login: 'SkyyPlayz' },
      body,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }],
  };
}

test('getRef on real client shape returns commit message for attempts parsing', async () => {
  const sha = 'c'.repeat(40);
  const msg = attemptsMessage({ count: 2, lastAttemptAt: new Date().toISOString() });
  const gh = (args) => {
    const flat = args.map((a) => String(a));
    if (flat.some((a) => a.includes('/git/ref/'))) {
      return { status: 0, stdout: JSON.stringify({ object: { sha } }) };
    }
    if (flat.some((a) => a.includes('/git/commits/'))) {
      return { status: 0, stdout: msg };
    }
    return { status: 0, stdout: '[]' };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  const got = await read.getRef({ ref: attemptsRef(1, 0) });
  assert.equal(got.ok, true);
  assert.equal(got.sha, sha);
  assert.equal(got.message, msg);
  const parsed = JSON.parse(got.message);
  assert.equal(parsed.schema, ATTEMPTS_SCHEMA);
  assert.equal(parsed.count, 2);
});

test('claim sweep act again increments attempts after expired lease sweep', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const lane = 'refs/mythos/dispatch/lane-00';
  const claim = claimRef(1, 0);
  let code = await runDispatchPlan(actEnv(client));
  assert.equal(code, 0);
  const got1 = await client.getRef({ ref: attemptsRef(1, 0) });
  assert.match(got1.message, /"count":1/);
  assert.equal((await client.getRef({ ref: lane })).ok, true);
  const past = new Date(Date.now() - 60_000).toISOString();
  const expired = leaseMessage({
    issue: 1,
    slice: 0,
    files: ['a.ts'],
    planCommentId: 99,
    planBodySha256: 'x'.repeat(64),
    runId: 1,
    runAttempt: 1,
    claimedAt: past,
    expiresAt: past,
  });
  client.setRefMessage(lane, expired);
  client.setRefMessage(claim, expired);
  const swept = await sweepDispatchRefs(client, { reReadSwitch: async () => ({ ok: true, enabled: true }) });
  assert.equal(swept.deleted.includes(lane), true);
  assert.equal(swept.deleted.includes(claim), true);
  assert.equal((await client.getRef({ ref: lane })).ok, false);
  client.setRefMessage(
    attemptsRef(1, 0),
    attemptsMessage({ count: 1, lastAttemptAt: '2020-01-01T00:00:00Z' }),
  );
  code = await runDispatchPlan(actEnv(client));
  assert.equal(code, 0);
  const got2 = await client.getRef({ ref: attemptsRef(1, 0) });
  assert.match(got2.message, /"count":2/);
  client.setRefMessage(lane, expired);
  client.setRefMessage(claim, expired);
  await sweepDispatchRefs(client, { reReadSwitch: async () => ({ ok: true, enabled: true }) });
  client.setRefMessage(
    attemptsRef(1, 0),
    attemptsMessage({ count: 2, lastAttemptAt: '2020-01-01T00:00:00Z' }),
  );
  code = await runDispatchPlan(actEnv(client));
  assert.equal(code, 0);
  const got3 = await client.getRef({ ref: attemptsRef(1, 0) });
  assert.match(got3.message, /"count":3/);
});

test('act dispatch_claimed flow records attempt after holder check', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const code = await runDispatchPlan(actEnv(client));
  console.log = orig;
  assert.equal(code, 0);
  assert.ok(logs.some((l) => l.includes('dispatch_claimed')));
  const got = await client.getRef({ ref: attemptsRef(1, 0) });
  assert.equal(got.ok, true);
  assert.match(got.message, /"count":1/);
});

test('act hold when recordDispatchAttempt fails releases claim pair', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const origCreate = client.createRef.bind(client);
  client.createRef = async (args) => {
    if (String(args.ref).includes('/attempts/')) return { ok: false, fatal: true, error: 'denied' };
    return origCreate(args);
  };
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const lane = 'refs/mythos/dispatch/lane-00';
    const claim = claimRef(1, 0);
    const code = await runDispatchPlan(actEnv(client));
    assert.equal(code, 1);
    assert.ok(errs.some((l) => l.includes('attempt record failed')));
    assert.equal((await client.getRef({ ref: lane })).ok, false);
    assert.equal((await client.getRef({ ref: claim })).ok, false);
  } finally {
    console.error = origErr;
  }
});

test('act mode without findBoundPlanPass holds plan_not_graded and writes no refs', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client, { findBoundPlanPass: undefined }));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('plan_not_graded')));
    assert.equal(client.updateLog.length, 0);
  } finally {
    console.log = orig;
  }
});

test('REST comment edited holds when GraphQL lists untrusted editor', async () => {
  const client = createMockRefClient();
  client.issueCommentContentEdits = async () => ({
    ok: true,
    complete: true,
    editors: [{ login: 'evil', __typename: 'User' }],
  });
  const official = findOfficialPlan([{
    id: '1',
    databaseId: 1,
    author: { login: 'SkyyPlayz' },
    body: '## Files\n- a.ts',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  }]);
  assert.ok(official && !official.hold);
  const hold = await verifyPlanCommentEditors(client, 1, official);
  assert.equal(hold.hold, true);
  assert.equal(hold.reason, 'untrusted_editor');
});

test('bot plan author canonical login matches OFFICIAL_PLAN_AUTHORS', () => {
  const login = canonicalAuthorLogin({ login: 'SkyHigh-Mythos-Bot', type: 'Bot' });
  assert.equal(login, 'skyhigh-mythos-bot[bot]');
  const plan = findOfficialPlan([{
    id: '2',
    databaseId: 2,
    author: { login: 'SkyHigh-Mythos-Bot', type: 'Bot' },
    body: '## Files\n- pkg/x.ts',
    createdAt: '1',
    updatedAt: '1',
  }]);
  assert.ok(plan && plan.files);
});

function switchGh(values) {
  return (args) => {
    const path = String(args[1] || '');
    if (path.includes('UNATTENDED_ENABLED')) {
      return { status: 0, stdout: `${values.unattended}\n` };
    }
    if (path.includes('MYTHOS_DISPATCH_ENABLED')) {
      return { status: 0, stdout: `${values.dispatch}\n` };
    }
    return { status: 0, stdout: '' };
  };
}

test('readDispatchSwitches requires both UNATTENDED and DISPATCH true', () => {
  const ghFn = switchGh({ unattended: 'true', dispatch: 'false' });
  const s = readDispatchSwitches('Sky-High-Infinite-Techwork/Mythos-Writer', 'tok', ghFn);
  assert.equal(s.ok, true);
  assert.equal(s.enabled, false);
});

test('readDispatchSwitches true false and false true stay disabled', () => {
  const tF = readDispatchSwitches('Sky-High-Infinite-Techwork/Mythos-Writer', 'tok', switchGh({ unattended: 'true', dispatch: 'false' }));
  assert.equal(tF.enabled, false);
  const fT = readDispatchSwitches('Sky-High-Infinite-Techwork/Mythos-Writer', 'tok', switchGh({ unattended: 'false', dispatch: 'true' }));
  assert.equal(fT.enabled, false);
  const tT = readDispatchSwitches('Sky-High-Infinite-Techwork/Mythos-Writer', 'tok', switchGh({ unattended: 'true', dispatch: 'true' }));
  assert.equal(tT.enabled, true);
});

test('act inert returns 0 when switches not true', async () => {
  const client = createMockRefClient();
  const code = await runDispatchPlan({
    MODE: 'act',
    client,
    readDispatchSwitchesFn: async () => ({ ok: true, enabled: false }),
    readRepoVariableFn: async () => ({ ok: true, value: '1' }),
  });
  assert.equal(code, 0);
});

test('tryCreateRefPair fatal auth error is not ref_exists', async () => {
  const client = createMockRefClient();
  client.createRefPair = async () => ({
    ok: false,
    fatal: true,
    status: 403,
    error: 'denied',
  });
  const attempt = await tryCreateRefPair(client, {
    laneRef: 'refs/mythos/dispatch/lane-00',
    claimRef: 'refs/mythos/dispatch/claim/1-0',
    leaseSha: MAIN,
  });
  assert.equal(attempt.fatal, true);
  assert.equal(attempt.refExists, undefined);
});

test('tryCreateRefPair fatal transport rolls back lane half we hold', async () => {
  const client = createMockRefClient();
  const lane = 'refs/mythos/dispatch/lane-00';
  const claim = 'refs/mythos/dispatch/claim/1-0';
  client.createRefPair = async ({ laneRef, afterOid }) => {
    await client.createRef({ ref: laneRef, sha: afterOid });
    return { ok: false, fatal: true, error: 'transport_timeout' };
  };
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    const attempt = await tryCreateRefPair(client, { laneRef: lane, claimRef: claim, leaseSha: MAIN });
    assert.equal(attempt.fatal, true);
    assert.equal(client.exists(lane), false);
    assert.equal(client.exists(claim), false);
    assert.ok(logs.some((l) => l.includes('dispatch_ref_pair_rollback')));
  } finally {
    console.error = origErr;
  }
});

test('canary verify returns 1 when switch off after scratch match', async () => {
  const client = createMockRefClient();
  const dir = require('node:fs').mkdtempSync(`${require('node:os').tmpdir()}/canary-`);
  for (let i = 0; i < 6; i += 1) {
    require('node:fs').writeFileSync(
      `${dir}/canary-outcome-${i}.json`,
      JSON.stringify(bindCanaryArtifact({ kind: i === 0 ? 'canary_win' : 'canary_lose', index: i })),
    );
  }
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: MAIN });
  let calls = 0;
  const code = await runCanaryVerify(client, {
    reReadSwitch: async () => {
      calls += 1;
      return { ok: true, enabled: calls === 1 };
    },
    mainSha: MAIN,
    artifactsDir: dir,
    runId: CANARY_RUN_ID,
    runAttempt: CANARY_RUN_ATTEMPT,
  });
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});

test('canary verify returns 1 when initial switch read fails', async () => {
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: MAIN });
  const code = await runCanaryVerify(client, {
    reReadSwitch: async () => ({ ok: false, enabled: false }),
    mainSha: MAIN,
    artifactsDir: require('node:fs').mkdtempSync(`${require('node:os').tmpdir()}/canary-`),
    runId: CANARY_RUN_ID,
    runAttempt: CANARY_RUN_ATTEMPT,
  });
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
});

test('canary verify returns 1 when writes disabled before scratch check', async () => {
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: MAIN });
  const code = await runCanaryVerify(client, {
    reReadSwitch: async () => ({ ok: true, enabled: false }),
    mainSha: MAIN,
    artifactsDir: require('node:fs').mkdtempSync(`${require('node:os').tmpdir()}/canary-`),
    runId: CANARY_RUN_ID,
    runAttempt: CANARY_RUN_ATTEMPT,
  });
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
});

test('canary verify returns 1 when list fails after outcomes score', async () => {
  const fs = require('node:fs');
  const client = createMockRefClient();
  await client.createRef({ ref: CANARY_SCRATCH_REF, sha: MAIN });
  const dir = fs.mkdtempSync(`${require('node:os').tmpdir()}/canary-gate-list-`);
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      `${dir}/canary-outcome-${i}.json`,
      JSON.stringify(bindCanaryArtifact({ kind: i === 0 ? 'canary_win' : 'canary_lose', index: i })),
    );
  }
  client.listRefs = async () => ({ ok: false, refs: [] });
  const code = await runCanaryVerify(client, {
    reReadSwitch: async () => ({ ok: true, enabled: true }),
    mainSha: MAIN,
    artifactsDir: dir,
    runId: CANARY_RUN_ID,
    runAttempt: CANARY_RUN_ATTEMPT,
  });
  assert.equal(code, 1);
  assert.equal(client.exists(CANARY_SCRATCH_REF), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('act with graded plan holds untrusted editor and writes no claim refs', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => ({
    ok: true,
    comments: [{
      id: '99',
      databaseId: 99,
      author: { login: 'SkyyPlayz' },
      body: '## Files\n- a.ts',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    }],
  });
  client.issueCommentContentEdits = async () => ({
    ok: true,
    complete: true,
    editors: [{ login: 'evil', __typename: 'User' }],
  });
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const code = await runDispatchPlan(actEnv(client));
  assert.equal(code, 0);
  assertNoLaneOrClaimWrites(client);
});

test('act with graded plan holds protected path and writes no claim refs', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => ({
    ok: true,
    comments: [{
      id: '99',
      databaseId: 99,
      author: { login: 'SkyyPlayz' },
      body: '## Files\n- a.ts\n- .github/workflows/x.yml',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }],
  });
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const code = await runDispatchPlan(actEnv(client));
  assert.equal(code, 0);
  assertNoLaneOrClaimWrites(client);
});

test('act skips closed issue without ref writes', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => ({
    ok: true,
    comments: [{
      id: '99',
      databaseId: 99,
      author: { login: 'SkyyPlayz' },
      body: '## Files\n- a.ts',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }],
  });
  client.getIssue = async () => ({ ok: true, issue: { state: 'closed' } });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client, {
      readRepoVariableFn: async (_r, _t, n) => {
        if (n === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '99' };
        if (n === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
        return { ok: true, value: null };
      },
    }));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('issue_not_open')));
  } finally {
    console.log = orig;
  }
  assertNoLaneOrClaimWrites(client);
});

test('act moves past closed issue to claim the next build-order issue', async () => {
  const client = createMockRefClient();
  client.issueComments = async ({ issue }) => ({
    ok: true,
    comments: [{
      id: String(issue),
      databaseId: issue,
      author: { login: 'SkyyPlayz' },
      body: '## Files\n- a.ts',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }],
  });
  client.getIssue = async ({ issue }) => ({
    ok: true,
    issue: issue === 99 ? { state: 'closed' } : { state: 'open' },
  });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client, {
      readRepoVariableFn: async (_r, _t, n) => {
        if (n === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '99,1' };
        if (n === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
        return { ok: true, value: null };
      },
    }));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('issue_not_open') && l.includes('"issue":99')));
    assert.ok(logs.some((l) => l.includes('dispatch_claimed') && l.includes('"issue":1')));
  } finally {
    console.log = orig;
  }
  assert.equal(client.exists(claimRef(1, 0)), true);
});

test('act skips pull request issue with zero writes', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => ({
    ok: true,
    comments: [{
      id: '7',
      databaseId: 7,
      author: { login: 'SkyyPlayz' },
      body: '## Files\n- a.ts',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }],
  });
  client.getIssue = async () => ({ ok: true, issue: { state: 'open', pull_request: {} } });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('issue_is_pr')));
  } finally {
    console.log = orig;
  }
  assertNoLaneOrClaimWrites(client);
});

test('verifyPlanCommentEditors holds on empty attributable edit history', async () => {
  const client = createMockRefClient();
  client.issueCommentContentEdits = async () => ({
    ok: true,
    complete: true,
    editors: [],
  });
  const official = findOfficialPlan([{
    id: '1',
    databaseId: 1,
    author: { login: 'SkyyPlayz' },
    body: '## Files\n- a.ts',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  }]);
  const hold = await verifyPlanCommentEditors(client, 1, official);
  assert.equal(hold.hold, true);
  assert.equal(hold.reason, 'editor_history_incomplete');
});

test('verifyPlanCommentEditors holds on editor_fetch_failed', async () => {
  const client = createMockRefClient();
  client.issueCommentContentEdits = async () => ({ ok: false, editors: [], error: 'graphql_http' });
  const official = findOfficialPlan([{
    id: '1',
    databaseId: 1,
    author: { login: 'SkyyPlayz' },
    body: '## Files\n- a.ts',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  }]);
  const hold = await verifyPlanCommentEditors(client, 1, official);
  assert.equal(hold.hold, true);
  assert.equal(hold.reason, 'editor_fetch_failed');
});

test('recordDispatchAttempt blocks ref write when switch flips before mutation', async () => {
  const client = createMockRefClient();
  const ref = attemptsRef(3, 0);
  await client.createRef({ ref, sha: 'f'.repeat(40) });
  client.setRefMessage(ref, attemptsMessage({ count: 1, lastAttemptAt: new Date().toISOString() }));
  let calls = 0;
  const result = await recordDispatchAttempt(client, 3, 0, {
    reReadSwitch: async () => {
      calls += 1;
      return { ok: true, enabled: calls < 3 };
    },
    mintLeaseSha: async () => 'e'.repeat(40),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'switch_off');
  const got = await client.getRef({ ref });
  assert.match(got.message, /"count":1/);
});

test('sweep aborts after switch off between stale deletes', async () => {
  const client = createMockRefClient();
  const past = new Date(Date.now() - 60_000).toISOString();
  const staleLane = async (slot) => {
    const lane = `refs/mythos/dispatch/lane-${String(slot).padStart(2, '0')}`;
    await client.createRef({ ref: lane, sha: `${slot + 4}`.repeat(40).slice(0, 40) });
    client.setRefMessage(lane, leaseMessage({
      issue: slot + 1,
      slice: 0,
      files: [`f${slot}.ts`],
      planCommentId: 1,
      planBodySha256: 'a'.repeat(64),
      runId: 1,
      runAttempt: 1,
      claimedAt: past,
      expiresAt: past,
    }));
    return lane;
  };
  const lane0 = await staleLane(0);
  const lane1 = await staleLane(1);
  let reads = 0;
  const swept = await sweepDispatchRefs(client, {
    reReadSwitch: async () => {
      reads += 1;
      return { ok: true, enabled: reads === 1 };
    },
  });
  assert.equal(swept.aborted, true);
  assert.equal(swept.errors[0], 'switch_off');
  assert.equal(swept.deleted.length, 1);
  assert.equal((await client.getRef({ ref: lane1 })).ok, true);
  assert.equal((await client.getRef({ ref: lane0 })).ok, false);
});

test('sweep ok false when a delete fails', async () => {
  const client = createMockRefClient();
  const past = new Date(Date.now() - 60_000).toISOString();
  const lane = 'refs/mythos/dispatch/lane-02';
  await client.createRef({ ref: lane, sha: '2'.repeat(40) });
  client.setRefMessage(lane, leaseMessage({
    issue: 2,
    slice: 0,
    files: ['a.ts'],
    planCommentId: 1,
    planBodySha256: 'b'.repeat(64),
    runId: 1,
    runAttempt: 1,
    claimedAt: past,
    expiresAt: past,
  }));
  const orig = client.deleteRef.bind(client);
  client.deleteRef = async (args) => {
    if (args.ref === lane) return { ok: false, error: 'denied' };
    return orig(args);
  };
  const swept = await sweepDispatchRefs(client, {});
  assert.equal(swept.ok, false);
  assert.equal(swept.deleted.length, 0);
  assert.equal(swept.errors.includes(lane), true);
});

test('assertDispatchRef rejects refs outside dispatch namespace', () => {
  const { assertDispatchRef, ALLOWED_DISPATCH_REF } = require('./refs-graphql');
  const main = 'refs/heads/main';
  const oid = 'a'.repeat(40);
  assert.throws(() => refUpdateCreate(main, oid));
  assert.throws(() => refUpdateDelete(main, oid));
  assert.throws(() => refUpdateRenew(main, oid, oid));
  const allowed = [
    'refs/mythos/dispatch/lane-00',
    'refs/mythos/dispatch/claim/12-0',
    'refs/mythos/dispatch/attempts/12-0',
    'refs/mythos/dispatch/done/12-0',
    'refs/mythos/dispatch/canary/scratch-9-1',
  ];
  for (const ref of allowed) {
    assert.equal(ALLOWED_DISPATCH_REF.test(ref), true, ref);
    assert.equal(assertDispatchRef(ref), ref);
  }
  const lookalikes = [
    'refs/mythos/dispatch/../heads/x',
    'refs/mythos/dispatch/lane-00/../heads/main',
    'refs/mythos/dispatch/lane-0',
    'refs/mythos/dispatch/lane-000',
    'refs/mythos/dispatch/canary/scratch-1',
    'refs/mythos/dispatch/canary/other-1-1',
    'refs/mythos/dispatch/',
    'refs/mythos/dispatch/foo',
    'refs/mythos/dispatch/lane-00-extra',
  ];
  for (const ref of lookalikes) {
    assert.equal(ALLOWED_DISPATCH_REF.test(ref), false, ref);
    assert.throws(() => assertDispatchRef(ref));
    assert.throws(() => refUpdateCreate(ref, oid));
  }
});

test('act hold when grade pass is not ok', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client, {
      findBoundPlanPass: () => ({ ok: false, reason: 'no_pass_grade' }),
    }));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('dispatch_hold') && l.includes('no_pass_grade')));
    assert.equal(client.updateLog.length, 0);
  } finally {
    console.log = orig;
  }
});

test('act dispatch_skip when slice is done', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  await client.createRef({ ref: doneRef(1, 0), sha: MAIN });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('slice_done')));
  } finally {
    console.log = orig;
  }
});

test('act dispatch_skip when attempts hit max_attempts', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const ref = attemptsRef(1, 0);
  await client.createRef({ ref, sha: 'b'.repeat(40) });
  client.setRefMessage(ref, attemptsMessage({
    count: MAX_DISPATCH_ATTEMPTS,
    lastAttemptAt: '2020-01-01T00:00:00Z',
  }));
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('"reason":"max_attempts"')));
  } finally {
    console.log = orig;
  }
});

test('act dispatch_skip when attempts are in backoff', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const ref = attemptsRef(1, 0);
  await client.createRef({ ref, sha: 'b'.repeat(40) });
  client.setRefMessage(ref, attemptsMessage({ count: 1, lastAttemptAt: new Date().toISOString() }));
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('"reason":"backoff"')));
  } finally {
    console.log = orig;
  }
});

test('act fails on holder mismatch after claim', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const lane = 'refs/mythos/dispatch/lane-00';
  const claimName = claimRef(1, 0);
  const origGet = client.getRef.bind(client);
  client.getRef = async (args) => {
    const got = await origGet(args);
    if (client.exists(lane) && client.exists(claimName) && got.ok) {
      if (args.ref === lane || args.ref === claimName) {
        return { ...got, sha: 'f'.repeat(40) };
      }
    }
    return got;
  };
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client));
    assert.equal(code, 1);
    assert.ok(logs.some((l) => l.includes('dispatch_fail') && l.includes('lease_mismatch')));
  } finally {
    console.error = origErr;
  }
});

test('fake gh e2e dry-run act claim and encoded ref paths', { timeout: 15000 }, async () => {
  const store = new Map();
  const commitMessages = new Map();
  let repoNode = 'R_kg';
  const gh = (args, token, input) => {
    const flat = args.map((a) => String(a));
    if (flat.includes('graphql') && input) {
      const body = JSON.parse(input);
      if (body.query.includes('userContentEdits') || body.query.includes('node(id:')) {
        const id = (body.variables && body.variables.id) || 'IC_kwDOPlan99';
        return {
          status: 0,
          stdout: JSON.stringify({
            data: {
              node: {
                id,
                userContentEdits: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          }),
        };
      }
      if (body.query.includes('updateRefs')) {
        for (const row of body.variables.refUpdates) {
          const cur = store.get(row.name);
          const zero = '0000000000000000000000000000000000000000';
          if (row.beforeOid === zero && cur) {
            return {
              status: 1,
              stdout: JSON.stringify({ errors: [{ message: 'Reference already exists' }] }),
              stderr: 'gh: GraphQL error',
            };
          }
          if (row.afterOid === zero) store.delete(row.name);
          else store.set(row.name, row.afterOid);
        }
        return { status: 0, stdout: JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }) };
      }
      return { status: 0, stdout: '{}' };
    }
    if (flat.some((a) => a.includes('matching-refs'))) {
      const rows = [];
      for (const [ref, sha] of store) {
        if (ref.includes('mythos/dispatch')) rows.push({ ref, object: { sha } });
      }
      return { status: 0, stdout: JSON.stringify(rows) };
    }
    if (flat.some((a) => a.includes('/git/ref/'))) {
      const encoded = flat.find((a) => a.includes('/git/ref/'));
      const suffix = decodeURIComponent(encoded.split('/git/ref/')[1]);
      const ref = `refs/${suffix}`;
      const sha = store.get(ref);
      if (!sha) return { status: 404, stderr: 'Not Found' };
      return { status: 0, stdout: JSON.stringify({ object: { sha } }) };
    }
    if (flat.some((a) => a.includes('/git/commits/'))) {
      const sha = flat.find((a) => a.includes('/git/commits/')).split('/').pop();
      const msg = commitMessages.get(sha) || '{"schema":"mythos-dispatch-attempts/v1","count":1,"lastAttemptAt":"2026-01-01T00:00:00Z"}';
      return { status: 0, stdout: msg };
    }
    if (flat.some((a) => a.includes('/issues/') && a.includes('/comments'))) {
      return {
        status: 0,
        stdout: '{"id":99,"node_id":"IC_kwDOPlan99","body":"## Files\\n- a.ts","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","user":{"login":"SkyyPlayz","type":"User"}}\n',
      };
    }
    if (flat.some((a) => a.includes('/issues/') && a.includes('--jq') && !a.includes('/comments'))) {
      return { status: 0, stdout: '{"state":"open","pull_request":null}' };
    }
    if (flat.some((a) => a.includes('/git/commits/')) && flat.includes('--jq') && flat.includes('.tree.sha')) {
      return { status: 0, stdout: 'b'.repeat(40) + '\n' };
    }
    if (flat.some((a) => a.includes('/git/commits/')) && flat.includes('--jq') && flat.includes('.message')) {
      const sha = flat.find((a) => a.includes('/git/commits/')).split('/').pop();
      const msg = commitMessages.get(sha) || '{"schema":"mythos-dispatch-attempts/v1","count":1,"lastAttemptAt":"2026-01-01T00:00:00Z"}';
      return { status: 0, stdout: msg };
    }
    if (flat.includes('--jq') && flat.includes('.node_id')) return { status: 0, stdout: `${repoNode}\n` };
    if (flat.includes('-X') && flat.some((a) => a.includes('/git/commits'))) {
      const sha = `e${String(store.size + 1).padStart(39, '0')}`.slice(0, 40);
      const msgField = flat.find((a) => String(a).startsWith('message='));
      if (msgField) commitMessages.set(sha, String(msgField).slice('message='.length));
      return { status: 0, stdout: JSON.stringify({ sha }) };
    }
    return { status: 0, stdout: '[]' };
  };
  const { combined: client } = createDispatchClients({
    readToken: 'r',
    writeToken: 'w',
    gh,
    reReadSwitch: async () => ({ ok: true, enabled: true }),
  });
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const dry = await runDispatchPlan({
    MODE: 'dry-run',
    client,
    readDispatchSwitchesFn: async () => ({ ok: true, enabled: false }),
    readRepoVariableFn: async (_r, _t, n) => ({
      ok: true,
      value: n === 'MYTHOS_BUILD_ORDER_ISSUES' ? '1' : n === 'MYTHOS_DISPATCH_LANE_CAP' ? '5' : null,
    }),
    activeClaimsFromRefs: (refs) => activeClaimsFromRefs(refs),
  });
  assert.equal(dry, 0);
  const act = await runDispatchPlan(actEnv(client));
  assert.equal(act, 0);
  const scratch = CANARY_SCRATCH_REF;
  const win = await client.createRef({ ref: scratch, sha: MAIN });
  assert.equal(win.ok, true);
  const lose = await client.createRef({ ref: scratch, sha: MAIN });
  assert.equal(lose.refExists, true);
  const gotLane = await client.getRef({ ref: 'refs/mythos/dispatch/lane-00' });
  assert.equal(gotLane.ok, true);
  assert.equal(gotLane.sha.length, 40);
});

test('verifyPlanCommentEditors requires edit evidence when timestamps match', async () => {
  const client = createMockRefClient();
  let fetched = 0;
  client.issueCommentContentEdits = async (args) => {
    fetched += 1;
    assert.equal(args.commentNodeId, 'IC_kwDOSameSecond');
    return {
      ok: true,
      complete: true,
      editors: [{ login: 'evil', __typename: 'User' }],
    };
  };
  const official = findOfficialPlan([{
    id: '1',
    databaseId: 1,
    nodeId: 'IC_kwDOSameSecond',
    author: { login: 'SkyyPlayz' },
    body: '## Files\n- a.ts',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }]);
  assert.ok(official && !official.hold);
  const hold = await verifyPlanCommentEditors(client, 1, official);
  assert.equal(fetched, 1);
  assert.equal(hold.hold, true);
  assert.equal(hold.reason, 'untrusted_editor');
});

test('verifyPlanCommentEditors requires edit evidence when timestamps are missing', async () => {
  const client = createMockRefClient();
  let fetched = 0;
  client.issueCommentContentEdits = async () => {
    fetched += 1;
    return {
      ok: true,
      complete: true,
      editors: [{ login: 'evil', __typename: 'User' }],
    };
  };
  const official = findOfficialPlan([{
    id: '1',
    databaseId: 1,
    nodeId: 'IC_kwDOMissingTs',
    author: { login: 'SkyyPlayz' },
    body: '## Files\n- a.ts',
  }]);
  const hold = await verifyPlanCommentEditors(client, 1, official);
  assert.equal(fetched, 1);
  assert.equal(hold.hold, true);
  assert.equal(hold.reason, 'untrusted_editor');
});

test('verifyPlanCommentEditors accepts a same-second comment with complete trusted edit history', async () => {
  const client = createMockRefClient();
  client.issueCommentContentEdits = async () => ({
    ok: true,
    complete: true,
    editors: [{ login: 'SkyyPlayz', __typename: 'User' }],
  });
  const official = findOfficialPlan([{
    id: '1',
    databaseId: 1,
    nodeId: 'IC_kwDOTrustedSameSecond',
    author: { login: 'SkyyPlayz' },
    body: '## Files\n- a.ts',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }]);
  const hold = await verifyPlanCommentEditors(client, 1, official);
  assert.equal(hold.hold, false);
});

test('invalid build-order entry holds before scanning the queue', async () => {
  const client = createMockRefClient();
  let listed = 0;
  let fetchedIssue = 0;
  client.listRefs = async () => {
    listed += 1;
    return { ok: true, refs: [] };
  };
  client.getIssue = async () => {
    fetchedIssue += 1;
    return { ok: true, issue: { state: 'open' } };
  };
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client, {
      readRepoVariableFn: async (_r, _t, n) => {
        if (n === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '12oops,13' };
        if (n === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
        return { ok: true, value: null };
      },
    }));
    assert.equal(code, 1);
    const hold = logs.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).find((row) => row && row.kind === 'dispatch_hold');
    assert.ok(hold);
    assert.equal(hold.reason, 'invalid_build_order');
    assert.equal(hold.entry, '12oops');
  } finally {
    console.log = orig;
  }
  assert.equal(listed, 0);
  assert.equal(fetchedIssue, 0);
  assertNoLaneOrClaimWrites(client);
});

test('invalid build-order hex entry holds before scanning the queue', async () => {
  const client = createMockRefClient();
  let listed = 0;
  let fetchedIssue = 0;
  client.listRefs = async () => {
    listed += 1;
    return { ok: true, refs: [] };
  };
  client.getIssue = async () => {
    fetchedIssue += 1;
    return { ok: true, issue: { state: 'open' } };
  };
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await runDispatchPlan(actEnv(client, {
      readRepoVariableFn: async (_r, _t, n) => {
        if (n === 'MYTHOS_BUILD_ORDER_ISSUES') return { ok: true, value: '0x12,13' };
        if (n === 'MYTHOS_DISPATCH_LANE_CAP') return { ok: true, value: '5' };
        return { ok: true, value: null };
      },
    }));
    assert.equal(code, 1);
    const hold = logs.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).find((row) => row && row.kind === 'dispatch_hold');
    assert.ok(hold);
    assert.equal(hold.reason, 'invalid_build_order');
    assert.equal(hold.entry, '0x12');
  } finally {
    console.log = orig;
  }
  assert.equal(listed, 0);
  assert.equal(fetchedIssue, 0);
  assertNoLaneOrClaimWrites(client);
});

test('verifyPlanCommentEditors holds when edit history is not marked complete', async () => {
  const official = findOfficialPlan([{
    id: '1',
    databaseId: 1,
    nodeId: 'IC_kwDOIncomplete',
    author: { login: 'SkyyPlayz' },
    body: '## Files\n- a.ts',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }]);
  const client = {
    issueCommentContentEdits: async () => ({
      ok: true,
      complete: false,
      editors: [{ login: 'SkyyPlayz' }],
    }),
  };
  const hold = await verifyPlanCommentEditors(client, 1, official);
  assert.equal(hold.hold, true);
  assert.equal(hold.reason, 'editor_history_incomplete');
});

// ---------------------------------------------------------------------------
// No raw error text on the claim / release / attempts / sweep paths (Shield F2,
// Critic H3, Probe HARD-2). Every logged and returned reason must be a fixed code.
// ---------------------------------------------------------------------------
const RAW_LEAK = 'ghp_SECRETTOKEN GraphQL: Resource not accessible stderr=boom HTTP 500';
const RAW_LEAK_RE = /SECRETTOKEN|GraphQL|Resource not accessible|stderr|boom|HTTP 500/;

async function captureAllOutput(fn, { stdout = false } = {}) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWrite = process.stdout.write;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  if (stdout) {
    process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  }
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
  }
}

function jsonRows(lines) {
  const rows = [];
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch { /* not a JSON log line */ }
  }
  return rows;
}

function jsonRow(lines, kind) {
  return jsonRows(lines).find((row) => row && row.kind === kind);
}

function planClient() {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  return client;
}

test('claim fatal write with a raw error: rollback log, claim reason and dispatch_fail carry fixed codes only', async () => {
  const client = planClient();
  client.createRefPair = async ({ laneRef, afterOid }) => {
    await client.createRef({ ref: laneRef, sha: afterOid });
    return { ok: false, fatal: true, error: RAW_LEAK, stderr: RAW_LEAK, errors: [{ message: RAW_LEAK }] };
  };
  const { result, lines } = await captureAllOutput(() => runDispatchPlan(actEnv(client)));
  assert.equal(result, 1);
  assert.doesNotMatch(lines.join('\n'), RAW_LEAK_RE);
  const rollback = jsonRow(lines, 'dispatch_ref_pair_rollback');
  assert.ok(rollback, 'rollback log row expected');
  assert.equal(rollback.reason, 'update_refs_failed');
  assert.equal(rollback.error, undefined);
  const fail = jsonRow(lines, 'dispatch_fail');
  assert.ok(fail, 'dispatch_fail row expected');
  assert.equal(fail.reason, 'update_refs_failed');
});

test('claim fatal write and delete both failing with a raw token string leaks nothing', async () => {
  const client = planClient();
  client.createRefPair = async ({ laneRef, afterOid }) => {
    await client.createRef({ ref: laneRef, sha: afterOid });
    return { ok: false, fatal: true, error: RAW_LEAK, stderr: RAW_LEAK };
  };
  client.deleteRef = async () => ({ ok: false, error: RAW_LEAK, stderr: RAW_LEAK, errors: [{ message: RAW_LEAK }] });
  const { result, lines } = await captureAllOutput(() => runDispatchPlan(actEnv(client)));
  assert.equal(result, 1);
  assert.doesNotMatch(lines.join('\n'), RAW_LEAK_RE);
  assert.equal(jsonRow(lines, 'dispatch_fail').reason, 'update_refs_failed');
  assert.equal(jsonRow(lines, 'dispatch_ref_pair_rollback'), undefined);
});

test('claim ambiguous non-fatal write with a raw error becomes dispatch_skip create_failed', async () => {
  const client = planClient();
  client.createRefPair = async () => ({ ok: false, error: RAW_LEAK, stderr: RAW_LEAK });
  const { result, lines } = await captureAllOutput(() => runDispatchPlan(actEnv(client)));
  assert.equal(result, 0);
  assert.doesNotMatch(lines.join('\n'), RAW_LEAK_RE);
  assert.equal(jsonRow(lines, 'dispatch_skip').reason, 'create_failed');
});

test('releaseRefCas maps raw delete errors to fixed codes', async () => {
  const claim = require('./claim');
  const client = createMockRefClient();
  const lane = 'refs/mythos/dispatch/lane-00';
  const cases = [
    [{ ok: false, error: RAW_LEAK }, 'delete_failed'],
    [{ ok: false, error: `HTTP 404 not found ${RAW_LEAK}` }, 'not_found'],
    [{ ok: false, error: `GraphQL conflict ${RAW_LEAK}` }, 'ref_changed'],
    [{ ok: false, error: 'ref_changed' }, 'ref_changed'],
    [{ ok: false }, 'delete_failed'],
    [{ ok: false, error: { nested: RAW_LEAK } }, 'delete_failed'],
  ];
  for (const [deleteResult, want] of cases) {
    client.deleteRef = async () => deleteResult;
    const rel = await claim.releaseRefCas(client, lane, MAIN);
    assert.equal(rel.ok, false);
    assert.equal(rel.reason, want, JSON.stringify(deleteResult));
    assert.doesNotMatch(JSON.stringify(rel), RAW_LEAK_RE);
  }
});

test('attempt record failure and release failure logs carry fixed codes only', async () => {
  const client = planClient();
  const origCreate = client.createRef.bind(client);
  client.createRef = async (args) => (String(args.ref).includes('/attempts/')
    ? { ok: false, fatal: true, error: RAW_LEAK, stderr: RAW_LEAK }
    : origCreate(args));
  client.deleteRef = async () => ({ ok: false, error: RAW_LEAK, stderr: RAW_LEAK });
  const { result, lines } = await captureAllOutput(() => runDispatchPlan(actEnv(client)));
  assert.equal(result, 1);
  const text = lines.join('\n');
  assert.doesNotMatch(text, RAW_LEAK_RE);
  assert.match(text, /dispatch: attempt record failed: attempts_write_failed$/m);
  const released = jsonRow(lines, 'dispatch_release_failed');
  assert.ok(released, 'dispatch_release_failed row expected');
  assert.ok(released.results.length > 0);
  for (const row of released.results) {
    assert.equal(row.ok, false);
    assert.equal(row.reason, 'delete_failed');
  }
});

test('recordDispatchAttempt maps a raw create and a raw renew failure to attempts_write_failed', async () => {
  const mint = async () => 'c'.repeat(40);
  const created = createMockRefClient();
  created.createRef = async () => ({ ok: false, error: RAW_LEAK });
  const first = await recordDispatchAttempt(created, 8, 0, { mintLeaseSha: mint });
  assert.deepEqual(first, { ok: false, reason: 'attempts_write_failed' });

  const renewed = createMockRefClient();
  await renewed.createRef({ ref: attemptsRef(8, 0), sha: 'd'.repeat(40) });
  renewed.setRefMessage(attemptsRef(8, 0), attemptsMessage({ count: 1, lastAttemptAt: '2020-01-01T00:00:00Z' }));
  renewed.renewRef = async () => ({ ok: false, error: RAW_LEAK });
  const second = await recordDispatchAttempt(renewed, 8, 0, { mintLeaseSha: mint });
  assert.deepEqual(second, { ok: false, reason: 'attempts_write_failed' });
});

test('sweep with raw delete errors returns ref names only', async () => {
  const lane = 'refs/mythos/dispatch/lane-00';
  const swept = await sweepDispatchRefs({
    listRefs: async () => ({ ok: true, refs: [{ ref: lane, sha: MAIN, message: 'junk' }] }),
    deleteRef: async () => ({ ok: false, error: RAW_LEAK, stderr: RAW_LEAK }),
  });
  assert.equal(swept.ok, false);
  assert.deepEqual(swept.errors, [lane]);
  assert.doesNotMatch(JSON.stringify(swept), RAW_LEAK_RE);
});

test('stableDispatchMutationReason never returns raw text and keeps each fixed code', () => {
  const R = require('./refs-graphql');
  const unknowns = [
    RAW_LEAK,
    'ghp_SECRETTOKEN',
    'HTTP 500 ghp_x boom',
    'x'.repeat(3000),
    'denied',
    'transport_timeout',
    '',
    null,
    undefined,
    5,
    {},
    ['ref_changed'],
  ];
  for (const raw of unknowns) {
    assert.equal(R.stableDispatchMutationReason(raw, 'update_refs_failed'), 'update_refs_failed', String(raw));
    assert.equal(R.stableDispatchMutationReason(raw, 'create_failed'), 'create_failed', String(raw));
    assert.equal(R.stableDispatchMutationReason(raw, 'delete_failed'), 'delete_failed', String(raw));
    assert.equal(R.stableDispatchMutationReason(raw, 'attempts_write_failed'), 'attempts_write_failed', String(raw));
    assert.equal(R.stableDispatchMutationReason(raw), 'write_failed', String(raw));
    assert.equal(R.stableDispatchMutationReason(raw, 'ghp_SECRET_fallback'), 'write_failed', String(raw));
    assert.equal(R.stableDispatchMutationReason(raw, undefined), 'write_failed', String(raw));
  }
  const fixedCodes = [
    'ref_changed', 'not_found', 'write_failed', 'ref_exists', 'lane_full', 'files_overlap',
    'slice_already_claimed', 'switch_off', 'switch_read', 'list_failed', 'invalid_lane_cap',
    'no_write_token', 'repo_node_id', 'missing_before_oid', 'missing_oid', 'graphql_no_update_refs',
    'create_failed', 'update_refs_failed', 'delete_failed', 'lease_mismatch', 'parent_tree',
    'commit_parse', 'invalid_parent_sha', 'attempts_write_failed',
  ];
  for (const code of fixedCodes) {
    assert.equal(R.stableDispatchMutationReason(code, 'write_failed'), code);
    assert.equal(R.stableDispatchMutationReason(code, 'update_refs_failed'), code);
  }
  assert.equal(R.stableDispatchMutationReason('HTTP 409 conflict'), 'ref_changed');
  assert.equal(R.stableDispatchMutationReason('GraphQL: Reference does not exist'), 'not_found');
  assert.equal(R.stableDispatchMutationReason('HTTP 404 ghp_x', 'create_failed'), 'not_found');
});

test('stableDispatchDeleteReason maps to ref_changed, not_found or write_failed and never returns raw text', () => {
  const R = require('./refs-graphql');
  const keywordFree = 'HTTP 500 ghp_x boom';
  const cases = [
    [{ ok: false, error: keywordFree, status: 500 }, 'write_failed'],
    [{ ok: false, error: keywordFree }, 'write_failed'],
    [{ ok: false, error: keywordFree, stderr: keywordFree, errors: [{ message: keywordFree }] }, 'write_failed'],
    [{ ok: false, error: RAW_LEAK, reason: RAW_LEAK }, 'write_failed'],
    [{ ok: false, error: keywordFree, status: 404 }, 'not_found'],
    [{ ok: false, error: keywordFree, ghStatus: 404 }, 'not_found'],
    [{ ok: false, error: 'HTTP 404 ghp_x' }, 'not_found'],
    [{ ok: false, error: 'GraphQL: Reference does not exist ghp_x' }, 'not_found'],
    [{ ok: false, error: keywordFree, status: 409 }, 'ref_changed'],
    [{ ok: false, error: 'conflict ghp_x' }, 'ref_changed'],
    [{ ok: false, error: 'expected OID mismatch ghp_x' }, 'ref_changed'],
    [{ ok: false, error: 'ref_changed' }, 'ref_changed'],
    [{ ok: false, error: 'not_found' }, 'not_found'],
    [{ ok: false, error: 'write_failed' }, 'write_failed'],
    [{ ok: false, reason: 'not_found', error: keywordFree }, 'not_found'],
    [{ ok: false, reason: 'ref_changed' }, 'ref_changed'],
    [{ ok: false, error: { nested: keywordFree } }, 'write_failed'],
    [{ ok: false }, 'write_failed'],
    [null, 'write_failed'],
    [undefined, 'write_failed'],
  ];
  for (const [input, want] of cases) {
    const got = R.stableDispatchDeleteReason(input);
    assert.equal(got, want, JSON.stringify(input));
    assert.equal(R.STABLE_DELETE_REASONS.has(got), true);
  }
});

test('assertDispatchRef pins every allowed shape against look-alikes for lane, claim, attempts, done and canary', () => {
  const R = require('./refs-graphql');
  const C = require('./constants');
  for (let i = 0; i < 100; i += 1) assert.equal(R.assertDispatchRef(C.slotRef(i)), C.slotRef(i));
  for (const build of [C.claimRef, C.attemptsRef, C.doneRef]) {
    assert.equal(R.assertDispatchRef(build(12345, 7)), build(12345, 7));
  }
  const canary = C.canaryScratchRef(123456789012, 3);
  assert.equal(R.assertDispatchRef(canary), canary);
  const root = 'refs/mythos/dispatch';
  const lookalikes = [
    `evil/${root}/lane-00`,
    `x${root}/lane-00`,
    `refs/heads/main\n${root}/lane-00`,
    `${root}/lane-00/../heads/x`,
    `${root}/lane-00/`,
    `${root}/lane-00/extra`,
    `${root}/lane-000`,
    `${root}/lane-1`,
    `${root}/lane-0a`,
    `${root}/LANE-00`,
    `${root}/lane-00\n`,
    `\n${root}/lane-00`,
    `${root}/claim/../x`,
    `${root}/claim/x`,
    `${root}/claim/12`,
    `${root}/claim/12-`,
    `${root}/claim/-1`,
    `${root}/claim/12-0/extra`,
    `${root}/claim/12-0/`,
    `${root}/claim/12-0\n`,
    `evil/${root}/claim/12-0`,
    `${root}/claim%2F12-0`,
    `${root}/attempts/../x`,
    `${root}/attempts/x`,
    `${root}/attempts/12-0/extra`,
    `evil/${root}/attempts/12-0`,
    `${root}/done/../x`,
    `${root}/done/x`,
    `${root}/done/12-0/extra`,
    `evil/${root}/done/12-0`,
    `${root}/canary/..`,
    `${root}/canary/scratch-1`,
    `${root}/canary/scratch-a-1`,
    `${root}/canary/scratch-1-1/x`,
    `${root}/canary/other-1-1`,
    `evil/${root}/canary/scratch-1-1`,
    `${root}//lane-00`,
    `${root}/./lane-00`,
    `${root}/lane-\u0660\u0660`,
    `${root}X/lane-00`,
    root,
    `${root}/`,
    'refs/heads/main',
    '',
    null,
    undefined,
    12,
    {},
  ];
  for (const ref of lookalikes) {
    assert.throws(() => R.assertDispatchRef(ref), /outside dispatch namespace/, JSON.stringify(ref));
    assert.throws(() => R.refUpdateCreate(ref, MAIN), undefined, JSON.stringify(ref));
    assert.throws(() => R.refUpdateDelete(ref, MAIN), undefined, JSON.stringify(ref));
    assert.throws(() => R.refUpdateRenew(ref, MAIN, MAIN), undefined, JSON.stringify(ref));
  }
  try {
    R.assertDispatchRef(`${root}/../SECRETREF`);
    assert.fail('expected throw');
  } catch (err) {
    assert.doesNotMatch(String(err.message), /SECRETREF/);
  }
});

test('unset build-order variable is idle while an empty value holds as invalid_build_order', async () => {
  const { readRepoVariable } = require('./switch');
  async function runWithGh(ghResult) {
    const client = createMockRefClient();
    let touched = 0;
    for (const name of ['listRefs', 'getIssue', 'issueComments']) {
      const original = client[name].bind(client);
      client[name] = async (...args) => { touched += 1; return original(...args); };
    }
    const outcome = await captureAllOutput(() => runDispatchPlan(actEnv(client, {
      CONTROL_TOKEN: 'ctl',
      readRepoVariableFn: (repo, token, name) => (name === 'MYTHOS_BUILD_ORDER_ISSUES'
        ? readRepoVariable(repo, token, name, () => ghResult)
        : { ok: true, value: name === 'MYTHOS_DISPATCH_LANE_CAP' ? '5' : null }),
    })));
    return { ...outcome, touched };
  }

  const unset = await runWithGh({ status: 1, stderr: 'gh: Not Found (HTTP 404)', stdout: '' });
  assert.equal(unset.result, 0);
  assert.equal(jsonRow(unset.lines, 'dispatch_idle').reason, 'no_eligible_issue');
  assert.equal(jsonRow(unset.lines, 'dispatch_hold'), undefined);

  const empty = await runWithGh({ status: 0, stdout: '\n' });
  assert.equal(empty.result, 1);
  assert.equal(empty.touched, 0);
  const hold = jsonRow(empty.lines, 'dispatch_hold');
  assert.equal(hold.reason, 'invalid_build_order');
  assert.equal(hold.entry, '');
  assert.equal(jsonRow(empty.lines, 'dispatch_idle'), undefined);

  const spaced = await runWithGh({ status: 0, stdout: '11, 12\n' });
  assert.equal(spaced.result, 1);
  assert.equal(spaced.touched, 0);
  assert.equal(jsonRow(spaced.lines, 'dispatch_hold').entry, ' 12');

  const stubUnset = await captureAllOutput(() => runDispatchPlan(actEnv(createMockRefClient(), {
    readRepoVariableFn: async (_r, _t, name) => (name === 'MYTHOS_BUILD_ORDER_ISSUES'
      ? { ok: true, value: null, unset: true }
      : { ok: true, value: name === 'MYTHOS_DISPATCH_LANE_CAP' ? '5' : null }),
  })));
  assert.equal(stubUnset.result, 0);
  assert.ok(jsonRow(stubUnset.lines, 'dispatch_idle'));

  const stubEmpty = await captureAllOutput(() => runDispatchPlan(actEnv(createMockRefClient(), {
    readRepoVariableFn: async (_r, _t, name) => (name === 'MYTHOS_BUILD_ORDER_ISSUES'
      ? { ok: true, value: '', unset: false }
      : { ok: true, value: name === 'MYTHOS_DISPATCH_LANE_CAP' ? '5' : null }),
  })));
  assert.equal(stubEmpty.result, 1);
  assert.equal(jsonRow(stubEmpty.lines, 'dispatch_hold').reason, 'invalid_build_order');
});

test('plan comment ID above 2^53 stays an exact string through dry-run, claim log and lease message', async () => {
  const HUGE = '9007199254740993';
  assert.notEqual(String(Number(HUGE)), HUGE);
  const hugeClient = () => {
    const client = createMockRefClient();
    client.issueComments = async () => {
      const plan = planComments();
      plan.comments[0].id = HUGE;
      plan.comments[0].databaseId = HUGE;
      return plan;
    };
    client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
    return client;
  };

  const dry = await captureAllOutput(() => runDispatchPlan(actEnv(hugeClient(), {
    MODE: 'dry-run',
    readDispatchSwitchesFn: async () => ({ ok: true, enabled: false }),
  })), { stdout: true });
  assert.equal(dry.result, 0);
  const would = jsonRow(dry.lines, 'would_claim');
  assert.ok(would, 'would_claim row expected');
  assert.equal(would.planCommentId, HUGE);

  const client = hugeClient();
  const act = await captureAllOutput(() => runDispatchPlan(actEnv(client)));
  assert.equal(act.result, 0);
  const claimed = jsonRow(act.lines, 'dispatch_claimed');
  assert.ok(claimed, 'dispatch_claimed row expected');
  assert.equal(claimed.planCommentId, HUGE);
  const lane = await client.getRef({ ref: 'refs/mythos/dispatch/lane-00' });
  assert.equal(lane.ok, true);
  const lease = JSON.parse(lane.message);
  assert.equal(lease.planCommentId, HUGE);
  assert.equal(typeof lease.planCommentId, 'string');
});
