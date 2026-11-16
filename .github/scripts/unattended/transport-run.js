'use strict';

const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO, sha40 } = require('./constants');
const { gh } = require('./spawn');
const { flattenPages } = require('./flow-client');
const { filesLookProtected } = require('./flow-policy');
const {
  promptFor, normalizeDiff, review, unavailable, claudeInvocation, codexBody, codexResult, claudeResult,
} = require('./transport');

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${name}=${value}\n`);
}

function emit(result) {
  const line = JSON.stringify(result);
  setOutput('result', line);
  process.stdout.write(`${line}\n`);
}

function fetchFiles(pr) {
  const result = gh([
    'api', '--paginate', '--slurp', `repos/${REPO}/pulls/${pr}/files?per_page=100`,
  ], process.env.READ_TOKEN);
  if (result.status !== 0) return { ok: false };
  const rows = flattenPages(result.stdout);
  if (!rows) return { ok: false };
  return { ok: true, files: rows };
}

function runClaude(prompt) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transport-'));
  const call = claudeInvocation(home);
  const result = spawnSync(call.command, call.args, {
    cwd: home,
    input: prompt,
    encoding: 'utf8',
    env: call.env,
    timeout: 8 * 60 * 1000,
  });
  fs.rmSync(home, { recursive: true, force: true });
  return claudeResult(result.status, result.stdout, result.stderr);
}

function runCodex(prompt) {
  const body = JSON.stringify(codexBody(prompt));
  return new Promise((resolve) => {
    const req = https.request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(codexResult(res.statusCode, Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', () => resolve({ failed: true, stdout: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ failed: true, stdout: '' });
    });
    req.end(body);
  });
}

async function main() {
  const provider = process.env.PROVIDER;
  const meta = {
    provider,
    pr: Number(process.env.PR_NUMBER),
    headSha: process.env.HEAD_SHA || '',
    runId: process.env.GITHUB_RUN_ID || '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '',
  };
  if (provider !== 'claude' && provider !== 'codex') {
    emit(unavailable(meta, 'provider'));
    return 0;
  }
  if (!sha40(meta.headSha) || !Number.isInteger(meta.pr) || meta.pr < 1) {
    emit(unavailable(meta, 'no-head'));
    return 0;
  }
  const secret = provider === 'claude' ? process.env.CLAUDE_CODE_OAUTH_TOKEN : process.env.OPENAI_API_KEY;
  if (!secret) {
    emit(unavailable(meta, 'missing-credential'));
    return 0;
  }
  const loaded = fetchFiles(meta.pr);
  if (!loaded.ok) {
    emit(unavailable(meta, 'diff-unreadable'));
    return 0;
  }
  if (filesLookProtected(loaded.files)) {
    emit(review(meta, { files: loaded.files }));
    return 0;
  }
  const ran = provider === 'claude'
    ? runClaude(promptFor(normalizeDiff(loaded.files)))
    : await runCodex(normalizeDiff(loaded.files));
  emit(review(meta, { ...ran, files: loaded.files, modelText: ran.stdout }));
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch(() => process.exit(1));
}

module.exports = { fetchFiles, runClaude, runCodex };
