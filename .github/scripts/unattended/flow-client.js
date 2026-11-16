'use strict';

const { gh } = require('./spawn');
const { CHECK_NAME, REQUIRED_CHECKS, sha40 } = require('./constants');
const { readSwitch } = require('./switch');
const { latestRun } = require('./flow-policy');

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function splitRepo(repo) {
  const parts = String(repo).split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], name: parts[1] };
}

const ENQUEUE_QUERY = `mutation($id:ID!,$expected:GitObjectID!){
  enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$expected}){
    mergeQueueEntry{ position state }
  }
}`;

function createClient({ repo, readToken, controlToken, readyToken, enqueueToken }) {
  function api(args, token, input) {
    const result = gh(args, token, input);
    if (result.status !== 0) return { ok: false, error: result.stderr || `exit ${result.status}` };
    return { ok: true, stdout: result.stdout };
  }

  function listOpen() {
    const got = api([
      'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200',
      '--json', 'number,isDraft,isCrossRepository,baseRefName,headRefOid,mergeStateStatus,author,labels,id,changedFiles',
    ], readToken);
    if (!got.ok) return got;
    const prs = parseJson(got.stdout);
    if (!Array.isArray(prs)) return { ok: false, error: 'pr list was not a JSON array' };
    return { ok: true, prs, truncated: prs.length >= 200 };
  }

  function comments(number) {
    const got = api(['api', '--paginate', `repos/${repo}/issues/${number}/comments`], readToken);
    if (!got.ok) return got;
    const rows = parseJson(got.stdout);
    if (!Array.isArray(rows)) return { ok: false, error: 'comments were not a JSON array' };
    return {
      ok: true,
      comments: rows.map((row) => ({
        login: row && row.user && row.user.login,
        body: typeof (row && row.body) === 'string' ? row.body : '',
      })),
    };
  }

  function files(number) {
    const got = api(['api', '--paginate', `repos/${repo}/pulls/${number}/files`], readToken);
    if (!got.ok) return got;
    const rows = parseJson(got.stdout);
    if (!Array.isArray(rows)) return { ok: false, error: 'files were not a JSON array' };
    return { ok: true, files: rows.map((row) => ({ filename: row && row.filename })) };
  }

  function checks(sha) {
    if (!sha40(sha)) return { ok: false, error: 'head sha' };
    const names = [...REQUIRED_CHECKS, CHECK_NAME];
    const byName = {};
    for (const name of names) {
      const path = `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`;
      const got = api(['api', path], readToken);
      if (!got.ok) return got;
      const body = parseJson(got.stdout);
      if (!body || !Array.isArray(body.check_runs)) return { ok: false, error: `checks unreadable for ${name}` };
      if (body.total_count > body.check_runs.length) return { ok: false, error: `checks truncated for ${name}` };
      const run = latestRun(body.check_runs);
      if (!run) continue;
      const key = name === CHECK_NAME ? 'gate' : name;
      byName[key] = {
        conclusion: run.conclusion,
        headSha: run.head_sha,
        appId: run.app && run.app.id,
        summary: run.output && run.output.summary,
      };
    }
    return { ok: true, checks: byName };
  }

  function queueState(number) {
    const parts = splitRepo(repo);
    if (!parts) return { ok: false, error: 'repository' };
    const query = `query($owner:String!,$name:String!,$n:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$n){
          id isDraft isInMergeQueue isMergeQueueEnabled headRefOid baseRefName state mergeStateStatus
        }
      }
    }`;
    const got = api(['api', 'graphql', '--input', '-'], readToken, JSON.stringify({
      query,
      variables: { owner: parts.owner, name: parts.name, n: number },
    }));
    if (!got.ok) return got;
    const body = parseJson(got.stdout);
    const pr = body && body.data && body.data.repository && body.data.repository.pullRequest;
    if (!pr || body.errors) return { ok: false, error: 'pull request query failed' };
    return {
      ok: true,
      queue: {
        nodeId: pr.id,
        draft: pr.isDraft === true,
        inQueue: pr.isInMergeQueue === true,
        queueEnabled: pr.isMergeQueueEnabled === true,
        head: pr.headRefOid,
        base: pr.baseRefName,
        state: pr.state,
        mergeState: pr.mergeStateStatus,
      },
    };
  }

  function ready(number) {
    const got = api(['pr', 'ready', String(number), '--repo', repo], readyToken);
    return got.ok ? { ok: true } : got;
  }

  function enqueue(nodeId, head) {
    if (!sha40(head)) return { ok: false, error: 'expected head must be a full sha' };
    const got = api(['api', 'graphql', '--input', '-'], enqueueToken, JSON.stringify({
      query: ENQUEUE_QUERY,
      variables: { id: nodeId, expected: head },
    }));
    if (!got.ok) return got;
    const body = parseJson(got.stdout);
    const entry = body && body.data && body.data.enqueuePullRequest && body.data.enqueuePullRequest.mergeQueueEntry;
    if (!entry || body.errors) return { ok: false, error: 'enqueue did not return a queue entry' };
    return { ok: true, entry: { position: entry.position, state: entry.state } };
  }

  return {
    readSwitch: () => readSwitch(repo, controlToken),
    listOpen,
    comments,
    files,
    checks,
    queueState,
    ready,
    enqueue,
  };
}

module.exports = { createClient, parseJson, ENQUEUE_QUERY };
