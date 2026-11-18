'use strict';

const { gh: defaultGh } = require('../spawn');
const { httpStatusFromGh } = require('./gh-http');
const { REPO, MATCHING_REF_PREFIX } = require('./constants');

const LANE_REF_MSG_RE = /^refs\/mythos\/dispatch\/lane-\d{2}$/;
const CLAIM_REF_MSG_RE = /^refs\/mythos\/dispatch\/claim\/\d+-\d+$/;

function refNeedsLeaseMessage(ref) {
  return LANE_REF_MSG_RE.test(ref) || CLAIM_REF_MSG_RE.test(ref);
}
const {
  UPDATE_REFS_MUTATION,
  refUpdateCreate,
  refUpdateDelete,
  refUpdateRenew,
  parseGraphqlErrors,
  isRefExistsError,
  assertDispatchRef,
  OID_HEX,
  UPDATE_REFS_REF_EXISTS,
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
    return {
      read: { listRefs: noop, getRef: noop, issueComments: noop, getIssue: noop, issueCommentContentEdits: noop },
      write: { updateRefs: noop, createLeaseCommit: noop },
      combined: null,
    };
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
        const sha = row.object && row.object.sha;
        let message = null;
        if (sha && refNeedsLeaseMessage(row.ref)) {
          const commit = gh(['api', `${base}/git/commits/${sha}`, '--jq', '.message'], readToken);
          if (commit.status !== 0) {
            return { ok: false, refs: [], error: commit.stderr || 'commit_message_failed' };
          }
          message = commit.stdout.replace(/\r?\n$/, '');
        }
        refs.push({ ref: row.ref, sha, message });
      }
      return { ok: true, refs };
    },
    async getRef({ ref }) {
      if (!readToken) return { ok: false, error: 'no_read_token' };
      assertDispatchRef(ref);
      const suffix = ref.startsWith('refs/') ? ref.slice('refs/'.length) : ref;
      const result = gh(['api', `${base}/git/ref/${encodeURIComponent(suffix)}`], readToken);
      if (result.status !== 0) {
        const parsedHttp = httpStatusFromGh(result.stderr, result.status);
        return {
          ok: false,
          status: parsedHttp ?? result.status,
          ghStatus: result.status,
          error: result.stderr || 'get_ref_failed',
        };
      }
      const parsed = parseGhJson(result.stdout);
      const sha = parsed && parsed.object && parsed.object.sha;
      if (!sha || !OID_HEX.test(sha)) {
        const parsedHttp = httpStatusFromGh(result.stderr, result.status);
        return {
          ok: false,
          status: parsedHttp ?? result.status,
          ghStatus: result.status,
          error: 'invalid_sha',
        };
      }
      const commit = gh(['api', `${base}/git/commits/${sha}`, '--jq', '.message'], readToken);
      if (commit.status !== 0) {
        const parsedHttp = httpStatusFromGh(commit.stderr, commit.status);
        return {
          ok: false,
          status: parsedHttp ?? commit.status,
          ghStatus: commit.status,
          error: commit.stderr || 'commit_message_failed',
        };
      }
      const message = commit.stdout.replace(/\r?\n$/, '');
      return { ok: true, ref, sha, message };
    },
    async issueCommentContentEdits({ issue, commentDatabaseId }) {
      if (!readToken) return { ok: false, editors: [], error: 'no_read_token' };
      const issueNumber = parseInt(String(issue), 10);
      const commentId = parseInt(String(commentDatabaseId), 10);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return { ok: false, editors: [], error: 'bad_issue' };
      }
      if (!Number.isInteger(commentId) || commentId < 1) {
        return { ok: false, editors: [], error: 'bad_comment' };
      }
      const commentPageQuery = [
        'query($owner:String!,$name:String!,$number:Int!,$after:String) {',
        'repository(owner:$owner,name:$name) {',
        'issue(number:$number) {',
        'comments(first:100, after:$after) {',
        'pageInfo { hasNextPage endCursor }',
        'nodes { databaseId } } } } }',
      ].join(' ');
      let commentAfter = null;
      let commentPageCursor = null;
      let found = false;
      for (let guard = 0; guard < 50; guard += 1) {
        const body = JSON.stringify({
          query: commentPageQuery,
          variables: {
            owner: target.owner,
            name: target.name,
            number: issueNumber,
            after: commentAfter,
          },
        });
        const result = gh(['api', 'graphql', '--input', '-'], readToken, body);
        if (result.status !== 0) {
          return { ok: false, editors: [], error: result.stderr || 'graphql_http' };
        }
        const parsed = parseGhJson(result.stdout);
        const page = parsed?.data?.repository?.issue?.comments;
        if (!page || !Array.isArray(page.nodes)) {
          return { ok: false, editors: [], error: 'graphql_parse' };
        }
        if (page.nodes.some((n) => Number(n.databaseId) === commentId)) {
          commentPageCursor = commentAfter;
          found = true;
          break;
        }
        if (!page.pageInfo?.hasNextPage) break;
        commentAfter = page.pageInfo.endCursor;
      }
      if (!found) return { ok: false, editors: [], error: 'comment_not_found' };

      const editors = [];
      let editAfter = null;
      const editsQuery = [
        'query($owner:String!,$name:String!,$number:Int!,$commentPage:String,$after:String) {',
        'repository(owner:$owner,name:$name) {',
        'issue(number:$number) {',
        'comments(first:100, after:$commentPage) {',
        'nodes { databaseId userContentEdits(first:100, after:$after) {',
        'pageInfo { hasNextPage endCursor }',
        'nodes { editor { login __typename } } } } } } } }',
      ].join(' ');
      for (let guard = 0; guard < 50; guard += 1) {
        const body = JSON.stringify({
          query: editsQuery,
          variables: {
            owner: target.owner,
            name: target.name,
            number: issueNumber,
            commentPage: commentPageCursor,
            after: editAfter,
          },
        });
        const result = gh(['api', 'graphql', '--input', '-'], readToken, body);
        if (result.status !== 0) {
          return { ok: false, editors: [], error: result.stderr || 'graphql_http' };
        }
        const parsed = parseGhJson(result.stdout);
        const nodes = parsed?.data?.repository?.issue?.comments?.nodes;
        const row = Array.isArray(nodes)
          ? nodes.find((n) => Number(n.databaseId) === commentId)
          : null;
        if (!row || !row.userContentEdits) {
          return { ok: false, editors: [], error: 'graphql_parse' };
        }
        for (const edit of row.userContentEdits.nodes || []) {
          if (!edit || !edit.editor || !edit.editor.login) {
            return { ok: false, editors: [], error: 'editor_redacted' };
          }
          editors.push({
            login: edit.editor.login,
            __typename: edit.editor.__typename,
          });
        }
        if (row.userContentEdits.pageInfo?.hasNextPage) {
          if (!row.userContentEdits.pageInfo.endCursor) {
            return { ok: false, editors: [], error: 'editor_history_incomplete' };
          }
          editAfter = row.userContentEdits.pageInfo.endCursor;
          continue;
        }
        return { ok: true, editors, complete: true };
      }
      return { ok: false, editors: [], error: 'editor_history_incomplete' };
    },
    async issueComments({ issue }) {
      if (!readToken) return { ok: false, comments: [], error: 'no_read_token' };
      const result = gh(
        [
          'api',
          `${base}/issues/${issue}/comments`,
          '--paginate',
          '--jq',
          '.[] | {id, body, created_at, updated_at, user: {login: .user.login, type: .user.type}}',
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
          updatedAt: row.updated_at,
          author: {
            login: row.user && row.user.login,
            __typename: bot ? 'Bot' : 'User',
          },
        });
      }
      return { ok: true, comments };
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
      const body = JSON.stringify({
        query: UPDATE_REFS_MUTATION,
        variables: { repositoryId: nodeId, refUpdates },
      });
      const result = gh(['api', 'graphql', '--input', '-'], writeToken, body);
      const errors = parseGraphqlErrors(result.stdout);
      const httpStatus = httpStatusFromGh(result.stderr, result.status);
      const statusCode = httpStatus ?? (result.status === 0 ? 201 : result.status);
      if (result.status === 0 && (!errors || errors.length === 0)) {
        return { ok: true, status: statusCode, ghStatus: result.status };
      }
      if (isRefExistsError(errors)) {
        return {
          ok: false,
          status: 422,
          ghStatus: result.status,
          error: UPDATE_REFS_REF_EXISTS,
          refExists: true,
          errors,
        };
      }
      return {
        ok: false,
        fatal: true,
        status: statusCode,
        ghStatus: result.status,
        error: result.stderr || result.stdout,
        errors,
      };
    },
    async deleteRef({ ref, beforeOid }) {
      assertDispatchRef(ref);
      if (!beforeOid || !OID_HEX.test(beforeOid)) {
        return { ok: false, fatal: true, error: 'missing_before_oid' };
      }
      return write.updateRefs([refUpdateDelete(ref, beforeOid)]);
    },
    async createRef({ ref, sha, afterOid }) {
      const target = afterOid || sha;
      return write.updateRefs([refUpdateCreate(ref, target)]);
    },
    async createLeaseCommit(message, parentSha) {
      if (!writeToken) return { ok: false, error: 'no_write_token' };
      if (!OID_HEX.test(parentSha || '')) return { ok: false, error: 'invalid_parent_sha' };
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
      return { ok: true, sha: parsed.sha, message };
    },
    async renewRef({ ref, newAfterOid, newOid, beforeOid }) {
      const afterOid = newAfterOid || newOid;
      if (!afterOid || !beforeOid) {
        return { ok: false, fatal: true, error: 'missing_oid' };
      }
      return write.updateRefs([refUpdateRenew(ref, afterOid, beforeOid)]);
    },
    async renewRefPair({ laneRef, claimRef, afterOid, beforeOid }) {
      return write.updateRefs([
        refUpdateRenew(laneRef, afterOid, beforeOid),
        refUpdateRenew(claimRef, afterOid, beforeOid),
      ]);
    },
    async createRefPair({ laneRef, claimRef, afterOid, oid }) {
      const target = afterOid || oid;
      return write.updateRefs([
        refUpdateCreate(laneRef, target),
        refUpdateCreate(claimRef, target),
      ]);
    },
    refUpdateCreate,
    refUpdateDelete,
    refUpdateRenew,
  };

  /** @deprecated single token — use createDispatchClients */
  function legacyCombined() {
    return {
      async createRef({ ref, sha, afterOid }) {
        return write.createRef({ ref, sha, afterOid });
      },
      async deleteRef({ ref, beforeOid }) {
        return write.deleteRef({ ref, beforeOid });
      },
      listRefs: (args) => read.listRefs(args),
      getRef: (args) => read.getRef(args),
      issueComments: (args) => read.issueComments(args),
      issueCommentContentEdits: (args) => read.issueCommentContentEdits(args),
      getIssue: (args) => read.getIssue(args),
      updateRefs: (updates) => write.updateRefs(updates),
      createRefPair: (args) => write.createRefPair(args),
      createLeaseCommit: (msg, parent) => write.createLeaseCommit(msg, parent),
      renewRef: (args) => write.renewRef(args),
      renewRefPair: (args) => write.renewRefPair(args),
      read,
      write,
    };
  }

  return { read, write, combined: legacyCombined() };
}

module.exports = {
  createDispatchClients,
  parseGhJson,
  UPDATE_REFS_REF_EXISTS,
};