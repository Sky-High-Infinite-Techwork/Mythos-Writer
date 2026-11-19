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
  const main = 'refs/heads/main';
  const oid = 'a'.repeat(40);
  assert.throws(() => refUpdateCreate(main, oid));
  assert.throws(() => refUpdateDelete(main, oid));
  assert.throws(() => refUpdateRenew(main, oid, oid));
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
      if (body.query.includes('userContentEdits')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            data: { repository: { issue: { comments: { nodes: [{ databaseId: 99, userContentEdits: { nodes: [] } }] } } } },
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
        stdout: '{"id":99,"body":"## Files\\n- a.ts","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","user":{"login":"SkyyPlayz","type":"User"}}\n',
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