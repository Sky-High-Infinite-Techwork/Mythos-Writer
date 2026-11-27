'use strict';

// MYTHOS_BUILD_ORDER_ISSUES is an exact comma-separated list of positive decimal
// issue numbers with no spaces, for example "11,12". A list written as "11, 12"
// (space after the comma), an empty item, a leading zero or any other numeric
// form holds the whole list as invalid_build_order. An unset variable
// (null or undefined here) is an empty list and idle; a variable set to the
// empty string holds as invalid_build_order.
function parseBuildOrderIssues(raw) {
  if (raw === null || raw === undefined) return { ok: true, issues: [] };
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_build_order', entry: String(raw) };
  // No trimming: surrounding space, NBSP, leading zeros, empty slots and
  // scientific/hex forms must hold the whole list, not shrink or coerce.
  const issues = [];
  for (const entry of raw.split(',')) {
    if (!/^[1-9]\d*$/.test(entry)) {
      return { ok: false, reason: 'invalid_build_order', entry };
    }
    const n = Number(entry);
    if (!Number.isSafeInteger(n) || n < 1) {
      return { ok: false, reason: 'invalid_build_order', entry };
    }
    issues.push(n);
  }
  return { ok: true, issues };
}

function issueBlockedByClaim(issueNumber, activeClaims) {
  return (activeClaims || []).some((claim) => claim.issue === issueNumber && !claim.expired);
}

module.exports = {
  parseBuildOrderIssues,
  issueBlockedByClaim,
};
