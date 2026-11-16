'use strict';

const { sha256Hex } = require('./constants');

const GRADE_SCHEMA = 'mythos-plan-grade/v1';
const GRADE_PASS = 'PASS';
const GRADE_REVISE = 'REVISE';
const PASS_MARKER_PREFIX = 'PLAN GRADE PASS @';

function parseGradeTransport(stdout) {
  if (!stdout) return { ok: false, reason: 'empty' };
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (!data || data.schema !== GRADE_SCHEMA) return { ok: false, reason: 'schema' };
  if (data.verdict !== GRADE_PASS && data.verdict !== GRADE_REVISE) return { ok: false, reason: 'verdict' };
  return { ok: true, verdict: data.verdict, findings: data.findings || [] };
}

function formatPlanGradePass({ planCommentId, planBodySha256 }) {
  return `${PASS_MARKER_PREFIX} comment=${planCommentId} sha=${planBodySha256}`;
}

function parsePlanGradePassMarker(body) {
  const line = String(body || '').split(/\r?\n/).find((row) => row.startsWith(PASS_MARKER_PREFIX));
  if (!line) return null;
  const commentMatch = line.match(/comment=(\d+)/);
  const shaMatch = line.match(/sha=([0-9a-f]{64})/);
  if (!commentMatch || !shaMatch) return null;
  return {
    planCommentId: parseInt(commentMatch[1], 10),
    planBodySha256: shaMatch[1],
  };
}

function findBoundPlanPass(comments, plan) {
  if (!plan) return { ok: false, reason: 'no_plan' };
  const passes = (comments || []).map((c) => ({
    marker: parsePlanGradePassMarker(c.body),
    author: c.author && c.author.login,
  })).filter((row) => row.marker);
  const match = passes.find(
    (row) => row.marker.planCommentId === Number(plan.databaseId || plan.commentId)
      && row.marker.planBodySha256 === plan.bodySha256,
  );
  if (!match) return { ok: false, reason: 'no_pass_grade' };
  return { ok: true, marker: match.marker };
}

function reduceGradeResults(claudeGrade, maxRounds, round) {
  if (!claudeGrade || !claudeGrade.ok) return { action: 'hold', reason: 'grade_unavailable' };
  if (claudeGrade.verdict === GRADE_PASS) {
    return { action: 'pass', reason: 'independent_grade_pass' };
  }
  if (round >= maxRounds) return { action: 'hold', reason: 'grade_round_cap' };
  return { action: 'revise', reason: 'grade_revise', findings: claudeGrade.findings };
}

function planRevisionMatches(plan, commentId, bodySha256) {
  if (!plan) return false;
  const id = Number(plan.databaseId || plan.commentId);
  return id === Number(commentId) && plan.bodySha256 === bodySha256;
}

module.exports = {
  GRADE_SCHEMA,
  GRADE_PASS,
  GRADE_REVISE,
  parseGradeTransport,
  formatPlanGradePass,
  parsePlanGradePassMarker,
  findBoundPlanPass,
  reduceGradeResults,
  planRevisionMatches,
  sha256Hex,
};