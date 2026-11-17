'use strict';

const { sha256Hex } = require('./constants');
const { canonicalAuthorLogin } = require('./official-plan');

const GRADE_SCHEMA = 'mythos-plan-grade/v1';
const GRADE_PASS = 'PASS';
const GRADE_REVISE = 'REVISE';
const GRADE_ROLE = 'grade';
const PASS_MARKER_PREFIX = 'PLAN GRADE PASS @';
const PASS_MARKER_RE = /^PLAN GRADE PASS @ comment=(\d+) sha=([0-9a-f]{64})$/;

function parseGradePublisherAllowlist(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const entries = text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0) return null;
  return new Set(entries);
}

function gradePublisherAllowlist() {
  return parseGradePublisherAllowlist(process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST);
}

function isTrustedGradePublisher(author) {
  const allowlist = gradePublisherAllowlist();
  if (!allowlist) return false;
  const login = typeof author === 'string'
    ? author.trim().toLowerCase()
    : canonicalAuthorLogin(author);
  return allowlist.has(login);
}

function parseGradeTransport(stdout) {
  if (!stdout) return { ok: false, reason: 'empty' };
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (!data || data.schema !== GRADE_SCHEMA) return { ok: false, reason: 'schema' };
  if (data.status !== 'ok') return { ok: false, reason: 'status' };
  if (data.role !== GRADE_ROLE) return { ok: false, reason: 'role' };
  if (!Array.isArray(data.findings)) return { ok: false, reason: 'findings' };
  if (data.verdict !== GRADE_PASS && data.verdict !== GRADE_REVISE) return { ok: false, reason: 'verdict' };
  return { ok: true, role: data.role, verdict: data.verdict, findings: data.findings };
}

function formatPlanGradePass({ planCommentId, planBodySha256 }) {
  return `${PASS_MARKER_PREFIX} comment=${planCommentId} sha=${planBodySha256}`;
}

function parsePlanGradePassMarker(body) {
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.match(PASS_MARKER_RE);
    if (match) {
      return {
        planCommentId: parseInt(match[1], 10),
        planBodySha256: match[2],
      };
    }
  }
  return null;
}

function findBoundPlanPass(comments, plan) {
  if (!plan) return { ok: false, reason: 'no_plan' };
  const allowlist = gradePublisherAllowlist();
  if (!allowlist) return { ok: false, reason: 'grade_publisher_unconfigured' };
  const passes = (comments || [])
    .map((c) => ({
      marker: parsePlanGradePassMarker(c.body),
      author: c.author,
    }))
    .filter((row) => row.marker && isTrustedGradePublisher(row.author));
  const planId = Number(plan.databaseId || plan.commentId);
  const match = passes.find(
    (row) => row.marker.planCommentId === planId
      && row.marker.planBodySha256 === plan.bodySha256,
  );
  if (!match) return { ok: false, reason: 'no_pass_grade' };
  return { ok: true, marker: match.marker };
}

function reduceGradeResults(claudeGrade, maxRounds, round) {
  if (!Number.isInteger(maxRounds) || maxRounds < 0 || !Number.isInteger(round) || round < 0) {
    return { action: 'hold', reason: 'grade_round_cap_invalid' };
  }
  if (!claudeGrade || !claudeGrade.ok) return { action: 'hold', reason: 'grade_unavailable' };
  if (claudeGrade.verdict !== GRADE_PASS && claudeGrade.verdict !== GRADE_REVISE) {
    return { action: 'hold', reason: 'grade_unavailable' };
  }
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
  GRADE_ROLE,
  PASS_MARKER_PREFIX,
  parseGradePublisherAllowlist,
  gradePublisherAllowlist,
  isTrustedGradePublisher,
  parseGradeTransport,
  formatPlanGradePass,
  parsePlanGradePassMarker,
  findBoundPlanPass,
  reduceGradeResults,
  planRevisionMatches,
  sha256Hex,
};