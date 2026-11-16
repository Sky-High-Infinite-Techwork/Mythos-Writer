'use strict';

const { gh } = require('../spawn');
const { REPO } = require('./constants');

function splitRepo(repo) {
  const parts = String(repo || REPO).split('/');
  if (parts.length !== 2) return null;
  return { owner: parts[0], name: parts[1] };
}

function createGhDispatchClient(token, repo = REPO) {
  const target = splitRepo(repo);
  if (!token || !target) {
    return {
      async createRef() { return { ok: false, error: 'no_token' }; },
      async deleteRef() { return { ok: false, error: 'no_token' }; },
      async listRefs() { return { ok: false, refs: [] }; },
      async issueComments() { return { ok: false, comments: [] }; },
      async createLeaseCommit() { return { ok: false }; },
    };
  }
  const base = `repos/${target.owner}/${target.name}`;

  return {
    async createRef({ ref, sha }) {
      const result = gh(
        ['api', '-X', 'POST', `${base}/git/refs`, '-f', `ref=${ref}`, '-f', `sha=${sha}`],
        token,
      );
      if (result.status === 0) return { ok: true, status: 201 };
      if (/\b422\b/.test(result.stderr || '') || /Reference already exists/i.test(result.stderr || '')) {
        return { ok: false, status: 422, error: 'Reference already exists' };
      }
      return { ok: false, status: result.status, error: result.stderr || 'create_failed' };
    },
    async deleteRef({ ref }) {
      const suffix = ref.replace(/^refs\//, '');
      const result = gh(['api', '-X', 'DELETE', `${base}/git/${suffix}`], token);
      if (result.status === 0) return { ok: true };
      return { ok: false, status: result.status, error: result.stderr };
    },
    async listRefs({ prefix }) {
      const result = gh(['api', `${base}/git/matching-refs/${encodeURIComponent(prefix)}`], token);
      if (result.status !== 0) return { ok: false, refs: [] };
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return { ok: false, refs: [] };
      }
      const refs = [];
      for (const row of parsed || []) {
        if (!row || !row.ref) continue;
        let message = null;
        if (row.object && row.object.sha) {
          const commit = gh(['api', `${base}/git/commits/${row.object.sha}`, '--jq', '.message'], token);
          if (commit.status === 0) message = commit.stdout.replace(/\r?\n$/, '');
        }
        refs.push({ ref: row.ref, sha: row.object && row.object.sha, message });
      }
      return { ok: true, refs };
    },
    async issueComments({ issue }) {
      const result = gh(
        [
          'api',
          `${base}/issues/${issue}/comments`,
          '--paginate',
          '--jq',
          '.[] | {id, body, created_at, user: {login}}',
        ],
        token,
      );
      if (result.status !== 0) return { ok: false, comments: [] };
      const comments = (result.stdout || '').split('\n').filter(Boolean).map((line) => {
        const row = JSON.parse(line);
        return {
          id: String(row.id),
          databaseId: row.id,
          body: row.body,
          createdAt: row.created_at,
          author: { login: row.user && row.user.login },
        };
      });
      return { ok: true, comments };
    },
    async createLeaseCommit(message, parentSha) {
      if (!parentSha) return { ok: false, error: 'parent_required' };
      const treeResult = gh(['api', `${base}/git/commits/${parentSha}`, '--jq', '.tree.sha'], token);
      if (treeResult.status !== 0) return { ok: false, error: 'parent_tree' };
      const treeSha = treeResult.stdout.replace(/\r?\n$/, '');
      const commit = gh(
        [
          'api', '-X', 'POST', `${base}/git/commits`,
          '-f', `message=${message}`,
          '-f', `tree=${treeSha}`,
          '-f', `parents[]=${parentSha}`,
        ],
        token,
      );
      if (commit.status !== 0) return { ok: false, error: commit.stderr };
      try {
        return { ok: true, sha: JSON.parse(commit.stdout).sha };
      } catch {
        return { ok: false, error: 'commit_parse' };
      }
    },
  };
}

module.exports = { createGhDispatchClient };