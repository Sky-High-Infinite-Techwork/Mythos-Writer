'use strict';

const { refUpdateCreate, refUpdateDelete, refUpdateRenew, UPDATE_REFS_REF_EXISTS } = require('./refs-graphql');

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
        refs.clear();
        for (const [k, v] of snapshot.entries()) refs.set(k, v);
        commitMessages.clear();
        for (const [k, v] of msgSnapshot.entries()) commitMessages.set(k, v);
        return { ok: false, fatal: true, error: 'missing_before_oid' };
      }
      const current = refs.get(name);
      if (beforeOid === zero) {
        if (current) {
          refs.clear();
          for (const [k, v] of snapshot.entries()) refs.set(k, v);
          commitMessages.clear();
          for (const [k, v] of msgSnapshot.entries()) commitMessages.set(k, v);
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
          refs.clear();
          for (const [k, v] of snapshot.entries()) refs.set(k, v);
          commitMessages.clear();
          for (const [k, v] of msgSnapshot.entries()) commitMessages.set(k, v);
          return { ok: false, fatal: true, error: 'cas_mismatch' };
        }
        refs.delete(name);
        continue;
      }
      if (!current || current !== beforeOid) {
        refs.clear();
        for (const [k, v] of snapshot.entries()) refs.set(k, v);
        commitMessages.clear();
        for (const [k, v] of msgSnapshot.entries()) commitMessages.set(k, v);
        return { ok: false, fatal: true, error: 'cas_mismatch' };
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
    async createRefPair({ laneRef, claimRef: claimRefName, afterOid, oid }) {
      const target = afterOid || oid;
      return updateRefs([refUpdateCreate(laneRef, target), refUpdateCreate(claimRefName, target)]);
    },
    async createRef({ ref, sha, afterOid }) {
      const target = afterOid || sha;
      return updateRefs([refUpdateCreate(ref, target)]);
    },
    async deleteRef({ ref, beforeOid }) {
      if (!beforeOid) return { ok: false, fatal: true, error: 'missing_before_oid' };
      return updateRefs([refUpdateDelete(ref, beforeOid)]);
    },
    async getRef({ ref }) {
      if (yields) await new Promise((r) => setTimeout(r, yields));
      if (!exists(ref)) return { ok: false, status: 404 };
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
    async renewRef({ ref, newAfterOid, newOid, beforeOid }) {
      const afterOid = newAfterOid || newOid;
      return updateRefs([refUpdateRenew(ref, afterOid, beforeOid)]);
    },
    async renewRefPair({ laneRef, claimRef, afterOid, beforeOid }) {
      return updateRefs([
        refUpdateRenew(laneRef, afterOid, beforeOid),
        refUpdateRenew(claimRef, afterOid, beforeOid),
      ]);
    },
    async createLeaseCommit(message) {
      const sha = `f${String(updateLog.length).padStart(39, '0')}`.slice(0, 40);
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

module.exports = { createMockRefClient, createYieldingRaceClient };