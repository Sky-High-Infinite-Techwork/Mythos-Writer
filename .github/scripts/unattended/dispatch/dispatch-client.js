'use strict';

const { gh: defaultGh } = require('../spawn');
const { REPO, MATCHING_REF_PREFIX } = require('./constants');
const {
  UPDATE_REFS_MUTATION,
  refUpdateCreate,
  refUpdateDelete,
  refUpdateRenew,
  parseGraphqlErrors,
  isRefExistsError,
  assertDispatchRef,
} = require('./refs-graphql');

function splitRepo(repo) {
  const parts = String(repo || REPO).split('/');
  if (parts.length !== 2) return null;
  return { owner: parts[0], name: parts[1] };
}

function parseGhJson(stdout) {
  try {
    return JSON.parse(stdout || '');
  } catch {
    return null;
  }
}

function createDispatchClients({ repo = REPO, readToken, writeToken, gh = defaultGh } = {}) {
  const target = splitRepo(repo);
  const noop = async () => ({ ok: false, error: 'no_token' });
  if (!target) {
    return { read: { listRefs: noop, getRef: noop, issueComments: noop, getIssue: noop }, write: { updateRefs: noop, createLeaseCommit: noop } };
  }
  const base = `repos/${target.owner}/${target.name}`;
  let repoNodeIdCache = null;

  async function repositoryNodeId() {
    if (repoNodeIdCache) return repoNodeIdCache;
    if (!readToken) return null;
    const result = gh(['api', base, '--jq', '.node_id'], readToken);
    if (result.status !== 0) return null;
    repoNodeIdCache = result.stdout.replace(/\r?\n$/, '');
    return repoNodeIdCache;
  }

  const read = {
    async listRefs({ prefix }) {
      if (!readToken) return { ok: false, refs: [], error: 'no_read_token' };
      let pathPrefix = String(prefix || MATCHING_REF_PREFIX).replace(/^refs\//, '');
      if (!pathPrefix.startsWith('mythos/dispatch')) pathPrefix = MATCHING_REF_PREFIX;
      const result = gh(['api', `${base}/git/matching-refs/${encodeURIComponent(pathPrefix)}`], readToken);
      if (result.status !== 0) return { ok: false, refs: [], error: result.stderr || 'list_failed' };
      const parsed = parseGhJson(result.stdout);
      if (!Array.isArray(parsed)) return { ok: false, refs: [], error: 'parse_failed' };
      const refs = [];
      for (const row of parsed) {
        if (!row || !row.ref) continue;
        let message = null;
        const sha = row.object && row.object.sha;
        if (sha) {
          const commit = gh(['api', `${base}/git/commits/${sha}`, '--jq', '.message'], readToken);
          if (commit.status === 0) message = commit.stdout.replace(/\r?\n$/, '');
        }
        refs.push({ ref: row.ref, sha, message });
      }
      return { ok: true, refs };
    },
    async getRef({ ref }) {
      if (!readToken) return { ok: false, error: 'no_read_token' };
      assertDispatchRef(ref);
      const suffix = ref.startsWith('refs/') ? ref.slice('refs/'.length) : ref;
      const result = gh(['api', `${base}/git/${suffix}`], readToken);
      if (result.status !== 0) return { ok: false, status: result.status, error: result.stderr };
      const parsed = parseGhJson(result.stdout);
      const sha = parsed && parsed.object && parsed.object.sha;
      return { ok: true, ref, sha };
    },
    async issueComments({ issue }) {
      if (!readToken) return { ok: false, comments: [], error: 'no_read_token' };
      const result = gh(
        [
          'api',
          `${base}/issues/${issue}/comments`,
          '--paginate',
          '--jq',
          '.[] | {id, body, created_at, user: {login: .user.login, type: .user.type}}',
        ],
        readToken,
      );
      if (result.status !== 0) return { ok: false, comments: [], error: result.stderr };
      const comments = [];
      for (const line of (result.stdout || '').split('\n').filter(Boolean)) {
        const row = parseGhJson(line);
        if (!row) return { ok: false, comments: [], error: 'comment_parse' };
        const bot = row.user && row.user.type === 'Bot';
        comments.push({
          id: String(row.id),
          databaseId: row.id,
          body: row.body,
          createdAt: row.created_at,
          author: {
            login: row.user && row.user.login,
            __typename: bot ? 'Bot' : 'User',
          },
        });
      }
      return { ok: true, comments };
    },
    async issueEvents({ issue }) {
      if (!readToken) return { ok: false, events: [] };
      const result = gh(
        ['api', `${base}/issues/${issue}/events`, '--paginate', '--jq', '.[] | {event, actor: {login: .actor.login, type: .actor.type}}'],
        readToken,
      );
      if (result.status !== 0) return { ok: false, events: [] };
      const events = [];
      for (const line of (result.stdout || '').split('\n').filter(Boolean)) {
        const row = parseGhJson(line);
        if (!row) return { ok: false, events: [] };
        events.push(row);
      }
      return { ok: true, events };
    },
    async getIssue({ issue }) {
      if (!readToken) return { ok: false, error: 'no_read_token' };
      const result = gh(
        ['api', `${base}/issues/${issue}`, '--jq', '{state, pull_request, updated_at, user: {login: .user.login, type: .user.type}}'],
        readToken,
      );
      if (result.status !== 0) return { ok: false, error: result.stderr };
      const parsed = parseGhJson(result.stdout);
      if (!parsed) return { ok: false, error: 'parse_failed' };
      return { ok: true, issue: parsed };
    },
  };

  const write = {
    async updateRefs(refUpdates) {
      if (!writeToken) return { ok: false, fatal: true, error: 'no_write_token' };
      for (const row of refUpdates) assertDispatchRef(row.name);
      const nodeId = await repositoryNodeId();
      if (!nodeId) return { ok: false, fatal: true, error: 'repo_node_id' };
      const result = gh(
        [
          'api', 'graphql',
          '-f', `query=${UPDATE_REFS_MUTATION}`,
          '-f', `repositoryId=${nodeId}`,
          '-F', `refUpdates=${JSON.stringify(refUpdates)}`,
        ],
        writeToken,
      );
      const errors = parseGraphqlErrors(result.stdout, result.stderr);
      if (result.status === 0 && (!errors || errors.length === 0)) {
        return { ok: true, status: 201 };
      }
      if (isRefExistsError(errors)) {
        return { ok: false, status: 422, error: 'Reference already exists', refExists: true };
      }
      return { ok: false, fatal: true, status: result.status, error: result.stderr || result.stdout, errors };
    },
    async deleteRef({ ref, beforeOid }) {
      assertDispatchRef(ref);
      const expect = beforeOid;
      if (expect) return write.updateRefs([refUpdateDelete(ref, expect)]);
      const got = await read.getRef({ ref });
      if (!got.ok) return { ok: false, error: got.error };
      return write.updateRefs([refUpdateDelete(ref, got.sha)]);
    },
    async createRef({ ref, sha }) {
      return write.updateRefs([refUpdateCreate(ref, sha)]);
    },
    async createLeaseCommit(message, parentSha) {
      if (!writeToken) return { ok: false, error: 'no_write_token' };
      const treeResult = gh(['api', `${base}/git/commits/${parentSha}`, '--jq', '.tree.sha'], readToken || writeToken);
      if (treeResult.status !== 0) return { ok: false, error: 'parent_tree' };
      const treeSha = treeResult.stdout.replace(/\r?\n$/, '');
      const commit = gh(
        [
          'api', '-X', 'POST', `${base}/git/commits`,
          '-f', `message=${message}`,
          '-f', `tree=${treeSha}`,
          '-f', `parents[]=${parentSha}`,
        ],
        writeToken,
      );
      if (commit.status !== 0) return { ok: false, error: commit.stderr };
      const parsed = parseGhJson(commit.stdout);
      if (!parsed || !parsed.sha) return { ok: false, error: 'commit_parse' };
      return { ok: true, sha: parsed.sha };
    },
    async renewRef({ ref, newOid, beforeOid }) {
      return write.updateRefs([refUpdateRenew(ref, newOid, beforeOid)]);
    },
    async createRefPair({ laneRef, claimRef, oid }) {
      return write.updateRefs([
        refUpdateCreate(laneRef, oid),
        refUpdateCreate(claimRef, oid),
      ]);
    },
    refUpdateCreate,
    refUpdateDelete,
    refUpdateRenew,
  };

  /** @deprecated single token — use createDispatchClients */
  function legacyCombined() {
    const token = writeToken || readToken;
    return {
      async createRef({ ref, sha }) {
        return write.updateRefs([refUpdateCreate(ref, sha)]);
      },
      async deleteRef({ ref, beforeOid }) {
        return write.deleteRef({ ref, beforeOid });
      },
      listRefs: (args) => read.listRefs(args),
      getRef: (args) => read.getRef(args),
      issueComments: (args) => read.issueComments(args),
      getIssue: (args) => read.getIssue(args),
      updateRefs: (updates) => write.updateRefs(updates),
      createRefPair: (args) => write.createRefPair(args),
      issueEvents: (args) => read.issueEvents(args),
      getIssue: (args) => read.getIssue(args),
      createLeaseCommit: (msg, parent) => write.createLeaseCommit(msg, parent),
      renewRef: (args) => write.renewRef(args),
      read,
      write,
    };
  }

  return { read, write, combined: legacyCombined() };
}

function createGhDispatchClient(readToken, writeToken, repo = REPO) {
  return createDispatchClients({ repo, readToken, writeToken }).combined;
}

module.exports = {
  createDispatchClients,
  createGhDispatchClient,
  parseGhJson,
};