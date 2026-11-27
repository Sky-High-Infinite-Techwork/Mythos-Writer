'use strict';

function parseBuildOrderIssues(raw) {
  if (raw === null || raw === undefined) return { ok: true, issues: [] };
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_build_order', entry: String(raw) };
  const text = raw.trim();
  if (!text) return { ok: true, issues: [] };
  const issues = [];
  for (const part of text.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    if (!/^\d+$/.test(entry)) {
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
