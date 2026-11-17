'use strict';

const { parseLeaseMessage, isExpired } = require('./constants');

function activeClaimsFromRefs(refs, now = new Date()) {
  return (refs || []).map((row) => {
    const lease = parseLeaseMessage(row.message);
    if (!lease) return null;
    return {
      issue: lease.issue,
      slice: lease.slice,
      files: lease.files,
      expired: isExpired(lease, now),
      ref: row.ref,
    };
  }).filter(Boolean);
}

module.exports = { activeClaimsFromRefs };