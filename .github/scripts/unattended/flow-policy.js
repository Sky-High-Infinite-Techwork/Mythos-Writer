'use strict';

const {
  HOLD_LABELS,
  EVIDENCE_WORKFLOWS,
  REQUIRED_CHECKS,
  GATE_APP_ID,
  REPO,
  sha40,
  protectedPath,
} = require('./constants');

const MERGE_OK = new Set(['CLEAN', 'BLOCKED', 'HAS_HOOKS', 'UNSTABLE', 'DRAFT']);

function hold(reason) {
  return { action: 'hold', reason };
}

// A comment is an assertion. It never authorizes undraft or enqueue.
function authorAssertion(comments, head) {
  if (!sha40(head)) return false;
  const header = `PROOF @ ${head}`;
  return (comments || []).some((comment) => String(comment && comment.body || '').split('\n')
    .some((line) => line.trim() === header));
}

function newerRun(left, right) {
  if (left.runId !== right.runId) return left.runId > right.runId ? left : right;
  return (left.runAttempt || 0) >= (right.runAttempt || 0) ? left : right;
}

function evidenceRunOk(run, head, prNumber, baseRef, baseSha, revision) {
  if (!run || run.path === undefined) return false;
  if (run.event !== 'pull_request' || run.status !== 'completed' || run.conclusion !== 'success') return false;
  if (run.repository !== REPO || run.headRepository !== REPO) return false;
  if (run.headSha !== head || run.pr !== prNumber) return false;
  if (run.prHeadSha !== head || run.prBaseRef !== baseRef) return false;
  if (!sha40(baseSha) || run.prBaseSha !== baseSha) return false;
  if (!Number.isInteger(run.runId) || run.runId < 1) return false;
  if (!Number.isInteger(run.runAttempt) || run.runAttempt < 1) return false;
  if (!sha40(run.workflowBlob) || run.workflowBlob !== revision) return false;
  return EVIDENCE_WORKFLOWS.includes(run.path);
}

// The latest run of each trusted workflow must be a completed pull_request success.
// An earlier success does not survive a later failure, cancellation, or incomplete run.
function evidenceOk(evidence, head, prNumber, baseRef, baseSha) {
  if (!sha40(head) || !Number.isInteger(prNumber) || !evidence || !evidence.mainRevision) return false;
  const runs = evidence.runs || [];
  return EVIDENCE_WORKFLOWS.every((workflowPath) => {
    const revision = evidence.mainRevision[workflowPath];
    const latest = runs.filter((run) => run && run.path === workflowPath).reduce((best, run) => {
      if (!best) return run;
      return newerRun(run, best);
    }, null);
    return evidenceRunOk(latest, head, prNumber, baseRef, baseSha, revision);
  });
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
  return (files || []).some((file) => protectedPath(file.filename || '') || protectedPath(file.previous_filename || ''));
}

function classify(facts) {
  if (facts.allowlistKnown !== true) return hold('author allow-list missing');
  if (facts.scopeKnown !== true) return hold('team/scope unknown');
  if (facts.fork) return hold('fork');
  if (facts.authorAllowed !== true) return hold('author not allow-listed');
  if (facts.author === 'dependabot[bot]') return hold('dependabot');
  if (!sha40(facts.head)) return hold('head sha');
  if (facts.base !== 'main') return hold('base is not main');
  const labels = (facts.labels || []).map((name) => String(name).toLowerCase());
  if (labels.some((name) => HOLD_LABELS.includes(name))) return hold('hold label');
  if (facts.labelsComplete === false) return hold('label list incomplete');
  if (facts.leaseKnown !== true) return hold('lease unknown');
  if (facts.leaseHeld === true || labels.some((name) => name === 'lease' || name.startsWith('lease:'))) {
    return hold('lease');
  }
  if (facts.rulesetKnown !== true) return hold('ruleset policy unknown');
  if (facts.rulesetMatch !== true) return hold('ruleset policy mismatch');
  if (facts.scopeKnown === false) return hold('repository scope unknown');
  if (facts.policyKnown === false) return hold('merge queue policy unknown');
  if (!facts.filesComplete) return hold('file list incomplete');
  if (facts.protectedPath) return hold('protected path');
  if (facts.mergeState === 'BEHIND' || facts.mergeState === 'DIRTY' || facts.mergeState === 'UNMERGEABLE') {
    return hold('rebase needed');
  }
  if (!MERGE_OK.has(facts.mergeState)) return hold('mergeability unknown');
  if (!facts.proof) return hold('missing independent evidence run');
  if (!facts.ciGreen) return hold('required checks are not green');
  if (facts.draft) return { action: 'undraft', reason: 'draft with an evidence run and required checks' };
  if (!facts.gate) return hold('tip gate missing');
  if (!facts.queueEnabled) return hold('base has no merge queue');
  if (!facts.nodeId) return hold('missing pull request id');
  if (facts.inQueue) return hold('already in the merge queue');
  return { action: 'enqueue', reason: 'exact tip is proven and the required checks are green' };
}

module.exports = {
  classify,
  authorAssertion,
  evidenceOk,
  latestRun,
  ciGreen,
  gateOk,
  filesLookProtected,
};
