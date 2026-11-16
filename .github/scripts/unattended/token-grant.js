'use strict';

const { REPO } = require('./constants');
const { gh } = require('./spawn');

function splitHttp(text) {
  const parts = String(text || '').split(/\r?\n\r?\n/);
  const headers = {};
  for (const line of (parts[0] || '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { headers, body: parts.slice(1).join('\n\n') };
}

function parsePermissions(header) {
  const perms = {};
  if (!header) return perms;
  for (const piece of header.split(/[;,]/)) {
    const pair = piece.trim();
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    perms[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return perms;
}

function grantOk(perms, expectedWrites) {
  const writes = Object.entries(perms).filter(([, level]) => level === 'write').map(([name]) => name).sort();
  const want = [...expectedWrites].sort();
  if (writes.length !== want.length || writes.some((name, i) => name !== want[i])) return false;
  return Object.entries(perms).every(([name, level]) => {
    if (level === 'write') return true;
    return level === 'read' && name === 'metadata';
  });
}

function interpretGrant(raw, expectedWrites) {
  const { headers, body } = splitHttp(raw);
  const perms = parsePermissions(headers['x-accepted-github-permissions']);
  if (!grantOk(perms, expectedWrites)) return { ok: false, error: 'token grant' };
  const expiry = Date.parse(headers['github-authentication-token-expiration'] || '');
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return { ok: false, error: 'token expiry' };
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: 'token repositories' };
  }
  const repos = parsed && Array.isArray(parsed.repositories) ? parsed.repositories : null;
  if (!repos || typeof parsed.total_count !== 'number' || parsed.total_count !== repos.length) {
    return { ok: false, error: 'token repositories' };
  }
  const names = repos.map((repo) => repo && repo.full_name);
  if (names.length !== 1 || names[0] !== REPO) return { ok: false, error: 'token repository' };
  return { ok: true };
}

function main() {
  const expected = String(process.env.EXPECTED_WRITES || '').split(',').map((name) => name.trim()).filter(Boolean);
  if (!process.env.TOKEN || expected.length === 0) {
    process.stderr.write('refuse: token grant input\n');
    return 1;
  }
  const result = gh(['api', '--include', '/installation/repositories?per_page=100'], process.env.TOKEN);
  if (result.status !== 0) {
    process.stderr.write('refuse: token grant read\n');
    return 1;
  }
  const grant = interpretGrant(result.stdout, expected);
  if (!grant.ok) {
    process.stderr.write(`refuse: ${grant.error}\n`);
    return 1;
  }
  process.stdout.write('token grant matches the repository and the requested writes\n');
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { interpretGrant, grantOk, parsePermissions };
