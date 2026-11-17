'use strict';

const { execFileSync } = require('node:child_process');

const { OID_HEX } = require('./refs-graphql');
const { parseBuildArtifact, validateTrustedDiffAgainstClaim } = require('./build-lane');

function parseClaimFiles(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'claim_files' };
  if (text.startsWith('[')) {
    try {
      const list = JSON.parse(text);
      if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: 'claim_files' };
      return { ok: true, files: list };
    } catch {
      return { ok: false, reason: 'claim_files' };
    }
  }
  const files = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (files.length === 0) return { ok: false, reason: 'claim_files' };
  return { ok: true, files };
}

function gitExec(runner, args, options = {}) {
  const run = runner || ((cmd, params, opts) => execFileSync(cmd, params, opts));
  return run('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
}

function assertGitCommit(gitRunner, sha) {
  try {
    gitExec(gitRunner, ['cat-file', '-e', `${sha}^{commit}`]);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'not_commit' };
  }
}

function assertAncestor(gitRunner, baseSha, headSha) {
  try {
    const code = gitExec(gitRunner, ['merge-base', '--is-ancestor', baseSha, headSha]);
    if (code !== undefined && code !== '') {
      // execFileSync returns stdout; merge-base --is-ancestor exits 0 silently on success
    }
    return { ok: true };
  } catch (err) {
    if (err && err.status === 1) return { ok: false, reason: 'not_ancestor' };
    return { ok: false, reason: 'git_ancestor', detail: String(err.message || err) };
  }
}

function validateTrustedBuildGuard(env = {}, gitRunner) {
  const mode = String(env.MODE || 'act').trim().toLowerCase();
  const mainSha = String(env.MAIN_SHA || '').trim();
  const buildHead = String(env.BUILD_HEAD_SHA || '').trim();
  if (!OID_HEX.test(mainSha) || !OID_HEX.test(buildHead)) {
    return { ok: false, reason: 'missing_shas' };
  }
  const baseCheck = assertGitCommit(gitRunner, mainSha);
  if (!baseCheck.ok) return { ok: false, reason: 'invalid_base' };
  const headCheck = assertGitCommit(gitRunner, buildHead);
  if (!headCheck.ok) return { ok: false, reason: 'invalid_head' };
  const anc = assertAncestor(gitRunner, mainSha, buildHead);
  if (!anc.ok) return anc;

  const parsedClaim = parseClaimFiles(env.CLAIM_FILES);
  if (!parsedClaim.ok) {
    return { ok: false, reason: parsedClaim.reason };
  }

  const artifactStdout = String(env.BUILD_ARTIFACT_STDOUT || '').trim();
  const artifact = parseBuildArtifact(artifactStdout);
  if (!artifact.ok) {
    return { ok: false, reason: artifact.reason || 'artifact' };
  }

  let nameStatus;
  try {
    nameStatus = gitExec(
      gitRunner,
      ['diff', '--name-status', '-M', `${mainSha}...${buildHead}`],
    );
  } catch (err) {
    return { ok: false, reason: 'git_diff', detail: String(err.message || err) };
  }
  if (!String(nameStatus || '').trim()) {
    if (mode === 'act' || parsedClaim.files.length > 0) {
      return { ok: false, reason: 'empty_diff' };
    }
  }
  const check = validateTrustedDiffAgainstClaim(nameStatus, parsedClaim.files);
  if (!check.ok) return check;
  return { ok: true, paths: check.rows?.length ?? 0 };
}

function main() {
  const artifactStdout = String(process.env.BUILD_ARTIFACT_STDOUT || '').trim()
    || require('node:fs').readFileSync(0, 'utf8');
  const result = validateTrustedBuildGuard({
    MODE: process.env.MODE,
    MAIN_SHA: process.env.MAIN_SHA,
    BUILD_HEAD_SHA: process.env.BUILD_HEAD_SHA,
    CLAIM_FILES: process.env.CLAIM_FILES,
    BUILD_ARTIFACT_STDOUT: artifactStdout,
  });
  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, reason: result.reason, detail: result.detail }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, paths: result.paths }));
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { parseClaimFiles, validateTrustedBuildGuard, main };