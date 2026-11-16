'use strict';

const {
  formatPlanGradePass,
  reduceGradeResults,
  parseGradeTransport,
} = require('./plan-gate');

function decidePublish({ gradeStdout, planCommentId, planBodySha256, maxRounds, round }) {
  const grade = parseGradeTransport(gradeStdout);
  const reduced = reduceGradeResults(grade, maxRounds, round);
  if (reduced.action !== 'pass') {
    return { ok: false, action: reduced.action, reason: reduced.reason };
  }
  return {
    ok: true,
    body: formatPlanGradePass({ planCommentId, planBodySha256 }),
  };
}

module.exports = { decidePublish };