'use strict';

/**
 * In-memory GitHub ref client for concurrency proofs.
 * createRef fails with status 422 when ref already exists (atomic semantics).
 */
function createMockRefClient() {
  const refs = new Map();
  const commitMessages = new Map();

  function exists(ref) {
    return refs.has(ref);
  }

  return {
    refs,
    commitMessages,
    exists,
    async createRef({ ref, sha }) {
      if (exists(ref)) return { ok: false, status: 422, error: 'Reference already exists' };
      refs.set(ref, sha);
      return { ok: true, status: 201 };
    },
    async deleteRef({ ref }) {
      if (!exists(ref)) return { ok: false, status: 404 };
      refs.delete(ref);
      commitMessages.delete(ref);
      return { ok: true };
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
    setRefMessage(ref, message) {
      commitMessages.set(ref, message);
    },
  };
}

module.exports = { createMockRefClient };