'use strict';

const { GATE_APP_ID, sha40 } = require('./constants');

const QUEUE_REF = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-([1-9][0-9]*)-([0-9a-f]{40})$/;

const QUEUE_RULE = 'success only when the pull request head has this app\'s final-gate success and a clean merge of that head into the queue parent produces exactly the queue tree';

function parseQueueRef(row) {
  if (!row || typeof row.ref !== 'string') return null;
  const match = QUEUE_REF.exec(row.ref);
  const sha = row.object && row.object.sha;
  if (!match || !sha40(sha)) return null;
  return { ref: match[0], base: match[1], pr: Number(match[2]), sha };
}

function decideQueueEntry(entry, view, passed) {
  const head = view && view.head || '';
  if (!entry || entry.base !== 'main') {
    return { state: null, why: 'queue base is not main', head: head || null, parent: null };
  }
  if (!view || view.prReadable !== true) {
    return { state: 'in_progress', why: 'pull request unreadable', head: null, parent: null };
  }
  if (view.state !== 'open' || view.draft || view.base !== entry.base || !sha40(head)) {
    return { state: null, why: 'pull request is not open on main', head, parent: null };
  }
  if (view.headRunReadable !== true) {
    return { state: 'in_progress', why: 'head gate unreadable', head, parent: null };
  }
  const summary = view.headRun && view.headRun.summary;
  const first = typeof summary === 'string' ? summary.split('\n', 1)[0] : '';
  const headPass = view.headRun && view.headRun.status === 'completed' && view.headRun.conclusion === 'success'
    && view.headRun.appId === GATE_APP_ID && first === `Head: ${head}`;
  if (!headPass) {
    return { state: 'in_progress', why: 'the pull request head has no final-gate success from the gate app', head, parent: null };
  }
  if (!sha40(view.baseTip)) return { state: 'in_progress', why: 'base tip unreadable', head, parent: null };
  if (view.gitOk !== true || !Array.isArray(view.parents)) {
    return { state: 'in_progress', why: 'git read failed', head, parent: null };
  }
  const parents = view.parents;
  if ((parents.length !== 1 && parents.length !== 2) || (parents.length === 2 && parents[1] !== head) || !sha40(parents[0])) {
    return { state: 'failure', why: 'queue commit parent shape is not squash or base plus the reviewed head', head, parent: null };
  }
  const parent = parents[0];
  const parentKnown = parent === view.baseTip || (passed instanceof Set && passed.has(parent));
  if (!parentKnown) {
    return { state: 'in_progress', why: 'queue parent is not the base tip or a queue commit passed in this run', head, parent };
  }
  if (!view.tree || view.tree.ok !== true) return { state: 'in_progress', why: 'git read failed', head, parent };
  if (view.tree.equal !== true) {
    return { state: 'failure', why: 'merge tree does not match the queue commit', head, parent };
  }
  return {
    state: 'success',
    why: 'exact tree of the clean merge of the queue parent and the reviewed head',
    head,
    parent,
  };
}

function stillQueue(entry, head, parent, view, passed) {
  if (!view || view.refSha !== entry.sha) return false;
  if (view.state !== 'open' || view.draft || view.head !== head || view.base !== entry.base) return false;
  if (view.collision !== false) return false;
  if (view.listReadable !== true) return false;
  return parent === view.baseTip || (passed instanceof Set && passed.has(parent));
}

function queueSummary(entry, why) {
  return [
    `Queue commit: ${entry.sha}`,
    `PR: #${entry.pr}`,
    `Base: ${entry.base}`,
    `Result: ${why}`,
    `Rule: ${QUEUE_RULE}`,
  ].join('\n');
}

const TITLES = {
  success: 'Final gate: pass',
  failure: 'Final gate: block',
  in_progress: 'Final gate: waiting',
};

module.exports = {
  QUEUE_REF,
  parseQueueRef,
  decideQueueEntry,
  stillQueue,
  queueSummary,
  TITLES,
};
