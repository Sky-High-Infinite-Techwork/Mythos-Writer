'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseBuildArtifact,
  validateTrustedDiffAgainstClaim,
  validateDiffRow,
  failedChecksForFixRound,
  fullVerifyRequired,
  BUILD_ARTIFACT_SCHEMA,
  buildLaneRef,
} = require('./build-lane');
const { validateTrustedBuildGuard } = require('./build-lane-verify-run');
const { runPushBuildLane } = require('./build-lane-push-run');

const baseArtifact = {
  schema: BUILD_ARTIFACT_SCHEMA,
  status: 'ok',
  changedFiles: ['frontend/ok.ts'],
};

test('parseBuildArtifact rejects bad status and paths', () => {
  assert.equal(parseBuildArtifact(JSON.stringify({ ...baseArtifact, status: 'bad' })).ok, false);
  assert.equal(parseBuildArtifact(JSON.stringify({
    ...baseArtifact,
    changedFiles: ['../x'],
  })).ok, false);
  assert.equal(parseBuildArtifact(JSON.stringify({ ...baseArtifact })).ok, true);
});

test('trusted diff rejects path outside claim', () => {
  const diff = 'M\tfrontend/ok.ts\nA\tevil.ts';
  const check = validateTrustedDiffAgainstClaim(diff, ['frontend/ok.ts']);
  assert.equal(check.ok, false);
});

test('artifact cannot hide protected path in real diff', () => {
  const artifact = parseBuildArtifact(JSON.stringify({
    ...baseArtifact,
    changedFiles: ['frontend/ok.ts'],
  }));
  assert.equal(artifact.ok, true);
  const diff = 'M\tfrontend/ok.ts\nM\t.github/workflows/x.yml';
  const check = validateTrustedDiffAgainstClaim(diff, ['frontend/**']);
  assert.equal(check.ok, false);
});

test('in-slice trusted diff positive and rename guard', () => {
  const good = validateTrustedDiffAgainstClaim('M\tfrontend/ok.ts', ['frontend/**']);
  assert.equal(good.ok, true);
  const rename = validateTrustedDiffAgainstClaim('R100\told.ts\tfrontend/ok.ts', ['frontend/**']);
  assert.equal(rename.ok, false);
  const missingPrev = validateTrustedDiffAgainstClaim('R100\tfrontend/ok.ts', ['frontend/**']);
  assert.equal(missingPrev.reason, 'previous_filename');
  assert.equal(missingPrev.ok, false);
});

test('validateDiffRow rejects glob metacharacters and dot segments', () => {
  assert.equal(validateDiffRow({ status: 'M', filename: 'a?.ts' }).ok, false);
  assert.equal(validateDiffRow({ status: 'M', filename: 'a*.ts' }).ok, false);
  assert.equal(validateDiffRow({ status: 'M', filename: './a.ts' }).ok, false);
  assert.equal(validateDiffRow({ status: 'M', filename: 'a/../b.ts' }).ok, false);
  const renamed = validateDiffRow({
    status: 'renamed',
    filename: 'frontend/ok.ts',
    previous_filename: 'secret/*.ts',
  });
  assert.equal(renamed.ok, false);
});

test('runPushBuildLane holds on transport stub stdout', () => {
  const stub = JSON.stringify({
    schema: BUILD_ARTIFACT_SCHEMA,
    status: 'unavailable',
    changedFiles: [],
  });
  const held = runPushBuildLane({
    MAIN_SHA: 'a'.repeat(40),
    WRITE_TOKEN: 'token',
    BUILD_ARTIFACT_STDOUT: stub,
    cwd: process.cwd(),
  });
  assert.equal(held.ok, false);
  assert.equal(held.reason, 'build_hold_stub');
});

test('buildLaneRef names trusted refs per provider', () => {
  assert.equal(buildLaneRef('claude'), 'refs/mythos/build/claude');
  assert.equal(buildLaneRef('codex'), 'refs/mythos/build/codex');
});

test('validateTrustedBuildGuard fail closed cases', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const okArtifact = JSON.stringify({
    schema: BUILD_ARTIFACT_SCHEMA,
    status: 'ok',
    changedFiles: ['frontend/ok.ts'],
  });
  const gitRunner = (cmd, args) => {
    if (args[0] === 'cat-file') return '';
    if (args[0] === 'merge-base') {
      const err = new Error('not ancestor');
      err.status = 1;
      throw err;
    }
    if (args[0] === 'diff') return 'M\tfrontend/ok.ts';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const notAnc = validateTrustedBuildGuard({
    MODE: 'act',
    MAIN_SHA: base,
    BUILD_HEAD_SHA: head,
    CLAIM_FILES: '["frontend/ok.ts"]',
    BUILD_ARTIFACT_STDOUT: okArtifact,
  }, gitRunner);
  assert.equal(notAnc.reason, 'not_ancestor');

  const gitOk = (cmd, args) => {
    if (args[0] === 'cat-file') return '';
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'diff') return '';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const emptyDiff = validateTrustedBuildGuard({
    MODE: 'act',
    MAIN_SHA: base,
    BUILD_HEAD_SHA: head,
    CLAIM_FILES: '["frontend/ok.ts"]',
    BUILD_ARTIFACT_STDOUT: okArtifact,
  }, gitOk);
  assert.equal(emptyDiff.reason, 'empty_diff');

  const badStatus = validateTrustedBuildGuard({
    MODE: 'act',
    MAIN_SHA: base,
    BUILD_HEAD_SHA: head,
    CLAIM_FILES: '["frontend/ok.ts"]',
    BUILD_ARTIFACT_STDOUT: okArtifact,
  }, (cmd, args) => {
    if (args[0] === 'cat-file') return '';
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'diff') return 'X\tfrontend/ok.ts';
    throw new Error(`unexpected ${args.join(' ')}`);
  });
  assert.equal(badStatus.reason, 'status');

  const missing = validateTrustedBuildGuard({
    MODE: 'act',
    MAIN_SHA: 'short',
    BUILD_HEAD_SHA: head,
    CLAIM_FILES: '["frontend/ok.ts"]',
    BUILD_ARTIFACT_STDOUT: okArtifact,
  }, gitOk);
  assert.equal(missing.reason, 'missing_shas');
});

test('fix round tracks only failed checks', () => {
  const failed = failedChecksForFixRound({
    ci: { conclusion: 'failure' },
    'notes-windows': { conclusion: 'success' },
  }, ['ci', 'notes-windows', 'screenshot-check']);
  assert.deepEqual(failed, ['ci', 'screenshot-check']);
  assert.equal(fullVerifyRequired(['ci']), false);
  assert.equal(fullVerifyRequired([]), true);
  assert.deepEqual(failedChecksForFixRound({ ci: { conclusion: 'neutral' } }, ['ci']), ['ci']);
});