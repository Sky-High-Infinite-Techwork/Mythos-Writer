'use strict';

const { gh } = require('./spawn');
const { CHECK_NAME, EVIDENCE_WORKFLOWS, GATE_APP_ID, REPO, REQUIRED_CHECKS, sha40 } = require('./constants');
const { readSwitch } = require('./switch');
const { latestRun } = require('./flow-policy');

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function flattenRunPages(text) {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const runs = [];
  let total = null;
  for (const page of parsed) {
    if (!page || !Array.isArray(page.workflow_runs) || typeof page.total_count !== 'number') return null;
    if (total === null) total = page.total_count;
    for (const run of page.workflow_runs) runs.push(run);
  }
  if (runs.length < total) return null;
  return runs;
}

function flattenPages(text) {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) return null;
  const rows = [];
  for (const page of parsed) {
    if (!Array.isArray(page)) return null;
    for (const row of page) rows.push(row);
  }
  return rows;
}

function mapChangedFile(row) {
  return {
    filename: row && row.filename,
    status: row && row.status,
    previous_filename: row && row.previous_filename,
  };
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
    const got = api(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments`], readToken);
    if (!got.ok) return got;
    const rows = flattenPages(got.stdout);
    if (!rows) return { ok: false, error: 'comments were not pages of JSON' };
    return {
      ok: true,
      comments: rows.map((row) => ({
        login: row && row.user && row.user.login,
        body: typeof (row && row.body) === 'string' ? row.body : '',
      })),
    };
  }

  function files(number) {
    const got = api(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/files`], readToken);
    if (!got.ok) return got;
    const rows = flattenPages(got.stdout);
    if (!rows) return { ok: false, error: 'files were not pages of JSON' };
    return { ok: true, files: rows.map(mapChangedFile) };
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
          id isDraft isInMergeQueue isMergeQueueEnabled headRefOid baseRefName baseRefOid state mergeStateStatus
          author { login }
          headRepository { nameWithOwner }
          labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
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
    const labelConn = pr.labels || {};
    const labelNodes = labelConn.nodes || [];
    return {
      ok: true,
      queue: {
        nodeId: pr.id,
        draft: pr.isDraft === true,
        inQueue: pr.isInMergeQueue === true,
        queueEnabled: pr.isMergeQueueEnabled === true,
        policyKnown: typeof pr.isMergeQueueEnabled === 'boolean',
        head: pr.headRefOid,
        base: pr.baseRefName,
        state: pr.state,
        mergeState: pr.mergeStateStatus,
        author: pr.author && pr.author.login,
        fork: Boolean(pr.headRepository && pr.headRepository.nameWithOwner) && pr.headRepository.nameWithOwner !== repo,
        scopeKnown: Boolean(pr.headRepository && pr.headRepository.nameWithOwner),
        teamScopeKnown: Boolean(pr.headRepository && pr.headRepository.nameWithOwner)
          && typeof (pr.author && pr.author.login) === 'string' && pr.author.login.length > 0,
        labels: labelNodes.map((node) => node && node.name).filter(Boolean),
        labelsComplete: Boolean(labelConn.pageInfo) && labelConn.pageInfo.hasNextPage !== true,
        leaseKnown: Boolean(labelConn.pageInfo) && labelConn.pageInfo.hasNextPage !== true,
        leaseHeld: Boolean(labelConn.pageInfo) && labelConn.pageInfo.hasNextPage !== true
          && labelNodes.some((node) => node && (node.name === 'lease' || String(node.name || '').startsWith('lease:'))),
        baseSha: pr.baseRefOid,
      },
    };
  }

  function blobSha(workflowPath, ref) {
    const got = api(['api', `repos/${repo}/contents/${workflowPath}?ref=${encodeURIComponent(ref)}`], readToken);
    if (!got.ok) return got;
    const body = parseJson(got.stdout);
    if (!body || !sha40(body.sha)) return { ok: false, error: `workflow blob unreadable at ${ref}` };
    return { ok: true, sha: body.sha };
  }

  function evidence(prNumber, head) {
    if (!sha40(head)) return { ok: false, error: 'head sha' };
    const mainRevision = {};
    const headRevision = {};
    for (const workflowPath of EVIDENCE_WORKFLOWS) {
      const onMain = blobSha(workflowPath, 'refs/heads/main');
      if (!onMain.ok) return onMain;
      const onHead = blobSha(workflowPath, head);
      if (!onHead.ok) return { ok: true, evidence: { mainRevision: {}, runs: [] } };
      mainRevision[workflowPath] = onMain.sha;
      headRevision[workflowPath] = onHead.sha;
    }
    const got = api([
      'api', '--paginate', '--slurp',
      `repos/${repo}/actions/runs?head_sha=${head}&per_page=100`,
    ], readToken);
    if (!got.ok) return got;
    const pages = flattenRunPages(got.stdout);
    if (!pages) return { ok: false, error: 'workflow runs were not pages of JSON' };
    const runs = [];
    for (const run of pages) {
      if (!run || run.head_sha !== head) continue;
      const workflowPath = run.path;
      if (!EVIDENCE_WORKFLOWS.includes(workflowPath)) continue;
      const link = (run.pull_requests || []).find((row) => row && row.number === prNumber);
      runs.push({
        path: workflowPath,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        headSha: run.head_sha,
        pr: prNumber,
        prHeadSha: link && link.head && link.head.sha,
        prBaseRef: link && link.base && link.base.ref,
        prBaseSha: link && link.base && link.base.sha,
        repository: run.repository && run.repository.full_name,
        headRepository: run.head_repository && run.head_repository.full_name,
        runId: run.id,
        runAttempt: run.run_attempt,
        workflowBlob: headRevision[workflowPath],
      });
    }
    return { ok: true, evidence: { mainRevision, runs } };
  }

  let rulesetCache = null;
  function ruleset() {
    if (rulesetCache) return rulesetCache;
    const got = api(['api', `repos/${repo}/rules/branches/main`], readToken);
    const rules = got.ok ? parseJson(got.stdout) : null;
    if (!Array.isArray(rules)) {
      rulesetCache = { ok: true, ruleset: { known: false, match: false } };
      return rulesetCache;
    }
    const required = rules.find((rule) => rule && rule.type === 'required_status_checks');
    const contexts = required && required.parameters && required.parameters.required_status_checks;
    const list = Array.isArray(contexts) ? contexts : [];
    const names = new Set(list.map((row) => row && row.context));
    const gate = list.some((row) => row && row.context === CHECK_NAME && row.integration_id === GATE_APP_ID);
    const checks = REQUIRED_CHECKS.every((name) => names.has(name)) && gate;
    const queue = rules.some((rule) => rule && rule.type === 'merge_queue');
    rulesetCache = { ok: true, ruleset: { known: true, match: queue && checks } };
    return rulesetCache;
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
    evidence,
    ruleset,
    ready,
    enqueue,
  };
}

module.exports = {
  createClient, parseJson, flattenPages, flattenRunPages, mapChangedFile, ENQUEUE_QUERY,
};
