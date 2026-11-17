'use strict';

const {
  refUpdateCreate,
  refUpdateDelete,
  refUpdateRenew,
  UPDATE_REFS_REF_EXISTS,
  OID_HEX,
  ZERO_OID,
} = require('./refs-graphql');

function rollbackRefs(refs, commitMessages, snapshot, msgSnapshot) {
  refs.clear();
  for (const [k, v] of snapshot.entries()) refs.set(k, v);
  commitMessages.clear();
  for (const [k, v] of msgSnapshot.entries()) commitMessages.set(k, v);
}

function validateRefUpdateRow(row) {
  if (!row || typeof row !== 'object') return { ok: false, message: 'invalid_row' };
  if ('oid' in row) return { ok: false, message: 'unexpected_oid_key' };
  if (!row.name) return { ok: false, message: 'missing_name' };
  const { afterOid, beforeOid } = row;
  if (afterOid === undefined) {
    return { ok: false, message: 'missing_after_oid' };
  }
  if (afterOid !== ZERO_OID && !OID_HEX.test(afterOid)) {
    return { ok: false, message: 'invalid_after_oid' };
  }
  if (beforeOid !== undefined && !OID_HEX.test(beforeOid)) {
    return { ok: false, message: 'invalid_before_oid' };
  }
  return { ok: true };
}

/**
 * In-memory GitHub ref client. Optional yieldMs between check and write for race tests.
 */
function createMockRefClient(options = {}) {
  const refs = new Map();
  /** @type {Map<string, string>} sha -> commit message */
  const commitMessages = new Map();
  const yields = options.yieldMs || 0;
  const pending = new Map();
  let lock = Promise.resolve();
  const updateLog = [];
  let leaseSeq = 0;

  async function maybeYield(ref) {
    if (!yields) return;
    const prior = pending.get(ref);
    if (prior) await prior;
    let release;
    const p = new Promise((resolve) => { release = resolve; });
    pending.set(ref, p);
    await new Promise((r) => setTimeout(r, yields));
    release();
    pending.delete(ref);
  }

  function messageForSha(sha) {
    return commitMessages.get(sha) || null;
  }

  function exists(ref) {
    return refs.has(ref);
  }

  async function updateRefsInner(refUpdates) {
    for (const row of refUpdates) {
      const check = validateRefUpdateRow(row);
      if (!check.ok) {
        updateLog.push({ rejected: true, row, message: check.message });
        return { ok: false, fatal: true, errors: [{ message: check.message }], error: check.message };
      }
    }
    updateLog.push(refUpdates);
    for (const row of refUpdates) {
      await maybeYield(row.name);
    }
    const snapshot = new Map(refs);
    const msgSnapshot = new Map(commitMessages);
    const zero = '0000000000000000000000000000000000000000';
    for (const row of refUpdates) {
      const { name, afterOid, beforeOid } = row;
      if (!beforeOid) {
        rollbackRefs(refs, commitMessages, snapshot, msgSnapshot);
        return { ok: false, fatal: true, errors: [{ message: 'missing_before_oid' }], error: 'missing_before_oid' };
      }
      const current = refs.get(name);
      if (beforeOid === zero) {
        if (current) {
          rollbackRefs(refs, commitMessages, snapshot, msgSnapshot);
          return {
            ok: false,
            status: 422,
            refExists: true,
            error: UPDATE_REFS_REF_EXISTS,
            errors: [{ message: UPDATE_REFS_REF_EXISTS }],
          };
        }
        refs.set(name, afterOid);
        continue;
      }
      if (afterOid === zero) {
        if (!current || current !== beforeOid) {
          rollbackRefs(refs, commitMessages, snapshot, msgSnapshot);
          return { ok: false, fatal: true, errors: [{ message: 'cas_mismatch' }], error: 'cas_mismatch' };
        }
        refs.delete(name);
        continue;
      }
      if (!current || current !== beforeOid) {
        rollbackRefs(refs, commitMessages, snapshot, msgSnapshot);
        return { ok: false, fatal: true, errors: [{ message: 'cas_mismatch' }], error: 'cas_mismatch' };
      }
      refs.set(name, afterOid);
    }
    return { ok: true, status: 201 };
  }

  async function updateRefs(refUpdates) {
    const run = () => updateRefsInner(refUpdates);
    const result = lock.then(run, run);
    lock = result.then(() => {}, () => {});
    return result;
  }

  return {
    refs,
    commitMessages,
    updateLog,
    exists,
    async createRefPair({ laneRef, claimRef: claimRefName, afterOid }) {
      if (!afterOid || !OID_HEX.test(afterOid)) {
        return { ok: false, fatal: true, errors: [{ message: 'invalid_after_oid' }], error: 'invalid_after_oid' };
      }
      return updateRefs([refUpdateCreate(laneRef, afterOid), refUpdateCreate(claimRefName, afterOid)]);
    },
    async createRef({ ref, afterOid, sha }) {
      const target = afterOid || sha;
      if (!target || !OID_HEX.test(target)) {
        return { ok: false, fatal: true, errors: [{ message: 'invalid_after_oid' }], error: 'invalid_after_oid' };
      }
      return updateRefs([refUpdateCreate(ref, target)]);
    },
    async deleteRef({ ref, beforeOid }) {
      if (!beforeOid) return { ok: false, fatal: true, errors: [{ message: 'missing_before_oid' }], error: 'missing_before_oid' };
      return updateRefs([refUpdateDelete(ref, beforeOid)]);
    },
    async getRef({ ref }) {
      if (yields) await new Promise((r) => setTimeout(r, yields));
      if (!exists(ref)) return { ok: false, status: 404, errors: [{ message: 'not_found' }] };
      const sha = refs.get(ref);
      return { ok: true, ref, sha, message: messageForSha(sha) };
    },
    async listRefs({ prefix }) {
      if (yields) await new Promise((r) => setTimeout(r, yields));
      const rows = [];
      for (const [ref, sha] of refs.entries()) {
        if (!ref.startsWith(prefix || '')) continue;
        rows.push({ ref, sha, message: messageForSha(sha) });
      }
      return { ok: true, refs: rows };
    },
    async issueComments() {
      return { ok: true, comments: [] };
    },
    async getIssue() {
      return { ok: true, issue: { state: 'open' } };
    },
    async issueEvents() {
      return { ok: true, events: [] };
    },
    async renewRef({ ref, newAfterOid, beforeOid }) {
      if (!newAfterOid || !OID_HEX.test(newAfterOid)) {
        return { ok: false, fatal: true, errors: [{ message: 'invalid_after_oid' }], error: 'invalid_after_oid' };
      }
      return updateRefs([refUpdateRenew(ref, newAfterOid, beforeOid)]);
    },
    async renewRefPair({ laneRef, claimRef, afterOid, beforeOid }) {
      return updateRefs([
        refUpdateRenew(laneRef, afterOid, beforeOid),
        refUpdateRenew(claimRef, afterOid, beforeOid),
      ]);
    },
    async createLeaseCommit(message) {
      leaseSeq += 1;
      const sha = `f${String(leaseSeq).padStart(39, '0')}`.slice(0, 40);
      commitMessages.set(sha, message);
      return { ok: true, sha, message };
    },
    setRefMessage(ref, message) {
      const sha = refs.get(ref);
      if (sha) commitMessages.set(sha, message);
    },
    setCommitMessage(sha, message) {
      commitMessages.set(sha, message);
    },
    updateRefs,
  };
}

function createYieldingRaceClient(yieldMs = 5) {
  return createMockRefClient({ yieldMs });
}

module.exports = { createMockRefClient, createYieldingRaceClient, validateRefUpdateRow };