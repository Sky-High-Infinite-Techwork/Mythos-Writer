'use strict';

const { spawnSync } = require('node:child_process');

function redact(text) {
  return String(text || '')
    .replace(/-----BEGIN[\s\S]*?-----END [^-]+-----/g, '[redacted]')
    .replace(/\b(ghs_|github_pat_|ghp_)[A-Za-z0-9_]+/g, '[redacted]');
}

// The child environment is only PATH, HOME, and the one token for this call.
// A parent READY_TOKEN or private key is not inherited.
function run(bin, args, { token, input, timeout } = {}) {
  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '/tmp',
    LANG: 'C',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PROMPT_DISABLED: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '0',
  };
  if (token) env.GH_TOKEN = token;
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    env,
    input,
    timeout: timeout || 120000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: redact(result.stderr || (result.error && result.error.message) || ''),
    error: result.error || null,
  };
}

function gh(args, token, input) {
  return run(process.env.GH_BIN || 'gh', args, { token, input });
}

function git(repoDir, args) {
  return run(process.env.GIT_BIN || 'git', [
    '-C', repoDir,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=',
    '-c', 'diff.external=',
    ...args,
  ], { timeout: 180000 });
}

module.exports = { redact, run, gh, git };
