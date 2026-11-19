'use strict';

const { execFileSync } = require('node:child_process');

const { REPO } = require('./constants');
const { buildLaneRef, parseBuildArtifact } = require('./build-lane');
const { gh } = require('../spawn');
const { OID_HEX } = require('./refs-graphql');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function pushBuildRef({ repo, writeToken, ref, sha }) {
  const parts = String(repo).split('/');
  if (parts.length !== 2) return { ok: false, reason: 'repo' };
  const suffix = ref.startsWith('refs/') ? ref.slice('refs/'.length) : ref;
  const apiPath = `repos/${parts[0]}/${parts[1]}/git/refs/${encodeURIComponent(suffix)}`;
  const created = gh(
    ['api', `repos/${parts[0]}/${parts[1]}/git/refs`, '-f', `ref=${ref}`, '-f', `sha=${sha}`],
    writeToken,
  );
  if (created.status === 0) return { ok: true, sha };
  const patched = gh(['api', '-X', 'PATCH', apiPath, '-f', `sha=${sha}`, '-f', 'force=true'], writeToken);
  if (patched.status !== 0) {
    return { ok: false, reason: 'ref_push', detail: patched.stderr || patched.stdout || created.stderr };
  }
  return { ok: true, sha };
}

function runPushBuildLane(env = {}) {
  const repo = env.REPO || REPO;
  const mainSha = String(env.MAIN_SHA || '').trim();
  const provider = String(env.BUILD_PROVIDER || 'claude').trim().toLowerCase();
  const writeToken = String(env.WRITE_TOKEN || '');
  const cwd = env.cwd || process.cwd();
  const artifactStdout = String(env.BUILD_ARTIFACT_STDOUT || '').trim();

  if (!OID_HEX.test(mainSha)) return { ok: false, reason: 'missing_main_sha' };
  if (!writeToken) return { ok: false, reason: 'missing_write_token' };

  const artifact = parseBuildArtifact(artifactStdout);
  if (!artifact.ok) return { ok: false, reason: 'build_hold_stub' };

  const status = git(['status', '--porcelain'], cwd);
  if (!String(status || '').trim()) {
    return { ok: false, reason: 'build_hold_empty_worktree' };
  }

  git(['add', '-A'], cwd);
  git(['commit', '-m', `mythos build lane ${provider}`], cwd);
  const head = git(['rev-parse', 'HEAD'], cwd).trim();
  if (!OID_HEX.test(head)) return { ok: false, reason: 'bad_head' };

  const buildRef = buildLaneRef(provider);
  const pushed = pushBuildRef({ repo, writeToken, ref: buildRef, sha: head });
  if (!pushed.ok) return pushed;
  return { ok: true, build_head: head, build_ref: buildRef };
}

function main() {
  const artifactStdout = String(process.env.BUILD_ARTIFACT_STDOUT || '').trim()
    || require('node:fs').readFileSync(0, 'utf8');
  const result = runPushBuildLane({
    REPO: process.env.REPO,
    MAIN_SHA: process.env.MAIN_SHA,
    BUILD_PROVIDER: process.env.BUILD_PROVIDER,
    WRITE_TOKEN: process.env.WRITE_TOKEN,
    BUILD_ARTIFACT_STDOUT: artifactStdout,
  });
  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, reason: result.reason, detail: result.detail }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, build_head: result.build_head, build_ref: result.build_ref }));
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { runPushBuildLane, pushBuildRef, main };