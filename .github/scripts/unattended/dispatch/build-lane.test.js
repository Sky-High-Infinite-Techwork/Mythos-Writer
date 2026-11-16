'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseBuildArtifact,
  validateArtifactAgainstClaim,
  failedChecksForFixRound,
  fullVerifyRequired,
  BUILD_ARTIFACT_SCHEMA,
} = require('./build-lane');

test('validateArtifactAgainstClaim rejects out-of-slice paths', () => {
  const parsed = parseBuildArtifact(JSON.stringify({
    schema: BUILD_ARTIFACT_SCHEMA,
    changedFiles: ['frontend/ok.ts', 'evil.ts'],
  }));
  const check = validateArtifactAgainstClaim(parsed.artifact, ['frontend/ok.ts']);
  assert.equal(check.ok, false);
});

test('fix round tracks only failed checks', () => {
  const failed = failedChecksForFixRound({ ci: { conclusion: 'failure' }, 'notes-windows': { conclusion: 'success' } }, ['ci', 'notes-windows', 'screenshot-check']);
  assert.deepEqual(failed, ['ci', 'screenshot-check']);
  assert.equal(fullVerifyRequired(['ci']), false);
  assert.equal(fullVerifyRequired([]), true);
});