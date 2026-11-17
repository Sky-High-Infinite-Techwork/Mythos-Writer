'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseBuildArtifact,
  validateTrustedDiffAgainstClaim,
  failedChecksForFixRound,
  fullVerifyRequired,
  BUILD_ARTIFACT_SCHEMA,
} = require('./build-lane');

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