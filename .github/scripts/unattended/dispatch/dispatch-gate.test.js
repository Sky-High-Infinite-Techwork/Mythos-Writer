'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDispatchClients } = require('./dispatch-client');
const { createMockRefClient } = require('./mock-client');
const { runDispatchPlan } = require('./dispatch-run');
const { sweepDispatchRefs } = require('./claim');
const { recordDispatchAttempt } = require('./slice-progress');
const { attemptsRef } = require('./constants');
const { attemptsMessage } = require('./slice-progress');
const { readDispatchSwitches } = require('./switch');
const { runCanaryVerify } = require('./canary-verify');
const { tryCreateRefPair } = require('./claim');
const { verifyPlanCommentEditors, findOfficialPlan, canonicalAuthorLogin } = require('./official-plan');
const { ATTEMPTS_SCHEMA } = require('./slice-progress');
const { activeClaimsFromRefs } = require('./dispatch-helpers');

const MAIN = 'a'.repeat(40);
const gradePassOk = () => ({ ok: true, marker: {} });

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

test('claim sweep act again increments attempts 1 2 3 without exit 1', async () => {
  const client = createMockRefClient();
  client.issueComments = async () => planComments();
  client.getIssue = async () => ({ ok: true, issue: { state: 'open' } });
  const mint = async (message) => {
    const c = await client.createLeaseCommit(message, MAIN);
    return c.ok ? c.sha : null;
  };
  let code = await runDispatchPlan(actEnv(client));
  assert.equal(code, 0);
  const got1 = await client.getRef({ ref: attemptsRef(1, 0) });
  assert.match(got1.message, /"count":1/);
  await sweepDispatchRefs(client, { reReadSwitch: async () => ({ ok: true, enabled: true }) });
  code = await runDispatchPlan(actEnv(client));
  assert.equal(code, 0);
  const c2 = await recordDispatchAttempt(client, 1, 0, { mintLeaseSha: mint });
  assert.equal(c2.count, 2);
  const c3 = await recordDispatchAttempt(client, 1, 0, { mintLeaseSha: mint });
  assert.equal(c3.count, 3);
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
    const code = await runDispatchPlan(actEnv(client));
    assert.equal(code, 1);
    assert.ok(errs.some((l) => l.includes('dispatch_release_failed') || l.includes('attempt record failed')));
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

test('readDispatchSwitches requires both UNATTENDED and DISPATCH true', () => {
  const ghFn = (args) => {
    if (String(args[2]).includes('UNATTENDED_ENABLED')) {
      return { status: 0, stdout: 'true\n' };
    }
    if (String(args[2]).includes('MYTHOS_DISPATCH_ENABLED')) {
      return { status: 0, stdout: 'false\n' };
    }
    return { status: 0, stdout: '' };
  };
  const s = readDispatchSwitches('Sky-High-Infinite-Techwork/Mythos-Writer', 'tok', ghFn);
  assert.equal(s.ok, true);
  assert.equal(s.enabled, false);
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

test('canary verify returns 1 when switch off after scratch match', async () => {
  const client = createMockRefClient();
  await client.createRef({ ref: require('./constants').CANARY_SCRATCH_SHARED_REF, sha: MAIN });
  const dir = require('node:fs').mkdtempSync(`${require('node:os').tmpdir()}/canary-`);
  for (let i = 0; i < 6; i += 1) {
    require('node:fs').writeFileSync(
      `${dir}/canary-outcome-${i}.json`,
      JSON.stringify({ kind: i === 0 ? 'canary_win' : 'canary_lose', index: i }),
    );
  }
  let calls = 0;
  const code = await runCanaryVerify(client, {
    reReadSwitch: async () => {
      calls += 1;
      return { ok: true, enabled: calls < 2 };
    },
    mainSha: MAIN,
    artifactsDir: dir,
  });
  assert.equal(code, 1);
  require('node:fs').rmSync(dir, { recursive: true, force: true });
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
            return { status: 0, stdout: JSON.stringify({ errors: [{ message: 'Reference already exists' }] }) };
          }
          if (row.afterOid === zero) store.delete(row.name);
          else store.set(row.name, row.afterOid);
        }
        return { status: 0, stdout: '{}' };
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
  const { combined: client } = createDispatchClients({ readToken: 'r', writeToken: 'w', gh });
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
  const scratch = require('./constants').CANARY_SCRATCH_SHARED_REF;
  const win = await client.createRef({ ref: scratch, sha: MAIN });
  assert.equal(win.ok, true);
  const lose = await client.createRef({ ref: scratch, sha: MAIN });
  assert.equal(lose.refExists, true);
  const gotLane = await client.getRef({ ref: 'refs/mythos/dispatch/lane-00' });
  assert.equal(gotLane.ok, true);
  assert.equal(gotLane.sha.length, 40);
});