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
  headGateSummary,
};
