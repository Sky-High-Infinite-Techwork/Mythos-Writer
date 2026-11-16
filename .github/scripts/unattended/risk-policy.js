'use strict';

const { ownerPath, protectedPath } = require('./constants');

const STANDARD_REVIEW_PROMPT = 'Review this pull request for the exact head. Pass only at low risk. A block is not a pass.';

const STRICT_REVIEW_PROMPT = [
  'Strict provider review for a high-risk path, for this exact head.',
  'Pass only when risk is low.',
  'Any block, any uncertainty, any change you cannot prove safe, or any risk other than low is not a pass.',
  'Do not defer the decision to a later human, Ivy, or Grok step.',
].join(' ');

function pathClass(filename) {
  const name = String(filename || '');
  if (!name) return 'ordinary';
  if (ownerPath(name)) return 'owner';
  if (protectedPath(name)) return 'high-risk';
  return 'ordinary';
}

function fileClasses(files) {
  const classes = new Set();
  for (const file of files || []) {
    classes.add(pathClass(file && file.filename));
    if (file && file.previous_filename) classes.add(pathClass(file.previous_filename));
  }
  return classes;
}

function reviewPlan(files) {
  const classes = fileClasses(files);
  if (classes.has('owner')) return { threshold: 'owner', prompt: null };
  if (classes.has('high-risk')) return { threshold: 'strict', prompt: STRICT_REVIEW_PROMPT };
  return { threshold: 'standard', prompt: STANDARD_REVIEW_PROMPT };
}

function worstUpdate(kinds) {
  if (kinds.includes('major')) return 'major';
  if (kinds.includes('unknown')) return 'unknown';
  if (kinds.includes('minor')) return 'minor';
  if (kinds.includes('patch')) return 'patch';
  return 'unknown';
}

// One "from x.y.z to x.y.z" bump. Pre-releases, ranges, and grouped titles are unknown.
function parseDependabotTitle(title) {
  if (typeof title !== 'string') return 'unknown';
  const match = title.trim().match(/^(?:[\w.-]+(?:\([^)]+\))?!?:\s*)?bumps?\s+.+\s+from\s+v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s+to\s+v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?:\s+in\s+\S+)?$/i);
  if (!match) return 'unknown';
  if (match[4] || match[8]) return 'unknown';
  const from = [Number(match[1]), Number(match[2]), Number(match[3])];
  const to = [Number(match[5]), Number(match[6]), Number(match[7])];
  if (to[0] !== from[0]) return to[0] > from[0] ? 'major' : 'unknown';
  if (to[1] !== from[1]) return to[1] < from[1] ? 'unknown' : (from[0] === 0 ? 'major' : 'minor');
  if (to[2] > from[2]) return 'patch';
  return 'unknown';
}

// The class comes from signed dependabot commit subjects only. Commit bodies and
// pull request text are ignored: release notes can carry a forged update-type line.
function resolveDependabotCommits(commits) {
  if (!Array.isArray(commits) || commits.length === 0) return 'unknown';
  const kinds = [];
  for (const commit of commits) {
    if (!commit || commit.authorLogin !== 'dependabot[bot]' || commit.committerLogin !== 'dependabot[bot]') {
      return 'unknown';
    }
    if (commit.verified !== true || commit.reason !== 'valid') return 'unknown';
    const subject = String(commit.message || '').split('\n')[0];
    kinds.push(parseDependabotTitle(subject));
  }
  return worstUpdate(kinds);
}

function headGateSummary(headSha, threshold) {
  const lines = [`Head: ${headSha}`, 'Risk: low'];
  if (threshold === 'strict') lines.push('Review: strict');
  lines.push('Rule: reducer pass for this run');
  return lines.join('\n');
}

module.exports = {
  STANDARD_REVIEW_PROMPT,
  STRICT_REVIEW_PROMPT,
  pathClass,
  fileClasses,
  reviewPlan,
  parseDependabotTitle,
  resolveDependabotCommits,
  headGateSummary,
};
