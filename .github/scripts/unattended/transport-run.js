'use strict';

const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO, sha40 } = require('./constants');
const { gh } = require('./spawn');
const { filesLookProtected } = require('./flow-policy');
const {
  assessDiff, readCompare, userDiff, review, unavailable, claudeInvocation, codexBody, codexResult, claudeResult,
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

function comparePath(baseSha, headSha) {
  if (!sha40(baseSha) || !sha40(headSha)) return null;
  return `repos/${REPO}/compare/${baseSha}...${headSha}`;
}

function fetchCompare(baseSha, headSha) {
  const route = comparePath(baseSha, headSha);
  if (!route) return { ok: false };
  const result = gh(['api', route], process.env.READ_TOKEN);
  if (result.status !== 0) return { ok: false };
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return { ok: false };
  }
  const read = readCompare(body, baseSha, headSha);
  if (!read.ok) return { ok: false, reason: read.reason, body, files: body.files };
  return { ok: true, files: read.files, body };
}

function runClaude(diffText) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transport-'));
  const call = claudeInvocation(home);
  fs.writeFileSync(call.systemPromptFile, call.systemPrompt);
  const result = spawnSync(call.command, call.args, {
    cwd: home,
    input: userDiff(diffText),
    encoding: 'utf8',
    env: call.env,
    timeout: 8 * 60 * 1000,
  });
  fs.rmSync(home, { recursive: true, force: true });
  return claudeResult(result.status, result.stdout, result.stderr);
}

function runCodex(diffText) {
  const body = JSON.stringify(codexBody(diffText));
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
    baseSha: process.env.BASE_SHA || '',
    runId: process.env.GITHUB_RUN_ID || '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '',
  };
  if (provider !== 'claude' && provider !== 'codex') {
    emit(unavailable(meta, 'provider'));
    return 0;
  }
  if (!sha40(meta.headSha) || !sha40(meta.baseSha) || !Number.isInteger(meta.pr) || meta.pr < 1) {
    emit(unavailable(meta, 'no-head'));
    return 0;
  }
  const secret = provider === 'claude' ? process.env.CLAUDE_CODE_OAUTH_TOKEN : process.env.OPENAI_API_KEY;
  if (!secret) {
    emit(unavailable(meta, 'missing-credential'));
    return 0;
  }
  const loaded = fetchCompare(meta.baseSha, meta.headSha);
  if (!loaded.ok) {
    if (loaded.body) emit(review(meta, { compare: loaded.body }));
    else emit(unavailable(meta, 'diff-unreadable'));
    return 0;
  }
  const diff = assessDiff(loaded.files);
  if (!diff.ok || filesLookProtected(loaded.files)) {
    emit(review(meta, { compare: loaded.body, files: loaded.files }));
    return 0;
  }
  const ran = provider === 'claude' ? runClaude(diff.text) : await runCodex(diff.text);
  emit(review(meta, { ...ran, compare: loaded.body, modelText: ran.stdout }));
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch(() => process.exit(1));
}

module.exports = { comparePath, fetchCompare, runClaude, runCodex };
