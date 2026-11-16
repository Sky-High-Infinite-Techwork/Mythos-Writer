'use strict';

const fs = require('node:fs');
const { REPO, WRITE_APP_ID, WRITE_INSTALLATION_ID } = require('./constants');
const { classify, hasProof, ciGreen, gateOk, filesLookProtected } = require('./flow-policy');
const { createClient } = require('./flow-client');

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${name}=${value}\n`);
}

function factsFrom(pr, detail) {
  const author = pr.author && pr.author.login;
  const labels = (pr.labels || []).map((label) => label.name || label);
  const files = detail.files || [];
  const changed = Number(pr.changedFiles);
  const filesComplete = Number.isInteger(changed) && changed >= 0 && files.length === changed && changed < 3000;
  return {
    number: pr.number,
    nodeId: detail.queue && detail.queue.nodeId,
    head: pr.headRefOid,
    base: pr.baseRefName,
    draft: pr.isDraft === true,
    fork: pr.isCrossRepository === true,
    author,
    labels,
    mergeState: String(pr.mergeStateStatus || '').toUpperCase(),
    filesComplete,
    protectedPath: filesLookProtected(files),
    proof: hasProof(detail.comments, pr.headRefOid, author),
    ciGreen: ciGreen(detail.checks || {}, pr.headRefOid),
    gate: gateOk(detail.checks && detail.checks.gate, pr.headRefOid),
    queueEnabled: detail.queue ? detail.queue.queueEnabled === true : false,
    inQueue: detail.queue ? detail.queue.inQueue === true : false,
  };
}

function loadDetail(client, pr) {
  const comments = client.comments(pr.number);
  if (!comments.ok) return comments;
  const files = client.files(pr.number);
  if (!files.ok) return files;
  const checks = client.checks(pr.headRefOid);
  if (!checks.ok) return checks;
  const queue = client.queueState(pr.number);
  if (!queue.ok) return queue;
  return {
    ok: true,
    detail: { comments: comments.comments, files: files.files, checks: checks.checks, queue: queue.queue },
  };
}

function freshFacts(client, pr) {
  const queue = client.queueState(pr.number);
  if (!queue.ok) return queue;
  const live = queue.queue;
  if (live.head !== pr.headRefOid || live.base !== pr.baseRefName || live.state !== 'OPEN') {
    return { ok: true, moved: true };
  }
  const loaded = loadDetail(client, {
    ...pr,
    isDraft: live.draft,
    headRefOid: live.head,
    baseRefName: live.base,
    mergeStateStatus: live.mergeState,
  });
  if (!loaded.ok) return loaded;
  const next = factsFrom({
    ...pr,
    isDraft: live.draft,
    headRefOid: live.head,
    baseRefName: live.base,
    mergeStateStatus: live.mergeState,
  }, loaded.detail);
  next.nodeId = live.nodeId;
  next.inQueue = live.inQueue;
  next.queueEnabled = live.queueEnabled;
  next.draft = live.draft;
  return { ok: true, decision: classify(next), live };
}

function select(client) {
  const listed = client.listOpen();
  if (!listed.ok) return listed;
  if (listed.truncated) return { ok: false, error: 'open pull request list hit the 200 cap' };
  const only = process.env.PR_NUMBER;
  const rows = [];
  for (const pr of listed.prs) {
    if (only && String(pr.number) !== only) continue;
    if (!Number.isInteger(pr.number) || pr.number < 1) continue;
    const loaded = loadDetail(client, pr);
    if (!loaded.ok) return loaded;
    const facts = factsFrom(pr, loaded.detail);
    rows.push({ pr, decision: classify(facts), facts });
  }
  return { ok: true, rows };
}

function guard(client, mode) {
  const sw = client.readSwitch();
  if (!sw.ok) return { ok: false, enabled: false, error: 'control read failed' };
  if (!sw.enabled) return { ok: true, enabled: false, rows: [] };
  if (mode !== 'act' && mode !== 'dry-run') return { ok: false, error: 'mode' };
  return { ok: true, enabled: true };
}

function plan(client, mode) {
  const gated = guard(client, mode);
  if (!gated.ok || !gated.enabled) return gated;
  const selected = select(client);
  if (!selected.ok) return selected;
  const undraft = selected.rows.filter((row) => row.decision.action === 'undraft');
  const enqueue = selected.rows.filter((row) => row.decision.action === 'enqueue');
  for (const row of selected.rows) {
    process.stdout.write(`#${row.pr.number} ${row.decision.action}: ${row.decision.reason}\n`);
  }
  setOutput('undraft', undraft.length ? 'true' : 'false');
  setOutput('enqueue', enqueue.length ? 'true' : 'false');
  return { ok: true, enabled: true, undraft: undraft.length, enqueue: enqueue.length, rows: selected.rows };
}

function actOn(client, mode, action, write) {
  const gated = guard(client, mode);
  if (!gated.ok) return { ...gated, wrote: 0 };
  if (!gated.enabled) return { ok: true, enabled: false, wrote: 0 };
  if (mode !== 'act') return { ok: true, enabled: true, wrote: 0 };
  const selected = select(client);
  if (!selected.ok) return { ...selected, wrote: 0 };
  let wrote = 0;
  for (const row of selected.rows) {
    if (row.decision.action !== action) continue;
    const again = client.readSwitch();
    if (!again.ok) return { ok: false, error: 'control read failed', wrote };
    if (!again.enabled) {
      process.stdout.write('UNATTENDED_ENABLED is not true; stopping before the next write\n');
      return { ok: true, enabled: false, wrote };
    }
    const fresh = freshFacts(client, row.pr);
    if (!fresh.ok) return { ...fresh, wrote };
    if (fresh.moved || !fresh.decision || fresh.decision.action !== action) {
      process.stdout.write(`#${row.pr.number} changed before the write; skipped\n`);
      continue;
    }
    const result = write(row.pr, fresh);
    if (!result.ok) return { ...result, wrote };
    wrote += 1;
    const recorded = result.entry ? ` ${result.entry.state} position ${result.entry.position}` : '';
    process.stdout.write(`#${row.pr.number} ${action}${recorded}\n`);
  }
  return { ok: true, enabled: true, wrote };
}

function undraft(client, mode) {
  return actOn(client, mode, 'undraft', (pr) => client.ready(pr.number));
}

function enqueue(client, mode) {
  return actOn(client, mode, 'enqueue', (pr, fresh) => {
    if (!fresh.live || fresh.live.head !== pr.headRefOid) return { ok: false, error: 'head moved' };
    return client.enqueue(fresh.live.nodeId, fresh.live.head);
  });
}

function exitCode(result) {
  return result && result.ok ? 0 : 1;
}

function main(argv) {
  const command = argv[2];
  const mode = process.env.MODE;
  const repo = process.env.REPO || REPO;
  if (repo !== REPO) {
    process.stderr.write('refuse: repository\n');
    return 1;
  }
  if (command !== 'plan' && command !== 'undraft' && command !== 'enqueue') {
    process.stderr.write('refuse: command\n');
    return 1;
  }
  if (mode === 'act' && (command === 'undraft' || command === 'enqueue')) {
    if (process.env.WRITE_APP_ID !== WRITE_APP_ID || process.env.WRITE_INSTALLATION_ID !== WRITE_INSTALLATION_ID) {
      process.stderr.write('refuse: write app identity\n');
      return 1;
    }
  }
  if ((command === 'undraft' || command === 'enqueue') && mode === 'act') {
    const token = command === 'undraft' ? process.env.READY_TOKEN : process.env.ENQUEUE_TOKEN;
    if (!token) {
      process.stderr.write(`act refused: ${command} token is missing\n`);
      return 1;
    }
  }
  const client = createClient({
    repo,
    readToken: process.env.READ_TOKEN,
    controlToken: process.env.CONTROL_TOKEN,
    readyToken: process.env.READY_TOKEN,
    enqueueToken: process.env.ENQUEUE_TOKEN,
  });
  if (command === 'plan') return exitCode(plan(client, mode));
  if (command === 'undraft') return exitCode(undraft(client, mode));
  return exitCode(enqueue(client, mode));
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { plan, undraft, enqueue, factsFrom, freshFacts };
