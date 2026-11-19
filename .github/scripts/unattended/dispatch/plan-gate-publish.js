'use strict';

const OID_HEX = /^[0-9a-f]{64}$/;

const {
  formatPlanGradePass,
  reduceGradeResults,
  parseGradeTransport,
  planRevisionMatches,
  GRADE_ROLE,
} = require('./plan-gate');

function decidePublish({ gradeStdout, plan, planCommentId, planBodySha256, maxRounds, round }) {
  if (!Number.isInteger(maxRounds) || maxRounds < 0 || !Number.isInteger(round) || round < 0) {
    return { ok: false, reason: 'grade_round_cap_invalid' };
  }
  const sha = String(planBodySha256 || '');
  if (!OID_HEX.test(sha)) {
    return { ok: false, reason: 'invalid_plan_sha' };
  }
  if (planCommentId == null || !plan) {
    return { ok: false, reason: 'missing_plan_binding' };
  }
  if (!planRevisionMatches(plan, planCommentId, sha)) {
    return { ok: false, reason: 'plan_revision_mismatch' };
  }
  const grade = parseGradeTransport(gradeStdout);
  if (!grade.ok || grade.role !== GRADE_ROLE) {
    return { ok: false, reason: 'grade_unavailable' };
  }
  if (!planRevisionMatches(plan, grade.planCommentId, grade.planBodySha256)) {
    return { ok: false, reason: 'plan_revision_mismatch' };
  }
  if (Number(planCommentId) !== Number(plan.databaseId || plan.commentId) || plan.bodySha256 !== sha) {
    return { ok: false, reason: 'plan_revision_mismatch' };
  }
  const reduced = reduceGradeResults(grade, maxRounds, round);
  if (reduced.action !== 'pass') {
    return { ok: false, action: reduced.action, reason: reduced.reason };
  }
  return {
    ok: true,
    body: formatPlanGradePass({ planCommentId, planBodySha256: sha }),
  };
}

module.exports = { decidePublish };