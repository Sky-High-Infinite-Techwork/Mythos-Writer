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

// X-Accepted-GitHub-Permissions is what the endpoint requires, not the token grant.
// The repository list from GET /installation/repositories is the token's scope.
function interpretGrant(raw) {
  const { headers, body } = splitHttp(raw);
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
  if (!process.env.TOKEN) {
    process.stderr.write('refuse: token grant input\n');
    return 1;
  }
  const result = gh(['api', '--include', '/installation/repositories?per_page=100'], process.env.TOKEN);
  if (result.status !== 0) {
    process.stderr.write('refuse: token grant read\n');
    return 1;
  }
  const grant = interpretGrant(result.stdout);
  if (!grant.ok) {
    process.stderr.write(`refuse: ${grant.error}\n`);
    return 1;
  }
  process.stdout.write('token repository list is Mythos-Writer and the token is unexpired\n');
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { interpretGrant };
