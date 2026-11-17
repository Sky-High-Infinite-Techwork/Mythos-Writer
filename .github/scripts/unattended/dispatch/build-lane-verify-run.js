'use strict';

const { execFileSync } = require('node:child_process');

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

function main() {
  const mainSha = String(process.env.MAIN_SHA || '').trim();
  const buildHead = String(process.env.BUILD_HEAD_SHA || process.env.GITHUB_SHA || '').trim();
  const artifactStdout = String(process.env.BUILD_ARTIFACT_STDOUT || '').trim()
    || require('node:fs').readFileSync(0, 'utf8');
  if (!mainSha || !buildHead) {
    console.error(JSON.stringify({ ok: false, reason: 'missing_shas' }));
    process.exit(1);
  }
  const parsedClaim = parseClaimFiles(process.env.CLAIM_FILES);
  if (!parsedClaim.ok) {
    console.error(JSON.stringify({ ok: false, reason: parsedClaim.reason }));
    process.exit(1);
  }
  const artifact = parseBuildArtifact(artifactStdout);
  if (!artifact.ok) {
    console.error(JSON.stringify({ ok: false, reason: artifact.reason || 'artifact' }));
    process.exit(1);
  }
  let nameStatus;
  try {
    nameStatus = execFileSync(
      'git',
      ['diff', '--name-status', '-M', `${mainSha}...${buildHead}`],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, reason: 'git_diff', detail: String(err.message || err) }));
    process.exit(1);
  }
  const check = validateTrustedDiffAgainstClaim(nameStatus, parsedClaim.files);
  if (!check.ok) {
    console.error(JSON.stringify({ ok: false, reason: check.reason }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, paths: check.rows?.length ?? 0 }));
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { parseClaimFiles, main };