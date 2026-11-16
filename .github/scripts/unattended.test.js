'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const { classify, authorAssertion, evidenceOk, filesLookProtected } = require('./unattended/flow-policy');
const { plan, undraft, enqueue } = require('./unattended/flow-run');
const {
  ENQUEUE_QUERY, flattenPages, flattenRunPages, mapChangedFile, createClient,
  parseAllowlist, authorMatches, leaseHeldFrom, rulesetMatches,
} = require('./unattended/flow-client');
const { transportResult, reduce, acceptReducer } = require('./unattended/gate-result');
const { decideQueueEntry, stillQueue, parseQueueRef } = require('./unattended/queue-policy');
const { treesMatch, parentsOf, fetchObjects, runPublish } = require('./unattended/publish-run');
const { interpretGrant } = require('./unattended/token-grant');
const { interpretSwitch, readSwitch } = require('./unattended/switch');
const { gh } = require('./unattended/spawn');
const { CI_INTEGRATION_ID, CHECK_NAME, GATE_APP_ID, REPO, WRITE_APP_ID, WRITE_INSTALLATION_ID } = require('./unattended/constants');

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const BLOB_CI = '1'.repeat(40);
const BLOB_SHOT = '2'.repeat(40);
const WORKFLOWS = path.join(__dirname, '..', 'workflows');

function triggerOf(doc) {
  if (doc && Object.prototype.hasOwnProperty.call(doc, 'on')) return doc.on;
  if (doc && Object.prototype.hasOwnProperty.call(doc, true)) return doc[true];
  return undefined;
}

function loadWorkflow(name) {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS, name), 'utf8'));
}

function admitBlock(name) {
  const text = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
  const start = text.indexOf('# ADMIT-BEGIN\n');
  const end = text.indexOf('          # ADMIT-END');
  assert.ok(start > 0 && end > start, name);
  return text.slice(start + '# ADMIT-BEGIN\n'.length, end);
}

function runAdmit(block, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admit-'));
  const output = path.join(dir, 'github-output');
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${block}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: output, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    outputs: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '',
  };
}

function proofComments(head, login) {
  return [{ login, body: `note\nPROOF @ ${head}\n` }];
}

function readyFacts(over = {}) {
  return {
    number: 7,
    nodeId: 'PR_node',
    head: HEAD,
    base: 'main',
    draft: false,
    fork: false,
    author: 'ada',
    labels: [],
    mergeState: 'CLEAN',
    filesComplete: true,
    protectedPath: false,
    proof: true,
    ciGreen: true,
    gate: true,
    queueEnabled: true,
    inQueue: false,
    allowlistKnown: true,
    authorAllowed: true,
    scopeKnown: true,
    teamScopeKnown: true,
    leaseKnown: true,
    leaseHeld: false,
    rulesetKnown: true,
    rulesetMatch: true,
    ...over,
  };
}

function prRecord(over = {}) {
  return {
    number: 7,
    isDraft: false,
    isCrossRepository: false,
    baseRefName: 'main',
    headRefOid: HEAD,
    mergeStateStatus: 'CLEAN',
    author: { login: 'ada' },
    labels: [],
    id: 'PR_node',
    changedFiles: 1,
    ...over,
  };
}

function evidenceFor(head, prNumber) {
  const files = [
    ['.github/workflows/ci.yml', BLOB_CI],
    ['.github/workflows/screenshot-check.yml', BLOB_SHOT],
  ];
  return {
    mainRevision: Object.fromEntries(files),
    runs: files.map(([workflowPath, blob], index) => ({
      path: workflowPath,
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success',
      headSha: head,
      pr: prNumber,
      prHeadSha: head,
      prBaseRef: 'main',
      prBaseSha: BASE,
      repository: REPO,
      headRepository: REPO,
      runId: 100 + index,
      runAttempt: 1,
      workflowBlob: blob,
    })),
  };
}

function detailFor(pr, over = {}) {
  const head = pr.headRefOid;
  return {
    comments: proofComments(head, 'ada'),
    files: [{ filename: 'frontend/src/app.ts' }],
    checks: {
      ci: { conclusion: 'success', headSha: head },
      'notes-windows': { conclusion: 'success', headSha: head },
      'screenshot-check': { conclusion: 'success', headSha: head },
      gate: { conclusion: 'success', headSha: head, appId: GATE_APP_ID, summary: `Head: ${head}\n` },
    },
    evidence: evidenceFor(head, pr.number),
    ruleset: { known: true, match: true },
    queue: {
      nodeId: 'PR_node',
      queueEnabled: true,
      inQueue: false,
      head,
      base: pr.baseRefName,
      state: 'OPEN',
      draft: pr.isDraft === true,
      mergeState: pr.mergeStateStatus,
      baseSha: BASE,
      allowlistKnown: true,
      authorAllowed: true,
      teamScopeKnown: true,
      leaseKnown: true,
      leaseHeld: false,
      scopeKnown: true,
      policyKnown: true,
      labels: [],
      labelsComplete: true,
    },
    ...over,
  };
}

function clientFor(prs, switches, detailOf) {
  const calls = { ready: [], enqueue: [], listed: 0 };
  let n = 0;
  const client = {
    calls,
    readSwitch() {
      const value = switches[Math.min(n, switches.length - 1)];
      n += 1;
      if (value === 'fail') return { ok: false, enabled: false };
      return { ok: true, enabled: value === true };
    },
    listOpen() {
      calls.listed += 1;
      return { ok: true, prs, truncated: false };
    },
    comments(number) {
      return { ok: true, comments: detailOf(number).comments };
    },
    files(number) {
      return { ok: true, files: detailOf(number).files };
    },
    checks() {
      return { ok: true, checks: detailOf(prs[0].number).checks };
    },
    evidence(number) {
      return { ok: true, evidence: detailOf(number).evidence };
    },
    queueState(number) {
      return { ok: true, queue: detailOf(number).queue };
    },
    ruleset() {
      return { ok: true, ruleset: detailOf(prs[0].number).ruleset };
    },
    ready(number) {
      calls.ready.push(number);
      return { ok: true };
    },
    enqueue(id, sha) {
      calls.enqueue.push({ id, sha });
      return { ok: true, entry: { position: 1, state: 'QUEUED' } };
    },
  };
  return client;
}

test('switch values other than true are off, and a 404 is a clean off', () => {
  assert.deepEqual(interpretSwitch({ status: 0, stdout: 'true\n' }), { ok: true, enabled: true });
  for (const value of ['false', 'TRUE', 'yes', '1', ' true', '']) {
    assert.equal(interpretSwitch({ status: 0, stdout: value }).enabled, false, value);
  }
  assert.deepEqual(interpretSwitch({ status: 1, stderr: 'HTTP 404: Not Found' }), { ok: true, enabled: false });
  assert.equal(interpretSwitch({ status: 1, stderr: 'HTTP 401' }).ok, false);
  assert.equal(readSwitch(REPO, '').ok, false);
});

test('admit exits 0 with no enabled output when the switch is unset or not true', () => {
  const block = admitBlock('mythos-flow-step.yml');
  assert.equal(block, admitBlock('mythos-final-gate.yml'));
  const base = {
    REPO, REF: 'refs/heads/main', EVENT: 'schedule', MODE: 'act', PR: '',
  };
  for (const SWITCH of ['', 'false', 'TRUE', 'yes', '1']) {
    const result = runAdmit(block, { ...base, SWITCH });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.outputs, /enabled=false/);
    assert.match(result.stdout, /without writes/);
  }
});

test('admit rejects a ref, repository, event, mode, or pull request outside the contract', () => {
  const block = admitBlock('mythos-flow-step.yml');
  const ok = { REPO, REF: 'refs/heads/main', EVENT: 'workflow_dispatch', SWITCH: 'true', MODE: 'dry-run', PR: '' };
  assert.match(runAdmit(block, ok).outputs, /enabled=true/);
  assert.match(runAdmit(block, ok).outputs, /mode=dry-run/);
  assert.equal(runAdmit(block, { ...ok, REF: 'refs/heads/feature' }).status, 1);
  assert.equal(runAdmit(block, { ...ok, REPO: 'other/repo' }).status, 1);
  assert.equal(runAdmit(block, { ...ok, EVENT: 'pull_request' }).status, 1);
  assert.equal(runAdmit(block, { ...ok, MODE: 'merge' }).status, 1);
  assert.equal(runAdmit(block, { ...ok, PR: '0' }).status, 1);
  assert.match(runAdmit(block, { ...ok, PR: '12', MODE: 'act' }).outputs, /pr=12/);
  const scheduled = runAdmit(block, { ...ok, EVENT: 'schedule', MODE: 'dry-run' });
  assert.match(scheduled.outputs, /mode=act/);
});

test('author PROOF comments are assertions and do not authorize', () => {
  assert.equal(authorAssertion(proofComments(HEAD, 'ada'), HEAD), true);
  assert.equal(authorAssertion(proofComments(HEAD, 'mythos-writer-flow[bot]'), HEAD), true);
  assert.equal(evidenceOk(null, HEAD, 7, 'main', BASE), false);
  assert.equal(classify(readyFacts({ proof: false })).reason, 'missing independent evidence run');
  assert.equal(evidenceOk(evidenceFor(HEAD, 7), HEAD, 7, 'main', BASE), true);
  const wrongBlob = evidenceFor(HEAD, 7);
  wrongBlob.runs[0].workflowBlob = '3'.repeat(40);
  assert.equal(evidenceOk(wrongBlob, HEAD, 7, 'main', BASE), false);
  const otherPr = evidenceFor(HEAD, 8);
  assert.equal(evidenceOk(otherPr, HEAD, 7, 'main', BASE), false);
  const laterFailure = evidenceFor(HEAD, 7);
  laterFailure.runs.push({
    ...laterFailure.runs[0],
    runId: 500,
    conclusion: 'failure',
  });
  assert.equal(evidenceOk(laterFailure, HEAD, 7, 'main', BASE), false);
  const wrongEvent = evidenceFor(HEAD, 7);
  wrongEvent.runs[0].event = 'push';
  assert.equal(evidenceOk(wrongEvent, HEAD, 7, 'main', BASE), false);
  const movedBase = evidenceFor(HEAD, 7);
  movedBase.runs[0].prBaseSha = 'c'.repeat(40);
  assert.equal(evidenceOk(movedBase, HEAD, 7, 'main', BASE), false);
});

test('a rename out of a protected path is held', () => {
  const renamed = [{ filename: 'src/x.ts', status: 'renamed', previous_filename: 'electron-main/src/db.ts' }];
  assert.equal(filesLookProtected(renamed), true);
  assert.equal(classify(readyFacts({ protectedPath: filesLookProtected(renamed) })).reason, 'protected path');
});

test('classify holds forks, batch bases, protected paths, missing proof, and a missing tip gate', () => {
  assert.equal(classify(readyFacts()).action, 'enqueue');
  assert.equal(classify(readyFacts({ fork: true })).reason, 'fork');
  assert.equal(classify(readyFacts({ base: 'batch/lane' })).reason, 'base is not main');
  assert.equal(classify(readyFacts({ protectedPath: true })).reason, 'protected path');
  assert.equal(classify(readyFacts({ labels: ['tip-freeze'] })).reason, 'hold label');
  assert.equal(classify(readyFacts({ proof: false })).reason, 'missing independent evidence run');
  assert.equal(classify(readyFacts({ mergeState: 'BEHIND' })).reason, 'rebase needed');
  assert.equal(classify(readyFacts({ mergeState: 'UNKNOWN' })).reason, 'mergeability unknown');
  assert.equal(classify(readyFacts({ draft: true, gate: false })).action, 'undraft');
  assert.equal(classify(readyFacts({ gate: false })).reason, 'tip gate missing');
  assert.equal(classify(readyFacts({ queueEnabled: false })).reason, 'base has no merge queue');
  assert.equal(classify(readyFacts({ inQueue: true })).reason, 'already in the merge queue');
  assert.equal(classify(readyFacts({ head: 'abc' })).reason, 'head sha');
  assert.equal(classify(readyFacts({ allowlistKnown: false })).reason, 'author allow-list missing');
  assert.equal(classify(readyFacts({ scopeKnown: false })).reason, 'team/scope unknown');
  assert.equal(classify(readyFacts({ authorAllowed: false })).reason, 'author not allow-listed');
  assert.equal(classify(readyFacts({ leaseKnown: false })).reason, 'lease unknown');
  assert.equal(classify(readyFacts({ labels: ['LEASE'] })).reason, 'lease');
  assert.equal(classify(readyFacts({ labels: ['Lease:active'] })).reason, 'lease');
  assert.equal(classify(readyFacts({ rulesetKnown: false })).reason, 'ruleset policy unknown');
  assert.equal(classify(readyFacts({ rulesetMatch: false })).reason, 'ruleset policy mismatch');
});

test('a disabled or unreadable switch performs no undraft and no enqueue', () => {
  const pr = prRecord();
  const detail = detailFor(pr);
  const off = clientFor([pr], [false], () => detail);
  assert.equal(plan(off, 'act').enabled, false);
  assert.equal(off.calls.listed, 0);
  assert.equal(enqueue(off, 'act').wrote, 0);
  assert.deepEqual(off.calls.enqueue, []);
  const failed = clientFor([pr], ['fail'], () => detail);
  assert.equal(plan(failed, 'act').ok, false);
  assert.equal(failed.calls.listed, 0);
});

test('dry-run and a switch that flips off before the write do not enqueue', () => {
  const pr = prRecord();
  const detail = detailFor(pr);
  const dry = clientFor([pr], [true], () => detail);
  assert.equal(enqueue(dry, 'dry-run').wrote, 0);
  assert.deepEqual(dry.calls.enqueue, []);
  const second = prRecord({ number: 8 });
  const flip = clientFor([pr, second], [true, true, false], () => detail);
  const result = enqueue(flip, 'act');
  assert.equal(result.wrote, 1);
  assert.equal(flip.calls.enqueue.length, 1);
  assert.equal(flip.calls.enqueue[0].sha, HEAD);
  assert.equal(flip.calls.enqueue[0].id, 'PR_node');
});

test('act undrafts a proven draft without a tip gate and enqueues one ready main pull request', () => {
  const draft = prRecord({ isDraft: true, mergeStateStatus: 'DRAFT' });
  const draftDetail = detailFor(draft, {
    checks: {
      ci: { conclusion: 'success', headSha: HEAD },
      'notes-windows': { conclusion: 'success', headSha: HEAD },
      'screenshot-check': { conclusion: 'success', headSha: HEAD },
    },
    queue: { ...detailFor(draft).queue, draft: true, queueEnabled: false },
  });
  const undrafting = clientFor([draft], [true, true], () => draftDetail);
  assert.equal(undraft(undrafting, 'act').wrote, 1);
  assert.deepEqual(undrafting.calls.ready, [7]);
  assert.deepEqual(undrafting.calls.enqueue, []);

  const ready = prRecord();
  const enqueuing = clientFor([ready], [true, true], () => detailFor(ready));
  assert.equal(enqueue(enqueuing, 'act').wrote, 1);
  assert.deepEqual(enqueuing.calls.enqueue, [{ id: 'PR_node', sha: HEAD }]);
});

test('a moved tip, a batch base, and a protected path do not enqueue', () => {
  const moved = prRecord();
  const movedDetail = detailFor(moved);
  movedDetail.queue = { ...movedDetail.queue, head: 'b'.repeat(40) };
  const moving = clientFor([moved], [true, true], () => movedDetail);
  assert.equal(enqueue(moving, 'act').wrote, 0);

  const batch = prRecord({ baseRefName: 'batch/lane' });
  const batching = clientFor([batch], [true], () => detailFor(batch));
  assert.equal(plan(batching, 'act').enqueue, 0);

  const protectedPr = prRecord();
  const protectedDetail = detailFor(protectedPr, { files: [{ filename: '.github/workflows/ci.yml' }] });
  const holding = clientFor([protectedPr], [true], () => protectedDetail);
  assert.equal(plan(holding, 'act').enqueue, 0);
  assert.equal(plan(holding, 'act').undraft, 0);
});

test('act without a write token or with the wrong app id fails before a write', () => {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MODE: 'act',
    REPO,
    WRITE_APP_ID,
    WRITE_INSTALLATION_ID,
  };
  const missing = spawnSync(process.execPath, [path.join(__dirname, 'unattended', 'flow-run.js'), 'enqueue'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /token is missing/);
  const wrong = spawnSync(process.execPath, [path.join(__dirname, 'unattended', 'flow-run.js'), 'undraft'], {
    encoding: 'utf8',
    env: { ...env, WRITE_APP_ID: '1', READY_TOKEN: 'present' },
  });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /write app identity/);
});

test('enqueue uses expectedHeadOid and does not ask to jump the queue', () => {
  assert.match(ENQUEUE_QUERY, /enqueuePullRequest/);
  assert.match(ENQUEUE_QUERY, /expectedHeadOid/);
  assert.equal(ENQUEUE_QUERY.includes('jump'), false);
  assert.equal(ENQUEUE_QUERY.includes('admin'), false);
});

test('a gh child receives only its own token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-child-'));
  const log = path.join(dir, 'log');
  const bin = path.join(dir, 'gh');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "GH_TOKEN=$GH_TOKEN" >> '${log}'\nprintf '%s\\n' "LEAK=$LEAKED_SECRET" >> '${log}'\n`);
  fs.chmodSync(bin, 0o755);
  const previousBin = process.env.GH_BIN;
  const previousLeak = process.env.LEAKED_SECRET;
  process.env.GH_BIN = bin;
  process.env.LEAKED_SECRET = 'super-secret';
  try {
    gh(['api', 'repos/example'], 'read-token');
    const text = fs.readFileSync(log, 'utf8');
    assert.match(text, /GH_TOKEN=read-token/);
    assert.match(text, /LEAK=$/m);
    assert.equal(text.includes('super-secret'), false);
  } finally {
    if (previousBin === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = previousBin;
    if (previousLeak === undefined) delete process.env.LEAKED_SECRET;
    else process.env.LEAKED_SECRET = previousLeak;
  }
});

test('model transports are unavailable and cannot reduce to a pass', () => {
  const claude = transportResult('claude', { runId: '9', runAttempt: '1' });
  const codex = transportResult('codex', { runId: '9', runAttempt: '1' });
  assert.equal(claude.status, 'unavailable');
  assert.equal(codex.status, 'unavailable');
  assert.equal(reduce(claude, codex, { runId: '9', runAttempt: '1' }).decision, 'no-pass');
  const head = HEAD;
  const pass = (provider, risk) => ({
    schema: 'mythos-gate-result/v1', provider, status: 'pass', repository: REPO, headSha: head,
    runId: '9', runAttempt: '1', risk, pr: 7,
  });
  assert.equal(reduce(pass('claude', 'high'), pass('codex', 'high'), { runId: '9', runAttempt: '1' }).decision, 'no-pass');
  const accepted = reduce(pass('claude', 'low'), pass('codex', 'low'), { runId: '9', runAttempt: '1' });
  assert.equal(accepted.decision, 'pass');
  assert.equal(acceptReducer(accepted, { runId: '8', runAttempt: '1' }), null);
  assert.equal(acceptReducer({ ...accepted, risk: 'high' }, { runId: '9', runAttempt: '1' }), null);
});

test('queue policy posts success only for an exact main tree and withholds a moved ref', () => {
  const head = HEAD;
  const parent = 'd'.repeat(40);
  const entry = {
    ref: `refs/heads/gh-readonly-queue/main/pr-7-${head}`,
    base: 'main',
    pr: 7,
    sha: 'c'.repeat(40),
  };
  const view = {
    prReadable: true,
    state: 'open',
    draft: false,
    base: 'main',
    head,
    headRunReadable: true,
    headRun: { status: 'completed', conclusion: 'success', appId: GATE_APP_ID, summary: `Head: ${head}\n` },
    baseTip: parent,
    gitOk: true,
    parents: [parent],
    tree: { ok: true, equal: true },
  };
  assert.equal(decideQueueEntry(entry, view, new Set()).state, 'success');
  assert.equal(decideQueueEntry(entry, { ...view, tree: { ok: true, equal: false } }, new Set()).state, 'failure');
  assert.equal(decideQueueEntry(entry, { ...view, headRun: { ...view.headRun, appId: 1 } }, new Set()).state, 'in_progress');
  assert.equal(decideQueueEntry({ ...entry, base: 'batch/lane' }, view, new Set()).state, null);
  assert.equal(decideQueueEntry(entry, { ...view, parents: ['e'.repeat(40), 'f'.repeat(40)] }, new Set()).state, 'failure');
  assert.equal(stillQueue(entry, head, parent, {
    refSha: 'e'.repeat(40), state: 'open', draft: false, head, base: 'main', collision: false, listReadable: true, baseTip: parent,
  }, new Set()), false);
  assert.equal(parseQueueRef({ ref: entry.ref, object: { sha: entry.sha } }).pr, 7);
});

test('publish does nothing when the switch is off and asks for a token before any post', () => {
  const quiet = {
    calls: [],
    readSwitch: () => ({ ok: true, enabled: false }),
    listEntries() { this.calls.push('list'); return { ok: true, entries: [] }; },
    writeRun() { this.calls.push('write'); return { ok: true }; },
  };
  assert.equal(runPublish(quiet, { mode: 'act', gateAppId: String(GATE_APP_ID), gateToken: 'token' }).code, 0);
  assert.deepEqual(quiet.calls, []);

  const entry = parseQueueRef({
    ref: `refs/heads/gh-readonly-queue/main/pr-7-${HEAD}`,
    object: { sha: 'c'.repeat(40) },
  });
  const probe = {
    writes: 0,
    readSwitch: () => ({ ok: true, enabled: true }),
    listEntries: () => ({ ok: true, entries: [entry] }),
    writeRun() { this.writes += 1; return { ok: true }; },
  };
  assert.equal(runPublish(probe, { mode: 'act', gateAppId: String(GATE_APP_ID), gateToken: '' }).code, 2);
  assert.equal(probe.writes, 0);
});

test('publish posts one success when the queue tree matches and the switch stays on', () => {
  const head = HEAD;
  const parent = 'd'.repeat(40);
  const entry = {
    ref: `refs/heads/gh-readonly-queue/main/pr-7-${head}`,
    base: 'main',
    pr: 7,
    sha: 'c'.repeat(40),
  };
  const writes = [];
  const io = {
    readSwitch: () => ({ ok: true, enabled: true }),
    listEntries: () => ({ ok: true, entries: [entry] }),
    pull: () => ({ prReadable: true, state: 'open', draft: false, base: 'main', head }),
    headGate: () => ({
      headRunReadable: true,
      headRun: { id: 4, status: 'completed', conclusion: 'success', appId: GATE_APP_ID, summary: `Head: ${head}\n` },
    }),
    ourRun(sha) {
      if (sha === entry.sha) return { headRunReadable: true, headRun: null };
      return this.headGate();
    },
    baseTip: () => parent,
    prepare: () => true,
    parents: () => [parent],
    tree: () => ({ ok: true, equal: true }),
    refSha: () => entry.sha,
    collision: () => ({ listReadable: true, collision: false }),
    ruleset: () => ({ ok: true, ruleset: { known: true, match: true } }),
    writeRun(...args) {
      writes.push(args);
      return { ok: true };
    },
  };
  const result = runPublish(io, { mode: 'act', gateAppId: String(GATE_APP_ID), gateToken: 'gate' });
  assert.equal(result.code, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2], 'completed');
  assert.equal(writes[0][3], 'success');
});

test('merge-tree equality accepts the clean tree and rejects a different queue commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-tree-'));
  const git = (args) => spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  assert.equal(git(['init', '-q']).status, 0);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  git(['add', 'a.txt']);
  assert.equal(git(['commit', '-q', '-m', 'base']).status, 0);
  const base = git(['rev-parse', 'HEAD']).stdout.trim();
  git(['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'side\n');
  git(['add', 'b.txt']);
  assert.equal(git(['commit', '-q', '-m', 'side']).status, 0);
  const side = git(['rev-parse', 'HEAD']).stdout.trim();
  const tree = git(['merge-tree', '--write-tree', base, side]).stdout.trim();
  const queue = git(['commit-tree', tree, '-p', base, '-m', 'queue']).stdout.trim();
  assert.equal(treesMatch(dir, base, side, queue).equal, true);
  assert.deepEqual(parentsOf(dir, queue), [base]);
  fs.writeFileSync(path.join(dir, 'c.txt'), 'other\n');
  git(['add', 'c.txt']);
  git(['commit', '-q', '-m', 'other']);
  const other = git(['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(treesMatch(dir, base, side, other).equal, false);
});

function usesOf(doc) {
  const found = [];
  for (const job of Object.values(doc.jobs)) {
    for (const step of job.steps || []) {
      if (step.uses) found.push(step.uses);
    }
  }
  return found;
}

test('privileged workflows are inert controllers with pinned actions and split credentials', () => {
  for (const name of ['mythos-final-gate.yml', 'mythos-flow-step.yml']) {
    const text = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
    const doc = loadWorkflow(name);
    const on = triggerOf(doc);
    assert.deepEqual(doc.permissions, {});
    assert.deepEqual(Object.keys(on).sort(), ['schedule', 'workflow_dispatch']);
    assert.equal(triggerOf(doc).pull_request, undefined, name);
    assert.equal(text.includes('pull_request_target'), false, name);
    assert.equal(text.includes('workflow_run'), false, name);
    assert.equal(text.includes('OPENROUTER'), false, name);
    assert.equal(text.includes('--admin'), false, name);
    assert.equal(text.includes('pr merge'), false, name);
    assert.equal(text.includes('secrets: inherit'), false, name);
    assert.equal(text.includes('continue-on-error'), false, name);
    for (const job of Object.values(doc.jobs)) {
      assert.ok(job.permissions, name);
      assert.ok(job['timeout-minutes'] < 60, name);
      assert.equal(job['runs-on'], 'ubuntu-latest');
    }
    for (const uses of usesOf(doc)) {
      assert.match(uses, /@[0-9a-f]{40}( # .+)?$/, uses);
    }
    for (const job of Object.values(doc.jobs)) {
      for (const step of job.steps || []) {
        if (String(step.uses || '').startsWith('actions/checkout')) {
          assert.equal(step.with['persist-credentials'], false);
          assert.equal(step.with.submodules, false);
        }
      }
    }
  }

  const gate = loadWorkflow('mythos-final-gate.yml');
  const flow = loadWorkflow('mythos-flow-step.yml');
  const gateText = fs.readFileSync(path.join(WORKFLOWS, 'mythos-final-gate.yml'), 'utf8');
  const flowText = fs.readFileSync(path.join(WORKFLOWS, 'mythos-flow-step.yml'), 'utf8');
  assert.equal(gateText.includes('MYTHOS_WRITE_APP_PRIVATE_KEY'), false);
  assert.equal(flowText.includes('MYTHOS_GATE_APP_PRIVATE_KEY'), false);
  assert.equal(gateText.includes('CLAUDE_CODE_OAUTH_TOKEN'), false);
  assert.equal(gateText.includes('OPENAI_API_KEY'), false);
  assert.equal(flowText.includes('CLAUDE_CODE_OAUTH_TOKEN'), false);
  assert.equal(flowText.includes('OPENAI_API_KEY'), false);
  assert.match(gateText, /MYTHOS_GATE_APP_PRIVATE_KEY/);
  assert.match(gateText, /permission-checks: write/);
  assert.match(flowText, /MYTHOS_WRITE_APP_PRIVATE_KEY/);
  assert.match(flowText, /enqueuePullRequest|flow-run.js enqueue/);
  const allowlisted = flow.jobs.act.steps.filter((step) => String(step.run || '').includes('flow-run.js'));
  assert.equal(allowlisted.length, 3);
  for (const step of allowlisted) {
    assert.equal(step.env.MYTHOS_FLOW_AUTHOR_ALLOWLIST, '${{ vars.MYTHOS_FLOW_AUTHOR_ALLOWLIST }}');
  }
  assert.equal(flowText.includes('permission-merge-queues'), false);
  assert.match(flowText, /token-grant.js/);
  for (const name of ['transport-claude', 'transport-codex', 'reduce', 'discover']) {
    assert.equal(JSON.stringify(gate.jobs[name]).includes('secrets.'), false, name);
  }
  assert.equal(gate.jobs.publish.environment, 'mythos-publisher');
  assert.equal(flow.jobs.act.environment, 'mythos-writer');
  assert.equal(gate.jobs.publish.concurrency.group, 'mythos-unattended-mutate');
  assert.equal(flow.jobs.act.concurrency.group, 'mythos-unattended-mutate');
  assert.equal(gate.jobs.publish.concurrency['cancel-in-progress'], false);
  assert.equal(gate.jobs['transport-claude'].concurrency.group, 'mythos-unattended-model');

  const contracts = fs.readFileSync(path.join(WORKFLOWS, 'mythos-automation-contracts.yml'), 'utf8');
  const contractsDoc = loadWorkflow('mythos-automation-contracts.yml');
  assert.equal(contracts.includes('secrets.'), false);
  assert.equal(contractsDoc.jobs.contracts.environment, undefined);
  assert.deepEqual(contractsDoc.jobs.contracts.permissions, { contents: 'read' });
  assert.ok(Object.prototype.hasOwnProperty.call(triggerOf(contractsDoc), 'pull_request'));
  assert.deepEqual(triggerOf(contractsDoc).merge_group, { types: ['checks_requested'] });
  assert.match(contracts, /npm ci --ignore-scripts/);
});

test('the switch is read after validation, so a flip during those reads blocks the write', () => {
  const pr = prRecord();
  const detail = detailFor(pr);
  let enabled = true;
  const calls = { enqueue: [] };
  const client = {
    calls,
    readSwitch() { return { ok: true, enabled }; },
    listOpen() { return { ok: true, prs: [pr], truncated: false }; },
    comments() { return { ok: true, comments: detail.comments }; },
    files() { enabled = false; return { ok: true, files: detail.files }; },
    checks() { return { ok: true, checks: detail.checks }; },
    evidence() { return { ok: true, evidence: detail.evidence }; },
    queueState() { return { ok: true, queue: detail.queue }; },
    ruleset() { return { ok: true, ruleset: { known: true, match: true } }; },
    enqueue(id, sha) { calls.enqueue.push({ id, sha }); return { ok: true, entry: { position: 1, state: 'QUEUED' } }; },
  };
  assert.equal(enqueue(client, 'act').wrote, 0);
  assert.deepEqual(calls.enqueue, []);
});

test('a hold label that appears after the list read blocks the write', () => {
  const pr = prRecord();
  const detail = detailFor(pr);
  let reads = 0;
  const calls = { enqueue: [] };
  const client = {
    calls,
    readSwitch() { return { ok: true, enabled: true }; },
    listOpen() { return { ok: true, prs: [pr], truncated: false }; },
    comments() { return { ok: true, comments: detail.comments }; },
    files() { return { ok: true, files: detail.files }; },
    checks() { return { ok: true, checks: detail.checks }; },
    evidence() { return { ok: true, evidence: detail.evidence }; },
    ruleset() { return { ok: true, ruleset: { known: true, match: true } }; },
    queueState() {
      reads += 1;
      return {
        ok: true,
        queue: { ...detail.queue, labels: reads >= 2 ? ['tip-freeze'] : [], labelsComplete: true },
      };
    },
    enqueue(id, sha) { calls.enqueue.push({ id, sha }); return { ok: true, entry: { position: 1, state: 'QUEUED' } }; },
  };
  assert.equal(enqueue(client, 'act').wrote, 0);
  assert.deepEqual(calls.enqueue, []);
});

test('paginated JSON pages flatten, and a rename keeps both filenames', () => {
  const pages = JSON.stringify([
    [{ filename: 'src/x.ts', status: 'renamed', previous_filename: 'electron-main/src/db.ts' }],
    [{ filename: 'README.md', status: 'modified' }],
  ]);
  const rows = flattenPages(pages).map(mapChangedFile);
  assert.equal(rows.length, 2);
  assert.equal(filesLookProtected(rows), true);
  const runs = flattenRunPages(JSON.stringify([
    { total_count: 2, workflow_runs: [{ id: 1 }] },
    { total_count: 2, workflow_runs: [{ id: 2 }] },
  ]));
  assert.deepEqual(runs.map((run) => run.id), [1, 2]);
  assert.equal(flattenRunPages(JSON.stringify([{ total_count: 3, workflow_runs: [{ id: 1 }] }])), null);
});

test('files() reads every page and both sides of a rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  const bin = path.join(dir, 'gh');
  const body = JSON.stringify([[
    { filename: 'src/x.ts', status: 'renamed', previous_filename: 'electron-main/src/db.ts' },
  ], [
    { filename: 'README.md', status: 'modified' },
  ]]);
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${body}'\n`);
  fs.chmodSync(bin, 0o755);
  const previous = process.env.GH_BIN;
  process.env.GH_BIN = bin;
  try {
    const client = createClient({ repo: REPO, readToken: 'read' });
    const got = client.files(7);
    assert.equal(got.ok, true);
    assert.equal(filesLookProtected(got.files), true);
  } finally {
    if (previous === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = previous;
  }
});

test('a passed queue parent is not reused after the base tip changes', () => {
  const head = HEAD;
  const oldTip = 'd'.repeat(40);
  const newTip = 'e'.repeat(40);
  const entry = {
    ref: `refs/heads/gh-readonly-queue/main/pr-7-${head}`,
    base: 'main',
    pr: 7,
    sha: 'c'.repeat(40),
  };
  const { decideQueueEntry } = require('./unattended/queue-policy');
  const view = {
    prReadable: true,
    state: 'open',
    draft: false,
    base: 'main',
    head,
    headRunReadable: true,
    headRun: { status: 'completed', conclusion: 'success', appId: GATE_APP_ID, summary: `Head: ${head}\n` },
    baseTip: newTip,
    gitOk: true,
    parents: [oldTip],
    tree: { ok: true, equal: true },
  };
  const chain = { baseTip: oldTip, parents: new Set([oldTip]) };
  assert.equal(decideQueueEntry(entry, view, chain).state, 'in_progress');
  assert.equal(decideQueueEntry(entry, { ...view, parents: [] }, chain).state, 'in_progress');
});

test('a head gate that disappears before the post is not published as success', () => {
  const head = HEAD;
  const parent = 'd'.repeat(40);
  const entry = {
    ref: `refs/heads/gh-readonly-queue/main/pr-7-${head}`,
    base: 'main',
    pr: 7,
    sha: 'c'.repeat(40),
  };
  let gates = 0;
  const writes = [];
  const success = {
    headRunReadable: true,
    headRun: { id: 4, status: 'completed', conclusion: 'success', appId: GATE_APP_ID, summary: `Head: ${head}\n` },
  };
  const io = {
    readSwitch: () => ({ ok: true, enabled: true }),
    listEntries: () => ({ ok: true, entries: [entry] }),
    pull: () => ({ prReadable: true, state: 'open', draft: false, base: 'main', head }),
    headGate() {
      gates += 1;
      return gates === 1 ? success : { headRunReadable: true, headRun: null };
    },
    ourRun: () => ({ headRunReadable: true, headRun: null }),
    baseTip: () => parent,
    prepare: () => true,
    parents: () => [parent],
    tree: () => ({ ok: true, equal: true }),
    refSha: () => entry.sha,
    collision: () => ({ listReadable: true, collision: false }),
    writeRun(...args) { writes.push(args); return { ok: true }; },
  };
  const result = runPublish(io, { mode: 'act', gateAppId: String(GATE_APP_ID), gateToken: 'gate' });
  assert.equal(result.code, 0);
  assert.equal(writes.length, 0);
});

test('publish limits itself to the requested pull request', () => {
  const head = HEAD;
  const parent = 'd'.repeat(40);
  const one = { ref: `refs/heads/gh-readonly-queue/main/pr-7-${head}`, base: 'main', pr: 7, sha: 'c'.repeat(40) };
  const two = { ref: `refs/heads/gh-readonly-queue/main/pr-8-${head}`, base: 'main', pr: 8, sha: 'b'.repeat(40) };
  const writes = [];
  const io = {
    readSwitch: () => ({ ok: true, enabled: true }),
    listEntries: () => ({ ok: true, entries: [one, two] }),
    pull: () => ({ prReadable: true, state: 'open', draft: false, base: 'main', head }),
    headGate: () => ({
      headRunReadable: true,
      headRun: { id: 4, status: 'completed', conclusion: 'success', appId: GATE_APP_ID, summary: `Head: ${head}\n` },
    }),
    ourRun: () => ({ headRunReadable: true, headRun: null }),
    baseTip: () => parent,
    prepare: () => true,
    parents: () => [parent],
    tree: () => ({ ok: true, equal: true }),
    refSha(ref) { return ref.includes('pr-7-') ? one.sha : two.sha; },
    collision: () => ({ listReadable: true, collision: false }),
    ruleset: () => ({ ok: true, ruleset: { known: true, match: true } }),
    writeRun(existing, sha) { writes.push(sha); return { ok: true }; },
  };
  const result = runPublish(io, { mode: 'act', gateAppId: String(GATE_APP_ID), gateToken: 'gate', pr: '7' });
  assert.equal(result.code, 0);
  assert.deepEqual(writes, [one.sha]);
});

test('fetch into a fresh bare repository keeps the queue commit parent', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-dst-'));
  const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
  assert.equal(git(source, ['init', '-q']).status, 0);
  fs.writeFileSync(path.join(source, 'a.txt'), 'base\n');
  git(source, ['add', 'a.txt']);
  assert.equal(git(source, ['commit', '-q', '-m', 'base']).status, 0);
  const base = git(source, ['rev-parse', 'HEAD']).stdout.trim();
  git(source, ['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(source, 'b.txt'), 'side\n');
  git(source, ['add', 'b.txt']);
  assert.equal(git(source, ['commit', '-q', '-m', 'side']).status, 0);
  const side = git(source, ['rev-parse', 'HEAD']).stdout.trim();
  const tree = git(source, ['merge-tree', '--write-tree', base, side]).stdout.trim();
  const queue = git(source, ['commit-tree', tree, '-p', base, '-m', 'queue']).stdout.trim();
  assert.equal(git(dest, ['init', '--bare', '-q']).status, 0);
  assert.equal(fetchObjects(dest, [queue], { depth: 1, url: source }), true);
  assert.deepEqual(parentsOf(dest, queue), []);
  assert.equal(fetchObjects(dest, [queue, side], { depth: 2, url: source }), true);
  assert.deepEqual(parentsOf(dest, queue), [base]);
  assert.equal(treesMatch(dest, base, side, queue).equal, true);
});

test('token grant must be the one repository and unexpired', () => {
  const body = JSON.stringify({
    total_count: 1,
    repositories: [{ full_name: REPO }],
  });
  const ok = [
    'HTTP/1.1 200 OK',
    'Github-Authentication-Token-Expiration: 2099-01-01 00:00:00 UTC',
    '',
    body,
  ].join('\n');
  assert.equal(interpretGrant(ok).ok, true);
  const otherRepo = ok.replace(REPO, 'other/repo');
  assert.equal(interpretGrant(otherRepo).ok, false);
  const expired = ok.replace('2099-01-01', '2000-01-01');
  assert.equal(interpretGrant(expired).ok, false);
  const two = ok.replace('"total_count":1', '"total_count":2').replace(
    `"full_name":"${REPO}"`,
    `"full_name":"${REPO}"},{"full_name":"other/repo"`,
  );
  assert.equal(interpretGrant(two).ok, false);
});

test('one unreadable pull request is held and the next one can still be enqueued', () => {
  const bad = prRecord({ number: 4 });
  const good = prRecord({ number: 9 });
  const goodDetail = detailFor(good);
  const calls = { enqueue: [] };
  const client = {
    calls,
    readSwitch() { return { ok: true, enabled: true }; },
    listOpen() { return { ok: true, prs: [bad, good], truncated: false }; },
    comments(number) {
      if (number === 4) return { ok: false, error: 'comments unreadable' };
      return { ok: true, comments: goodDetail.comments };
    },
    files() { return { ok: true, files: goodDetail.files }; },
    checks() { return { ok: true, checks: goodDetail.checks }; },
    evidence() { return { ok: true, evidence: goodDetail.evidence }; },
    queueState() { return { ok: true, queue: goodDetail.queue }; },
    ruleset() { return { ok: true, ruleset: goodDetail.ruleset }; },
    enqueue(id, sha) { calls.enqueue.push({ id, sha }); return { ok: true, entry: { position: 1, state: 'QUEUED' } }; },
  };
  const result = enqueue(client, 'act');
  assert.equal(result.ok, true);
  assert.equal(result.wrote, 1);
  assert.deepEqual(calls.enqueue, [{ id: 'PR_node', sha: HEAD }]);
});

function matchingRules(over = {}) {
  const checks = [
    { context: 'ci', integration_id: CI_INTEGRATION_ID },
    { context: 'notes-windows', integration_id: CI_INTEGRATION_ID },
    { context: 'screenshot-check', integration_id: CI_INTEGRATION_ID },
    { context: CHECK_NAME, integration_id: GATE_APP_ID },
  ];
  return [
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: checks,
        ...over.checks,
      },
    },
    {
      type: 'merge_queue',
      parameters: { merge_method: 'SQUASH', ...over.queue },
    },
  ];
}

test('the author allow-list and head repository are explicit holds', () => {
  assert.equal(parseAllowlist(undefined), null);
  assert.equal(parseAllowlist(''), null);
  assert.equal(parseAllowlist(' , '), null);
  assert.deepEqual([...parseAllowlist('SkyyPlayz, cursor[bot] ')], ['skyyplayz', 'cursor[bot]']);
  const bots = parseAllowlist('cursor[bot]');
  assert.equal(authorMatches({ __typename: 'Bot', login: 'cursor' }, bots), true);
  assert.equal(authorMatches({ __typename: 'Bot', login: 'Cursor' }, parseAllowlist('CURSOR[bot]')), true);
  assert.equal(authorMatches({ __typename: 'User', login: 'SKYYPLAYZ' }, parseAllowlist('SkyyPlayz')), true);
  assert.equal(authorMatches({ __typename: 'User', login: 'cursor' }, bots), false);
  assert.equal(leaseHeldFrom(['LEASE']), true);
  assert.equal(leaseHeldFrom(['Lease:active']), true);
  assert.equal(leaseHeldFrom(['release']), false);

  const matched = rulesetMatches(matchingRules());
  assert.equal(matched.known, true);
  assert.equal(matched.match, true);
  assert.equal(rulesetMatches(null).known, false);
  const loose = matchingRules();
  loose[0].parameters.strict_required_status_checks_policy = false;
  assert.equal(rulesetMatches(loose).match, false);
  const otherApp = matchingRules();
  otherApp[0].parameters.required_status_checks[0].integration_id = 1;
  assert.equal(rulesetMatches(otherApp).match, false);
  const merge = matchingRules();
  merge[1].parameters.merge_method = 'MERGE';
  assert.equal(rulesetMatches(merge).match, false);
  assert.equal(rulesetMatches(matchingRules().filter((rule) => rule.type !== 'merge_queue')).match, false);

  const previous = process.env.MYTHOS_FLOW_AUTHOR_ALLOWLIST;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-'));
  const bin = path.join(dir, 'gh');
  function install(payload) {
    fs.writeFileSync(bin, `#!/bin/sh\ninput=$(cat)\nprintf '%s' "$input" | grep -q '__typename' || exit 1\nprintf '%s' '${JSON.stringify(payload)}'\n`);
    fs.chmodSync(bin, 0o755);
    process.env.GH_BIN = bin;
  }
  function pull(author, head, labels, typename) {
    return {
      data: {
        repository: {
          pullRequest: {
            id: 'PR_node',
            isDraft: false,
            isInMergeQueue: false,
            isMergeQueueEnabled: true,
            headRefOid: HEAD,
            baseRefName: 'main',
            baseRefOid: BASE,
            state: 'OPEN',
            mergeStateStatus: 'CLEAN',
            author: { __typename: typename || 'User', login: author },
            headRepository: head ? { nameWithOwner: head } : null,
            labels: { pageInfo: { hasNextPage: false }, nodes: labels.map((name) => ({ name })) },
          },
        },
      },
    };
  }
  const savedBin = process.env.GH_BIN;
  try {
    install(pull('ada', REPO, []));
    delete process.env.MYTHOS_FLOW_AUTHOR_ALLOWLIST;
    assert.equal(createClient({ repo: REPO, readToken: 'read' }).queueState(7).queue.allowlistKnown, false);
    process.env.MYTHOS_FLOW_AUTHOR_ALLOWLIST = '';
    assert.equal(createClient({ repo: REPO, readToken: 'read' }).queueState(7).queue.allowlistKnown, false);
    process.env.MYTHOS_FLOW_AUTHOR_ALLOWLIST = 'SkyyPlayz,cursor[bot]';
    const outsider = createClient({ repo: REPO, readToken: 'read' }).queueState(7).queue;
    assert.equal(outsider.authorAllowed, false);
    assert.equal(outsider.fork, false);
    install(pull('SkyyPlayz', REPO, ['LEASE']));
    const allowed = createClient({ repo: REPO, readToken: 'read' }).queueState(7).queue;
    assert.equal(allowed.authorAllowed, true);
    assert.equal(allowed.leaseHeld, true);
    install(pull('cursor[bot]', 'other/Mythos-Writer', ['Lease:bot']));
    const fork = createClient({ repo: REPO, readToken: 'read' }).queueState(7).queue;
    assert.equal(fork.fork, true);
    assert.equal(fork.authorAllowed, false);
    assert.equal(fork.leaseHeld, true);
    install(pull('SkyyPlayz', null, []));
    assert.equal(createClient({ repo: REPO, readToken: 'read' }).queueState(7).queue.scopeKnown, false);
    install(pull('cursor', REPO, [], 'Bot'));
    const bot = createClient({ repo: REPO, readToken: 'read' }).queueState(7).queue;
    assert.equal(bot.author, 'cursor[bot]');
    assert.equal(bot.authorAllowed, true);
    install(pull('cursor', REPO, [], 'User'));
    const sameName = createClient({ repo: REPO, readToken: 'read' }).queueState(7).queue;
    assert.equal(sameName.author, 'cursor');
    assert.equal(sameName.authorAllowed, false);
    process.env.MYTHOS_FLOW_AUTHOR_ALLOWLIST = 'CURSOR[BOT],SKYYPLAYZ';
    install(pull('Cursor', REPO, [], 'Bot'));
    assert.equal(createClient({ repo: REPO, readToken: 'read' }).queueState(7).queue.authorAllowed, true);
  } finally {
    if (previous === undefined) delete process.env.MYTHOS_FLOW_AUTHOR_ALLOWLIST;
    else process.env.MYTHOS_FLOW_AUTHOR_ALLOWLIST = previous;
    if (savedBin === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = savedBin;
  }
});

test('a ruleset that changes before the write is not used', () => {
  const pr = prRecord();
  const detail = detailFor(pr);
  let reads = 0;
  const calls = { enqueue: [] };
  const client = {
    calls,
    readSwitch() { return { ok: true, enabled: true }; },
    listOpen() { return { ok: true, prs: [pr], truncated: false }; },
    comments() { return { ok: true, comments: detail.comments }; },
    files() { return { ok: true, files: detail.files }; },
    checks() { return { ok: true, checks: detail.checks }; },
    evidence() { return { ok: true, evidence: detail.evidence }; },
    queueState() { return { ok: true, queue: detail.queue }; },
    ruleset() {
      reads += 1;
      return { ok: true, ruleset: { known: true, match: reads < 3 } };
    },
    enqueue(id, sha) { calls.enqueue.push({ id, sha }); return { ok: true, entry: { position: 1, state: 'QUEUED' } }; },
  };
  assert.equal(enqueue(client, 'act').wrote, 0);
  assert.equal(reads, 3);
  assert.deepEqual(calls.enqueue, []);
});

function flowClient(action) {
  const pr = prRecord(action === 'undraft' ? { isDraft: true } : {});
  const detail = detailFor(pr);
  let enabled = true;
  let rules = 0;
  const calls = { ready: [], enqueue: [] };
  const client = {
    calls,
    readSwitch() { return { ok: true, enabled }; },
    listOpen() { return { ok: true, prs: [pr], truncated: false }; },
    comments() { return { ok: true, comments: detail.comments }; },
    files() { return { ok: true, files: detail.files }; },
    checks() { return { ok: true, checks: detail.checks }; },
    evidence() { return { ok: true, evidence: detail.evidence }; },
    queueState() { return { ok: true, queue: detail.queue }; },
    ruleset() {
      rules += 1;
      if (rules === 3) enabled = false;
      return { ok: true, ruleset: { known: true, match: true } };
    },
    ready(number) { calls.ready.push(number); return { ok: true }; },
    enqueue(id, sha) {
      calls.enqueue.push({ id, sha });
      return { ok: true, entry: { position: 1, state: 'QUEUED' } };
    },
  };
  return { client, calls };
}

test('a switch that flips during the ruleset re-read blocks undraft and enqueue', () => {
  const undrafted = flowClient('undraft');
  assert.equal(undraft(undrafted.client, 'act').wrote, 0);
  assert.deepEqual(undrafted.calls.ready, []);
  const queued = flowClient('enqueue');
  assert.equal(enqueue(queued.client, 'act').wrote, 0);
  assert.deepEqual(queued.calls.enqueue, []);
});

test('a switch that flips during the ruleset re-read blocks queue and head check posts', () => {
  const head = HEAD;
  const parent = 'd'.repeat(40);
  const entry = {
    ref: `refs/heads/gh-readonly-queue/main/pr-7-${head}`,
    base: 'main',
    pr: 7,
    sha: 'c'.repeat(40),
  };
  const writes = [];
  let enabled = true;
  const queueIo = {
    readSwitch() { return { ok: true, enabled }; },
    ruleset() {
      enabled = false;
      return { ok: true, ruleset: { known: true, match: true } };
    },
    listEntries: () => ({ ok: true, entries: [entry] }),
    pull: () => ({ prReadable: true, state: 'open', draft: false, base: 'main', head }),
    headGate: () => ({
      headRunReadable: true,
      headRun: { id: 4, status: 'completed', conclusion: 'success', appId: GATE_APP_ID, summary: `Head: ${head}\n` },
    }),
    ourRun(sha) {
      if (sha === entry.sha) return { headRunReadable: true, headRun: null };
      return this.headGate();
    },
    baseTip: () => parent,
    prepare: () => true,
    parents: () => [parent],
    tree: () => ({ ok: true, equal: true }),
    refSha: () => entry.sha,
    collision: () => ({ listReadable: true, collision: false }),
    writeRun() { writes.push('queue'); return { ok: true }; },
  };
  const queued = runPublish(queueIo, { mode: 'act', gateAppId: String(GATE_APP_ID), gateToken: 'gate' });
  assert.equal(queued.code, 0);
  assert.equal(queued.posted, 0);
  assert.deepEqual(writes, []);

  enabled = true;
  const headIo = {
    readSwitch() { return { ok: true, enabled }; },
    ruleset() {
      enabled = false;
      return { ok: true, ruleset: { known: true, match: true } };
    },
    listEntries: () => ({ ok: true, entries: [] }),
    pull: () => ({ prReadable: true, state: 'open', draft: false, head }),
    ourRun: () => ({ headRunReadable: true, headRun: null }),
    writeRun() { writes.push('head'); return { ok: true }; },
  };
  const posted = runPublish(headIo, {
    mode: 'act',
    gateAppId: String(GATE_APP_ID),
    gateToken: 'gate',
    headDecision: { pr: 7, headSha: head },
  });
  assert.equal(posted.code, 0);
  assert.equal(posted.posted, 0);
  assert.deepEqual(writes, []);
});

test('a check post re-reads the ruleset and skips a weaker policy', () => {
  const head = HEAD;
  const parent = 'd'.repeat(40);
  const entry = {
    ref: `refs/heads/gh-readonly-queue/main/pr-7-${head}`,
    base: 'main',
    pr: 7,
    sha: 'c'.repeat(40),
  };
  const writes = [];
  const io = {
    readSwitch: () => ({ ok: true, enabled: true }),
    ruleset: () => ({ ok: true, ruleset: { known: true, match: false } }),
    listEntries: () => ({ ok: true, entries: [entry] }),
    pull: () => ({ prReadable: true, state: 'open', draft: false, base: 'main', head }),
    headGate: () => ({
      headRunReadable: true,
      headRun: { id: 4, status: 'completed', conclusion: 'success', appId: GATE_APP_ID, summary: `Head: ${head}\n` },
    }),
    ourRun(sha) {
      if (sha === entry.sha) return { headRunReadable: true, headRun: null };
      return this.headGate();
    },
    baseTip: () => parent,
    prepare: () => true,
    parents: () => [parent],
    tree: () => ({ ok: true, equal: true }),
    refSha: () => entry.sha,
    collision: () => ({ listReadable: true, collision: false }),
    writeRun() { writes.push('wrote'); return { ok: true }; },
  };
  const result = runPublish(io, { mode: 'act', gateAppId: String(GATE_APP_ID), gateToken: 'gate' });
  assert.equal(result.code, 0);
  assert.deepEqual(writes, []);
});

test('a child process can return more than one megabyte', () => {
  const { run, MAX_BUFFER } = require('./unattended/spawn');
  assert.equal(MAX_BUFFER, 64 * 1024 * 1024);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buffer-'));
  const bin = path.join(dir, 'big');
  fs.writeFileSync(bin, '#!/bin/sh\nhead -c 2000000 /dev/zero | tr \'\\0\' x\n');
  fs.chmodSync(bin, 0o755);
  const result = run(bin, []);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.length, 2000000);
});
