'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO, GATE_APP_ID, CHECK_NAME, sha40 } = require('./constants');
const { gh, git, run } = require('./spawn');
const { readSwitch } = require('./switch');
const { acceptReducer, providerArgument, strictClaimOk } = require('./gate-result');
const { headGateSummary } = require('./risk-policy');
const { gateOk } = require('./flow-policy');
const { flattenPages, rulesetMatches } = require('./flow-client');
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

function fetchObjects(repoDir, shas, options) {
  const depth = options && options.depth ? options.depth : 2;
  const remote = (options && options.url) || `https://github.com/${REPO}.git`;
  const local = remote.startsWith('file:') || remote.startsWith('/');
  for (const sha of shas) {
    if (!sha40(sha)) return false;
    const args = [];
    if (local) args.push('-c', 'protocol.file.allow=always');
    args.push('fetch', '--no-tags', `--depth=${String(depth)}`, remote, sha);
    const result = git(repoDir, args);
    if (result.status !== 0) return false;
  }
  return true;
}

function historiesMeet(repoDir, parent, head, remote) {
  for (const depth of [2, 8, 32, 128, 512]) {
    if (!fetchObjects(repoDir, [parent, head], { depth, url: remote })) return false;
    const base = git(repoDir, ['merge-base', parent, head]);
    if (base.status === 0 && sha40(base.stdout.trim())) return true;
  }
  return false;
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
    ruleset() {
      const got = api(['api', `repos/${REPO}/rules/branches/main`], readToken);
      return { ok: true, ruleset: rulesetMatches(got.ok ? got.value : null) };
    },
    listEntries() {
      const result = gh(['api', '--paginate', '--slurp', `repos/${REPO}/git/matching-refs/heads/gh-readonly-queue/`], readToken);
      if (result.status !== 0) return { ok: false, entries: [] };
      const rows = flattenPages(result.stdout);
      if (!rows) return { ok: false, entries: [] };
      return { ok: true, entries: rows.map(parseQueueRef).filter(Boolean) };
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
    prepare(shas, depth) {
      const dir = repoDir();
      if (!dir) return false;
      return fetchObjects(dir, shas, { depth: depth || 2 });
    },
    historiesMeet(parent, head) {
      const dir = repoDir();
      if (!dir) return false;
      return historiesMeet(dir, parent, head, `https://github.com/${REPO}.git`);
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
      const result = gh(['api', '--paginate', '--slurp', `repos/${REPO}/pulls?state=open&per_page=100`], readToken);
      if (result.status !== 0) return { listReadable: false, collision: true };
      const rows = flattenPages(result.stdout);
      if (!rows) return { listReadable: false, collision: true };
      const hit = rows.some((row) => row && row.number !== pr && row.head && row.head.sha === queueSha);
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
  view.gitOk = io.prepare([entry.sha], 2);
  view.parents = view.gitOk ? io.parents(entry.sha) : null;
  if (!Array.isArray(view.parents) || view.parents.length === 0) {
    view.gitOk = false;
    view.parents = null;
    return view;
  }
  const objects = [pull.head, view.baseTip, ...view.parents].filter((sha) => sha40(sha));
  view.gitOk = io.prepare(objects, 2) && view.gitOk;
  if (view.gitOk && typeof io.historiesMeet === 'function') {
    view.gitOk = io.historiesMeet(view.parents[0], pull.head) && view.gitOk;
  }
  if (view.gitOk && sha40(view.parents[0])) view.tree = io.tree(view.parents[0], pull.head, entry.sha);
  return view;
}

function rulesAllow(io) {
  if (typeof io.ruleset !== 'function') return false;
  try {
    const got = io.ruleset();
    return Boolean(got && got.ok !== false && got.ruleset && got.ruleset.known === true && got.ruleset.match === true);
  } catch {
    return false;
  }
}

function chainFor(chain, baseTip) {
  if (!sha40(baseTip) || chain.baseTip !== baseTip) {
    chain.baseTip = sha40(baseTip) ? baseTip : null;
    chain.parents = new Set();
  }
  return chain;
}

function runPublish(io, opts) {
  const sw = io.readSwitch();
  if (!sw.ok) return { code: 1, posted: 0 };
  if (!sw.enabled) return { code: 0, posted: 0 };
  if (opts.gateAppId !== String(GATE_APP_ID)) return { code: 1, posted: 0 };
  const listed = io.listEntries();
  if (!listed.ok) return { code: 1, posted: 0 };
  const only = String(opts.pr || process.env.PR_NUMBER || '');
  if (only && !/^[1-9][0-9]{0,9}$/.test(only)) return { code: 1, posted: 0 };
  const selected = listed.entries.filter((entry) => !only || String(entry.pr) === only);
  const head = opts.headDecision;
  const block = opts.blockDecision && opts.blockDecision.block === true && sha40(opts.blockDecision.headSha)
    ? opts.blockDecision
    : null;
  const headRecord = (head && sha40(head.headSha) ? head : null) || block;
  const headDue = Boolean(headRecord) && (!only || String(headRecord.pr) === only);
  if (opts.mode !== 'act') {
    for (const entry of selected) {
      const view = viewFor(io, entry);
      const verdict = decideQueueEntry(entry, view, chainFor({ baseTip: null, parents: new Set() }, view.baseTip));
      process.stdout.write(`queue #${entry.pr} ${verdict.state || 'skip'}: ${verdict.why}\n`);
    }
    if (headDue) process.stdout.write(`head #${headRecord.pr} ${block ? 'block ' : ''}dry-run\n`);
    return { code: 0, posted: 0 };
  }
  if (!opts.gateToken && (selected.length > 0 || headDue)) return { code: 2, posted: 0 };
  const chain = { baseTip: null, parents: new Set() };
  const done = new Set();
  const sent = new Set();
  let posted = 0;
  const entries = [...selected].sort((a, b) => a.pr - b.pr || a.ref.localeCompare(b.ref));
  for (let round = 0; round < entries.length; round += 1) {
    let progress = false;
    for (const entry of entries) {
      if (done.has(entry.sha)) continue;
      const view = viewFor(io, entry);
      const active = chainFor(chain, view.baseTip);
      const verdict = decideQueueEntry(entry, view, active);
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
      let liveChain = active;
      if (verdict.state === 'success') {
        const pull = io.pull(entry.pr);
        const refSha = io.refSha(entry.ref);
        const collision = io.collision(entry.sha, entry.pr);
        const baseTip = io.baseTip(entry.base);
        const live = {
          ...pull,
          refSha,
          collision: collision.collision,
          listReadable: collision.listReadable,
          baseTip,
        };
        liveChain = chainFor(chain, baseTip);
        const gateNow = io.headGate(verdict.head);
        const gateRun = gateNow.headRun
          ? { ...gateNow.headRun, headSha: verdict.head }
          : null;
        if (!stillQueue(entry, verdict.head, verdict.parent, live, liveChain)
          || !gateNow.headRunReadable || !gateOk(gateRun, verdict.head)) {
          process.stdout.write(`queue #${entry.pr} authorization changed; no success posted\n`);
          done.add(entry.sha);
          continue;
        }
      }
      const stamp = `${entry.sha}\n${status}\n${conclusion || ''}\n${summary}`;
      if (sent.has(stamp) || samePosted(existing, status, conclusion, summary)) {
        process.stdout.write(`queue #${entry.pr} ${verdict.state} unchanged\n`);
        if (verdict.state === 'success') {
          liveChain.parents.add(entry.sha);
          progress = true;
        }
      } else {
        if (!rulesAllow(io)) {
          process.stdout.write(`queue #${entry.pr} ruleset is not the main queue policy; no post\n`);
          done.add(entry.sha);
          continue;
        }
        const again = io.readSwitch();
        if (!again.ok || !again.enabled) return { code: again.ok ? 0 : 1, posted };
        const wrote = io.writeRun(existing, entry.sha, status, conclusion, summary);
        if (!wrote.ok) return { code: 1, posted };
        sent.add(stamp);
        posted += 1;
        process.stdout.write(`queue #${entry.pr} ${verdict.state}: ${verdict.why}\n`);
        if (verdict.state === 'success') {
          liveChain.parents.add(entry.sha);
          progress = true;
        }
      }
      if (verdict.state !== 'in_progress') done.add(entry.sha);
    }
    if (!progress) break;
  }
  if (headDue) {
    const record = block || head;
    const pull = io.pull(record.pr);
    if (!(pull.prReadable && pull.state === 'open' && !pull.draft && pull.head === record.headSha)) {
      process.stdout.write(`head #${record.pr} moved; no result posted\n`);
    } else {
      const current = io.ourRun(record.headSha);
      if (!current.headRunReadable) return { code: 1, posted };
      const prior = current.headRun;
      const settled = prior && prior.status === 'completed'
        && (prior.conclusion === 'success' || prior.conclusion === 'failure')
        && prior.appId === GATE_APP_ID;
      if (settled) {
        process.stdout.write(`head #${record.pr} already has a gate result; not replaced\n`);
      } else if (block) {
        const summary = `Head: ${record.headSha}\nResult: block\nRule: a model block on this head is final`;
        if (!samePosted(prior, 'completed', 'failure', summary)) {
          if (!rulesAllow(io)) {
            process.stdout.write(`head #${record.pr} ruleset is not the main queue policy; no block posted\n`);
          } else {
            const again = io.readSwitch();
            if (!again.ok) return { code: 1, posted };
            if (!again.enabled) return { code: 0, posted };
            const wrote = io.writeRun(prior, record.headSha, 'completed', 'failure', summary);
            if (!wrote.ok) return { code: 1, posted };
            posted += 1;
            process.stdout.write(`head #${record.pr} block\n`);
          }
        }
      } else if (!strictClaimOk(head) || head.threshold !== opts.threshold) {
        process.stdout.write(`head #${head.pr} threshold is not consistent; no success posted\n`);
      } else {
        const summary = headGateSummary(head.headSha, head.threshold);
        if (!samePosted(prior, 'completed', 'success', summary)) {
          if (!rulesAllow(io)) {
            process.stdout.write(`head #${head.pr} ruleset is not the main queue policy; no success posted\n`);
          } else {
            const again = io.readSwitch();
            if (!again.ok) return { code: 1, posted };
            if (!again.enabled) return { code: 0, posted };
            const wrote = io.writeRun(prior, head.headSha, 'completed', 'success', summary);
            if (!wrote.ok) return { code: 1, posted };
            posted += 1;
            process.stdout.write(`head #${head.pr} success\n`);
          }
        }
      }
    }
  }
  return { code: 0, posted };
}

function main() {
  const mode = process.env.MODE;
  const gateAppId = process.env.GATE_APP_ID || '';
  let raw = null;
  let headDecision = null;
  if (process.env.REDUCER_RESULT) {
    try {
      raw = JSON.parse(process.env.REDUCER_RESULT);
      headDecision = acceptReducer(raw, {
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        threshold: process.env.THRESHOLD,
      }, providerArgument());
    } catch {
      raw = null;
      headDecision = null;
    }
  }
  const io = createIo(process.env.READ_TOKEN, process.env.GATE_TOKEN);
  try {
    const result = runPublish(io, {
      mode,
      gateAppId,
      gateToken: process.env.GATE_TOKEN,
      headDecision,
      blockDecision: headDecision ? null : raw,
      threshold: process.env.THRESHOLD,
    });
    return result.code;
  } finally {
    io.close();
  }
}

if (require.main === module) process.exit(main());

module.exports = { parentsOf, treesMatch, fetchObjects, historiesMeet, runPublish, createIo };
