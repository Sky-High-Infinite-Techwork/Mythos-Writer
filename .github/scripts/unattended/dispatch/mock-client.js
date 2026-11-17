'use strict';

const { refUpdateCreate, refUpdateDelete } = require('./refs-graphql');

/**
 * In-memory GitHub ref client. Optional yieldBetweenCheckAndWrite for race tests.
 */
function createMockRefClient(options = {}) {
  const refs = new Map();
  const commitMessages = new Map();
  const yields = options.yieldMs || 0;
  const pending = new Map();
  let lock = Promise.resolve();

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

  function exists(ref) {
    return refs.has(ref);
  }

  async function updateRefsInner(refUpdates) {
    for (const row of refUpdates) {
      await maybeYield(row.name);
    }
    const snapshot = new Map(refs);
    const msgSnapshot = new Map(commitMessages);
    const zero = '0000000000000000000000000000000000000000';
    for (const row of refUpdates) {
      const { name, oid, beforeOid } = row;
      const current = refs.get(name);
      if (beforeOid === zero) {
        if (current) {
          refs.clear();
          for (const [k, v] of snapshot.entries()) refs.set(k, v);
          commitMessages.clear();
          for (const [k, v] of msgSnapshot.entries()) commitMessages.set(k, v);
          return { ok: false, status: 422, refExists: true, error: 'Reference already exists' };
        }
        refs.set(name, oid);
        continue;
      }
      if (oid === zero) {
        if (!current || current !== beforeOid) {
          refs.clear();
          for (const [k, v] of snapshot.entries()) refs.set(k, v);
          commitMessages.clear();
          for (const [k, v] of msgSnapshot.entries()) commitMessages.set(k, v);
          return { ok: false, fatal: true, error: 'cas_mismatch' };
        }
        refs.delete(name);
        commitMessages.delete(name);
        continue;
      }
      if (!current || current !== beforeOid) {
        refs.clear();
        for (const [k, v] of snapshot.entries()) refs.set(k, v);
        commitMessages.clear();
        for (const [k, v] of msgSnapshot.entries()) commitMessages.set(k, v);
        return { ok: false, fatal: true, error: 'cas_mismatch' };
      }
      refs.set(name, oid);
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
    exists,
    async createRefPair({ laneRef, claimRef: claimRefName, oid }) {
      return updateRefs([refUpdateCreate(laneRef, oid), refUpdateCreate(claimRefName, oid)]);
    },
    async createRef({ ref, sha, oid }) {
      const target = sha || oid;
      return updateRefs([refUpdateCreate(ref, target)]);
    },
    async deleteRef({ ref, beforeOid }) {
      const sha = beforeOid || refs.get(ref);
      return updateRefs([refUpdateDelete(ref, sha)]);
    },
    async getRef({ ref }) {
      if (!exists(ref)) return { ok: false, status: 404 };
      return { ok: true, ref, sha: refs.get(ref), message: commitMessages.get(ref) || null };
    },
    async listRefs({ prefix }) {
      const rows = [];
      for (const [ref, sha] of refs.entries()) {
        if (!ref.startsWith(prefix || '')) continue;
        rows.push({ ref, sha, message: commitMessages.get(ref) || null });
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
    async renewRef({ ref, newOid, beforeOid }) {
      return updateRefs([{ name: ref, oid: newOid, beforeOid }]);
    },
    async createLeaseCommit() {
      return { ok: true, sha: 'f'.repeat(40) };
    },
    setRefMessage(ref, message) {
      commitMessages.set(ref, message);
    },
    updateRefs,
  };
}

function createYieldingRaceClient(yieldMs = 5) {
  return createMockRefClient({ yieldMs });
}

module.exports = { createMockRefClient, createYieldingRaceClient };