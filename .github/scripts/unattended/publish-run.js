'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO, GATE_APP_ID, CHECK_NAME, sha40 } = require('./constants');
const { gh, git, run } = require('./spawn');
const { readSwitch } = require('./switch');
const { acceptReducer } = require('./gate-result');
const { parseQueueRef, decideQueueEntry, stillQueue, queueSummary, TITLES } = require('./queue-policy');

function parentsOf(repoDir, sha) {
  const result = git(repoDir, ['rev-list', '--parents', '-n', '1', sha]);
  if (result.status !== 0) return null;
  const parts = result.stdout.trim().split(/\s+/);
  if (parts[0] !== sha) return null;
  return parts.slice(1);
}

function treesMatch(repoDir, parent, head, queueSha) {
  const merged = git(repoDir, ['merge-tree', '--write-tree', parent, head]);
  if (merged.status === 1) return { ok: true, equal: false };
  if (merged.status !== 0) return { ok: false };
  const tree = merged.stdout.trim();
  if (!sha40(tree)) return { ok: false };
  const got = git(repoDir, ['rev-parse', `${queueSha}^{tree}`]);
  if (got.status !== 0) return { ok: false };
  return { ok: true, equal: got.stdout.trim() === tree };
}

function fetchObjects(repoDir, shas) {
  const url = `https://github.com/${REPO}.git`;
  for (const sha of shas) {
    if (!sha40(sha)) return false;
    const result = git(repoDir, ['fetch', '--no-tags', '--depth=1', url, sha]);
    if (result.status !== 0) return false;
  }
  return true;
}

function openBare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-queue-'));
  const init = run(process.env.GIT_BIN || 'git', ['init', '--bare', '--quiet', dir]);
  if (init.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return dir;
}

function ghJson(args, token, input) {
  const result = gh(args, token, input);
  if (result.status !== 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false };
  }
}

function createIo(readToken, gateToken) {
  let bare = null;
  function repoDir() {
    if (!bare) bare = openBare();
    return bare;
  }
  function api(args, token, input) {
    return ghJson(args, token, input);
  }
  return {
    close() {
      if (bare) fs.rmSync(bare, { recursive: true, force: true });
    },
    readSwitch: () => readSwitch(REPO, process.env.CONTROL_TOKEN),
    listEntries() {
      const got = api(['api', '--paginate', `repos/${REPO}/git/matching-refs/heads/gh-readonly-queue/`], readToken);
      if (!got.ok || !Array.isArray(got.value)) return { ok: false, entries: [] };
      return { ok: true, entries: got.value.map(parseQueueRef).filter(Boolean) };
    },
    pull(number) {
      const got = api(['api', `repos/${REPO}/pulls/${number}`], readToken);
      if (!got.ok || !got.value) return { prReadable: false };
      const pr = got.value;
      return {
        prReadable: true,
        state: String(pr.state || '').toLowerCase(),
        draft: pr.draft === true,
        base: pr.base && pr.base.ref,
        head: pr.head && pr.head.sha,
      };
    },
    headGate(head) {
      const pathName = `repos/${REPO}/commits/${head}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`;
      const got = api(['api', pathName], readToken);
      if (!got.ok || !got.value || !Array.isArray(got.value.check_runs)) return { headRunReadable: false };
      const mine = got.value.check_runs.filter((run) => run && run.name === CHECK_NAME && (run.app || {}).id === GATE_APP_ID);
      const run = mine.reduce((best, row) => (!best || row.id > best.id ? row : best), null);
      if (!run) return { headRunReadable: true, headRun: null };
      return {
        headRunReadable: true,
        headRun: {
          status: run.status,
          conclusion: run.conclusion,
          summary: run.output && run.output.summary,
          appId: run.app.id,
          id: run.id,
        },
      };
    },
    ourRun(sha) {
      return this.headGate(sha);
    },
    baseTip(base) {
      const got = api(['api', `repos/${REPO}/git/ref/heads/${encodeURIComponent(base)}`], readToken);
      const sha = got.ok && got.value && got.value.object && got.value.object.sha;
      return sha40(sha) ? sha : null;
    },
    prepare(shas) {
      const dir = repoDir();
      if (!dir) return false;
      return fetchObjects(dir, shas);
    },
    parents(sha) {
      const dir = repoDir();
      if (!dir) return null;
      return parentsOf(dir, sha);
    },
    tree(parent, head, queueSha) {
      const dir = repoDir();
      if (!dir) return { ok: false };
      return treesMatch(dir, parent, head, queueSha);
    },
    refSha(ref) {
      const rest = ref.startsWith('refs/') ? ref.slice(5) : ref;
      const got = api(['api', `repos/${REPO}/git/ref/${rest}`], readToken);
      const sha = got.ok && got.value && got.value.object && got.value.object.sha;
      return sha40(sha) ? sha : null;
    },
    collision(queueSha, pr) {
      const got = api(['api', '--paginate', `repos/${REPO}/pulls?state=open&per_page=100`], readToken);
      if (!got.ok || !Array.isArray(got.value)) return { listReadable: false, collision: true };
      const hit = got.value.some((row) => row && row.number !== pr && row.head && row.head.sha === queueSha);
      return { listReadable: true, collision: hit };
    },
    writeRun(existing, sha, status, conclusion, summary) {
      const body = { status, output: { title: TITLES[conclusion || 'in_progress'] || TITLES.in_progress, summary } };
      if (status === 'completed') {
        body.conclusion = conclusion;
        body.completed_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      }
      const title = conclusion ? TITLES[conclusion] : TITLES.in_progress;
      body.output.title = title;
      if (!gateToken) return { ok: false, needsToken: true };
      const args = existing
        ? ['api', '--method', 'PATCH', `repos/${REPO}/check-runs/${existing.id}`, '--input', '-']
        : ['api', '--method', 'POST', `repos/${REPO}/check-runs`, '--input', '-'];
      const payload = existing ? body : { ...body, name: CHECK_NAME, head_sha: sha };
      const got = api(args, gateToken, JSON.stringify(payload));
      return { ok: got.ok };
    },
  };
}

function samePosted(run, status, conclusion, summary) {
  if (!run) return false;
  return run.status === status && (run.conclusion || null) === (conclusion || null) && run.summary === summary;
}

function viewFor(io, entry) {
  const pull = io.pull(entry.pr);
  const view = { ...pull };
  if (!pull.prReadable || pull.state !== 'open' || pull.draft || pull.base !== entry.base || !sha40(pull.head)) return view;
  Object.assign(view, io.headGate(pull.head));
  view.baseTip = io.baseTip(entry.base);
  const gate = view.headRun;
  const first = gate && typeof gate.summary === 'string' ? gate.summary.split('\n', 1)[0] : '';
  const ready = view.headRunReadable && gate && gate.status === 'completed' && gate.conclusion === 'success'
    && gate.appId === GATE_APP_ID && first === `Head: ${pull.head}` && sha40(view.baseTip);
  if (!ready) {
    view.gitOk = false;
    return view;
  }
  view.gitOk = io.prepare([entry.sha, pull.head, view.baseTip]);
  view.parents = view.gitOk ? io.parents(entry.sha) : null;
  if (Array.isArray(view.parents) && view.parents[0] && view.parents[0] !== view.baseTip) {
    view.gitOk = io.prepare([view.parents[0]]) && view.gitOk;
  }
  if (Array.isArray(view.parents) && sha40(view.parents[0])) {
    view.tree = io.tree(view.parents[0], pull.head, entry.sha);
  }
  return view;
}

function runPublish(io, opts) {
  const sw = io.readSwitch();
  if (!sw.ok) return { code: 1, posted: 0 };
  if (!sw.enabled) return { code: 0, posted: 0 };
  if (opts.gateAppId !== String(GATE_APP_ID)) return { code: 1, posted: 0 };
  const listed = io.listEntries();
  if (!listed.ok) return { code: 1, posted: 0 };
  const head = opts.headDecision;
  const headDue = Boolean(head);
  if (opts.mode !== 'act') {
    for (const entry of listed.entries) {
      const verdict = decideQueueEntry(entry, viewFor(io, entry), new Set());
      process.stdout.write(`queue #${entry.pr} ${verdict.state || 'skip'}: ${verdict.why}\n`);
    }
    if (headDue) process.stdout.write(`head #${head.pr} dry-run\n`);
    return { code: 0, posted: 0 };
  }
  if (!opts.gateToken && (listed.entries.length > 0 || headDue)) return { code: 2, posted: 0 };
  const passed = new Set();
  const done = new Set();
  const sent = new Set();
  let posted = 0;
  const entries = [...listed.entries].sort((a, b) => a.pr - b.pr || a.ref.localeCompare(b.ref));
  for (let round = 0; round < entries.length; round += 1) {
    let progress = false;
    for (const entry of entries) {
      if (done.has(entry.sha)) continue;
      const verdict = decideQueueEntry(entry, viewFor(io, entry), passed);
      if (verdict.state === null) {
        process.stdout.write(`queue #${entry.pr} skip: ${verdict.why}\n`);
        done.add(entry.sha);
        continue;
      }
      const status = verdict.state === 'in_progress' ? 'in_progress' : 'completed';
      const conclusion = verdict.state === 'in_progress' ? null : verdict.state;
      const summary = queueSummary(entry, verdict.why);
      const current = io.ourRun(entry.sha);
      if (!current.headRunReadable) return { code: 1, posted };
      const existing = current.headRun;
      if (verdict.state === 'success') {
        const again = io.readSwitch();
        if (!again.ok || !again.enabled) return { code: again.ok ? 0 : 1, posted };
        const pull = io.pull(entry.pr);
        const refSha = io.refSha(entry.ref);
        const collision = io.collision(entry.sha, entry.pr);
        const live = {
          ...pull,
          refSha,
          collision: collision.collision,
          listReadable: collision.listReadable,
          baseTip: io.baseTip(entry.base),
        };
        if (!stillQueue(entry, verdict.head, verdict.parent, live, passed)) {
          process.stdout.write(`queue #${entry.pr} authorization changed; no success posted\n`);
          done.add(entry.sha);
          continue;
        }
      } else {
        const again = io.readSwitch();
        if (!again.ok || !again.enabled) return { code: again.ok ? 0 : 1, posted };
      }
      const stamp = `${entry.sha}\n${status}\n${conclusion || ''}\n${summary}`;
      if (sent.has(stamp) || samePosted(existing, status, conclusion, summary)) {
        process.stdout.write(`queue #${entry.pr} ${verdict.state} unchanged\n`);
        if (verdict.state === 'success') {
          passed.add(entry.sha);
          progress = true;
        }
      } else {
        const wrote = io.writeRun(existing, entry.sha, status, conclusion, summary);
        if (!wrote.ok) return { code: 1, posted };
        sent.add(stamp);
        posted += 1;
        process.stdout.write(`queue #${entry.pr} ${verdict.state}: ${verdict.why}\n`);
        if (verdict.state === 'success') {
          passed.add(entry.sha);
          progress = true;
        }
      }
      if (verdict.state !== 'in_progress') done.add(entry.sha);
    }
    if (!progress) break;
  }
  if (headDue) {
    const again = io.readSwitch();
    if (!again.ok) return { code: 1, posted };
    if (!again.enabled) return { code: 0, posted };
    const pull = io.pull(head.pr);
    if (pull.prReadable && pull.state === 'open' && !pull.draft && pull.head === head.headSha) {
      const current = io.ourRun(head.headSha);
      if (!current.headRunReadable) return { code: 1, posted };
      const summary = `Head: ${head.headSha}\nRisk: low\nRule: reducer pass for this run`;
      if (!samePosted(current.headRun, 'completed', 'success', summary)) {
        const wrote = io.writeRun(current.headRun, head.headSha, 'completed', 'success', summary);
        if (!wrote.ok) return { code: 1, posted };
        posted += 1;
      }
      process.stdout.write(`head #${head.pr} success\n`);
    } else {
      process.stdout.write(`head #${head.pr} moved; no success posted\n`);
    }
  }
  return { code: 0, posted };
}

function main() {
  const mode = process.env.MODE;
  const gateAppId = process.env.GATE_APP_ID || '';
  let headDecision = null;
  if (process.env.REDUCER_RESULT) {
    try {
      headDecision = acceptReducer(JSON.parse(process.env.REDUCER_RESULT), {
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      });
    } catch {
      headDecision = null;
    }
  }
  const io = createIo(process.env.READ_TOKEN, process.env.GATE_TOKEN);
  try {
    const result = runPublish(io, { mode, gateAppId, gateToken: process.env.GATE_TOKEN, headDecision });
    return result.code;
  } finally {
    io.close();
  }
}

if (require.main === module) process.exit(main());

module.exports = { parentsOf, treesMatch, fetchObjects, runPublish, createIo };
