'use strict';

const {
  HOLD_LABELS,
  PROOF_BUILDER,
  REQUIRED_CHECKS,
  GATE_APP_ID,
  sha40,
  protectedPath,
} = require('./constants');

const MERGE_OK = new Set(['CLEAN', 'BLOCKED', 'HAS_HOOKS', 'UNSTABLE', 'DRAFT']);

function hold(reason) {
  return { action: 'hold', reason };
}

function hasProof(comments, head, author) {
  if (!sha40(head)) return false;
  const allowed = new Set([author, PROOF_BUILDER].filter((login) => typeof login === 'string' && login));
  const header = `PROOF @ ${head}`;
  for (const comment of comments || []) {
    if (!allowed.has(comment.login)) continue;
    const lines = String(comment.body || '').split('\n');
    for (const line of lines) {
      if (line.trim() === header) return true;
    }
  }
  return false;
}

function latestRun(runs) {
  const list = (runs || []).filter((run) => run && typeof run.id === 'number');
  if (!list.length) return null;
  return list.reduce((best, run) => (run.id > best.id ? run : best));
}

function ciGreen(byName, head) {
  for (const name of REQUIRED_CHECKS) {
    const run = byName[name];
    if (!run || run.conclusion !== 'success' || run.headSha !== head) return false;
  }
  return true;
}

function gateOk(run, head) {
  if (!run || run.conclusion !== 'success' || run.headSha !== head) return false;
  if (run.appId !== GATE_APP_ID) return false;
  const first = String(run.summary || '').split('\n')[0];
  return first === `Head: ${head}`;
}

function filesLookProtected(files) {
  return (files || []).some((file) => protectedPath(file.filename || ''));
}

function classify(facts) {
  if (facts.fork) return hold('fork');
  if (facts.author === 'dependabot[bot]') return hold('dependabot');
  if (!sha40(facts.head)) return hold('head sha');
  if (facts.base !== 'main') return hold('base is not main');
  const labels = (facts.labels || []).map((name) => String(name).toLowerCase());
  if (labels.some((name) => HOLD_LABELS.includes(name))) return hold('hold label');
  if (!facts.filesComplete) return hold('file list incomplete');
  if (facts.protectedPath) return hold('protected path');
  if (facts.mergeState === 'BEHIND' || facts.mergeState === 'DIRTY' || facts.mergeState === 'UNMERGEABLE') {
    return hold('rebase needed');
  }
  if (!MERGE_OK.has(facts.mergeState)) return hold('mergeability unknown');
  if (!facts.proof) return hold('missing independent proof');
  if (!facts.ciGreen) return hold('required checks are not green');
  if (facts.draft) return { action: 'undraft', reason: 'draft with independent proof and required checks' };
  if (!facts.gate) return hold('tip gate missing');
  if (!facts.queueEnabled) return hold('base has no merge queue');
  if (!facts.nodeId) return hold('missing pull request id');
  if (facts.inQueue) return hold('already in the merge queue');
  return { action: 'enqueue', reason: 'exact tip is proven and the required checks are green' };
}

module.exports = {
  classify,
  hasProof,
  latestRun,
  ciGreen,
  gateOk,
  filesLookProtected,
};
