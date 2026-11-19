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

module.exports = {
  parseBuildOrderIssues,
  issueBlockedByClaim,
};