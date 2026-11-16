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

// Omitted means both providers. An empty or unknown value fails closed.
function parseProviders(raw) {
  if (raw === undefined || raw === null) return { ok: true, providers: ['claude', 'codex'] };
  if (typeof raw !== 'string') return { ok: false, providers: [] };
  const text = raw.trim();
  if (text === '') return { ok: false, providers: [] };
  const parts = text.split(',').map((part) => part.trim().toLowerCase());
  if (parts.some((part) => part === '')) return { ok: false, providers: [] };
  const seen = new Set();
  for (const part of parts) {
    if ((part !== 'claude' && part !== 'codex') || seen.has(part)) return { ok: false, providers: [] };
    seen.add(part);
  }
  return { ok: true, providers: ['claude', 'codex'].filter((name) => seen.has(name)) };
}

function providersFromEnv(env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(env, 'MYTHOS_GATE_PROVIDERS')) return parseProviders(undefined);
  return parseProviders(env.MYTHOS_GATE_PROVIDERS);
}

// Actions toJSON is null when the variable was never set, and "" when it is empty.
function parseProvidersJson(jsonText) {
  if (jsonText === undefined || jsonText === 'null') return parseProviders(undefined);
  let value;
  try {
    value = JSON.parse(jsonText);
  } catch {
    return { ok: false, providers: [] };
  }
  if (value === null) return parseProviders(undefined);
  if (typeof value !== 'string') return { ok: false, providers: [] };
  return parseProviders(value);
}

function providerArgument(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, 'MYTHOS_GATE_PROVIDERS_JSON')) {
    const parsed = parseProvidersJson(env.MYTHOS_GATE_PROVIDERS_JSON);
    if (!parsed.ok) return '';
    if (env.MYTHOS_GATE_PROVIDERS_JSON === 'null') return undefined;
    return parsed.providers.join(',');
  }
  if (!Object.prototype.hasOwnProperty.call(env, 'MYTHOS_GATE_PROVIDERS')) return undefined;
  const parsed = parseProviders(env.MYTHOS_GATE_PROVIDERS);
  return parsed.ok ? parsed.providers.join(',') : '';
}

function reviewRolesPass(roles) {
  return Boolean(roles && roles.critic === 'pass' && roles.shield === 'pass' && roles.probe === 'pass');
}

function rolePass(row, role, head, runId, runAttempt) {
  return Boolean(row && row.schema === RESULT_SCHEMA && row.provider === role && row.status === 'pass'
    && row.repository === REPO && row.headSha === head && sha40(head)
    && String(row.runId) === String(runId) && String(row.runAttempt) === String(runAttempt)
    && row.risk === 'low' && reviewRolesPass(row.roles));
}

function sameProviders(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function knownThreshold(value) {
  return value === 'strict' || value === 'standard';
}

function rowThreshold(row) {
  if (!row || row.status !== 'pass' || row.risk !== 'low') return null;
  return knownThreshold(row.threshold) ? row.threshold : null;
}

// Discover's class is mandatory. An empty or invalid THRESHOLD cannot pass,
// and a listed provider that disagrees cannot be upgraded.
function agreedThreshold(rows, providers, expected) {
  if (!expected || !knownThreshold(expected.threshold)) return null;
  for (const name of providers) {
    if (rowThreshold(rows[name]) !== expected.threshold) return null;
  }
  return expected.threshold;
}

function strictClaimOk(value) {
  if (!value || !knownThreshold(value.threshold)) return false;
  const providers = value.providers;
  if (!Array.isArray(providers) || providers.length === 0) return false;
  return providers.every((name) => value.roles && value.roles[name] && value.roles[name].threshold === value.threshold);
}

// A pass requires every listed provider on the same low-risk head.
// High risk, a missing role, an unavailable listed provider, or a bad provider list cannot pass.
// An unlisted provider cannot satisfy a listed one.
// threshold comes from those listed providers and must match the compare class when one is supplied.
function reduce(claude, codex, expected, rawProviders) {
  const parsed = parseProviders(rawProviders);
  if (!parsed.ok) return noPass('providers');
  const rows = { claude, codex };
  const head = rows[parsed.providers[0]] && rows[parsed.providers[0]].headSha;
  for (const name of parsed.providers) {
    if (!rolePass(rows[name], name, head, expected.runId, expected.runAttempt)) {
      return noPass(rows[name] && rows[name].status);
    }
  }
  const threshold = agreedThreshold(rows, parsed.providers, expected);
  if (!threshold) return noPass('threshold');
  const pr = rows[parsed.providers[0]].pr;
  if (!Number.isInteger(pr) || pr < 1 || parsed.providers.some((name) => rows[name].pr !== pr)) {
    return noPass('refused');
  }
  const roles = {};
  for (const name of parsed.providers) {
    roles[name] = { provider: name, status: 'pass', critic: 'pass', shield: 'pass', probe: 'pass', threshold };
  }
  return {
    schema: RESULT_SCHEMA,
    decision: 'pass',
    status: 'pass',
    risk: 'low',
    threshold,
    repository: REPO,
    pr,
    headSha: head,
    runId: String(expected.runId),
    runAttempt: String(expected.runAttempt),
    providers: parsed.providers,
    roles,
  };
}

function acceptReducer(value, expected, rawProviders) {
  const parsed = parseProviders(rawProviders);
  if (!parsed.ok) return null;
  if (!value || value.schema !== RESULT_SCHEMA || value.decision !== 'pass' || value.status !== 'pass') return null;
  if (value.risk !== 'low' || value.repository !== REPO || !sha40(value.headSha)) return null;
  if (!Number.isInteger(value.pr) || value.pr < 1) return null;
  if (String(value.runId) !== String(expected.runId) || String(value.runAttempt) !== String(expected.runAttempt)) return null;
  if (value.appId && value.appId !== GATE_APP_ID) return null;
  if (!Array.isArray(value.providers) || !sameProviders(value.providers, parsed.providers)) return null;
  const roles = value.roles || {};
  for (const name of parsed.providers) {
    if (!rolePass({ ...value, provider: name, roles: roles[name] }, name, value.headSha, expected.runId, expected.runAttempt)) {
      return null;
    }
  }
  if (!expected || !knownThreshold(expected.threshold)) return null;
  if (value.threshold !== expected.threshold) return null;
  for (const name of parsed.providers) {
    if (!roles[name] || roles[name].threshold !== expected.threshold) return null;
  }
  if (!strictClaimOk(value)) return null;
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
    const result = reduce(readJsonEnv('CLAUDE_RESULT'), readJsonEnv('CODEX_RESULT'), {
      ...meta,
      threshold: process.env.THRESHOLD,
    }, providerArgument());
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

module.exports = {
  transportResult, reduce, acceptReducer, noPass, reviewRolesPass, parseProviders, providersFromEnv,
  parseProvidersJson, providerArgument, strictClaimOk,
};
