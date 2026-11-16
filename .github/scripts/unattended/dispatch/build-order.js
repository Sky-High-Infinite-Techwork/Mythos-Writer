'use strict';

function parseBuildOrderIssues(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(',')
    .map((part) => parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function issueBlockedByClaim(issueNumber, activeClaims) {
  return (activeClaims || []).some((claim) => claim.issue === issueNumber && !claim.expired);
}

function pickNextBuildOrderIssue(orderedIssues, activeClaims, issueMeta) {
  for (const number of orderedIssues) {
    if (issueBlockedByClaim(number, activeClaims)) continue;
    const meta = issueMeta && issueMeta[number];
    if (meta && meta.state && meta.state !== 'OPEN') continue;
    return { ok: true, issue: number, meta: meta || null };
  }
  return { ok: false, reason: 'no_eligible_issue' };
}

module.exports = {
  parseBuildOrderIssues,
  issueBlockedByClaim,
  pickNextBuildOrderIssue,
};