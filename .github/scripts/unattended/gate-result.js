'use strict';

const fs = require('node:fs');
const { REPO, RESULT_SCHEMA, sha40, GATE_APP_ID } = require('./constants');

function transportResult(provider, meta) {
  const known = provider === 'claude' || provider === 'codex';
  return {
    schema: RESULT_SCHEMA,
    provider: known ? provider : 'unknown',
    status: 'unavailable',
    decision: 'no-pass',
    reason: 'model-transport-not-approved',
    repository: REPO,
    runId: meta && meta.runId ? String(meta.runId) : '',
    runAttempt: meta && meta.runAttempt ? String(meta.runAttempt) : '',
  };
}

function noPass(status) {
  return { schema: RESULT_SCHEMA, decision: 'no-pass', status: status || 'unavailable', repository: REPO };
}

function rolePass(row, role, head, runId, runAttempt) {
  return Boolean(row && row.schema === RESULT_SCHEMA && row.provider === role && row.status === 'pass'
    && row.repository === REPO && row.headSha === head && sha40(head)
    && String(row.runId) === String(runId) && String(row.runAttempt) === String(runAttempt)
    && row.risk === 'low');
}

// A pass requires both isolated transports to pass the same low-risk head in this run.
// High risk, a missing role, a mismatched sha, or unavailable output cannot pass.
function reduce(claude, codex, expected) {
  const head = claude && claude.headSha;
  if (!rolePass(claude, 'claude', head, expected.runId, expected.runAttempt)) return noPass(claude && claude.status);
  if (!rolePass(codex, 'codex', head, expected.runId, expected.runAttempt)) return noPass(codex && codex.status);
  if (!Number.isInteger(claude.pr) || claude.pr !== codex.pr || claude.pr < 1) return noPass('refused');
  return {
    schema: RESULT_SCHEMA,
    decision: 'pass',
    status: 'pass',
    risk: 'low',
    repository: REPO,
    pr: claude.pr,
    headSha: head,
    runId: String(expected.runId),
    runAttempt: String(expected.runAttempt),
    roles: {
      claude: { provider: 'claude', status: 'pass' },
      codex: { provider: 'codex', status: 'pass' },
    },
  };
}

function acceptReducer(value, expected) {
  if (!value || value.schema !== RESULT_SCHEMA || value.decision !== 'pass' || value.status !== 'pass') return null;
  if (value.risk !== 'low' || value.repository !== REPO || !sha40(value.headSha)) return null;
  if (!Number.isInteger(value.pr) || value.pr < 1) return null;
  if (String(value.runId) !== String(expected.runId) || String(value.runAttempt) !== String(expected.runAttempt)) return null;
  if (value.appId && value.appId !== GATE_APP_ID) return null;
  const roles = value.roles || {};
  if (!roles.claude || roles.claude.status !== 'pass' || roles.claude.provider !== 'claude') return null;
  if (!roles.codex || roles.codex.status !== 'pass' || roles.codex.provider !== 'codex') return null;
  return value;
}

function readJsonEnv(name) {
  if (!process.env[name]) return null;
  try {
    return JSON.parse(process.env[name]);
  } catch {
    return null;
  }
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${name}=${value}\n`);
}

function main(argv) {
  const command = argv[2];
  const meta = { runId: process.env.GITHUB_RUN_ID || '', runAttempt: process.env.GITHUB_RUN_ATTEMPT || '' };
  if (command === 'transport') {
    const result = transportResult(process.env.PROVIDER, meta);
    const line = JSON.stringify(result);
    setOutput('result', line);
    process.stdout.write(`${line}\n`);
    return 0;
  }
  if (command === 'reduce') {
    const result = reduce(readJsonEnv('CLAUDE_RESULT'), readJsonEnv('CODEX_RESULT'), meta);
    const line = JSON.stringify(result);
    setOutput('result', line);
    setOutput('decision', result.decision);
    process.stdout.write(`${line}\n`);
    return 0;
  }
  process.stderr.write('refuse: command\n');
  return 1;
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { transportResult, reduce, acceptReducer, noPass };
