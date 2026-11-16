'use strict';

const { diffWithinClaim } = require('./slice');
const { protectedPath } = require('./constants');

const BUILD_ARTIFACT_SCHEMA = 'mythos-build-artifact/v1';
const FIX_ROUND_PREFIX = 'mythos/fix-round';

function parseBuildArtifact(stdout) {
  if (!stdout) return { ok: false, reason: 'empty' };
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (!data || data.schema !== BUILD_ARTIFACT_SCHEMA) return { ok: false, reason: 'schema' };
  if (!Array.isArray(data.changedFiles)) return { ok: false, reason: 'files' };
  return { ok: true, artifact: data };
}

function validateArtifactAgainstClaim(artifact, claimFiles) {
  const guard = diffWithinClaim(
    artifact.changedFiles.map((name) => ({ filename: name })),
    claimFiles,
  );
  if (!guard.ok) return guard;
  for (const name of artifact.changedFiles) {
    if (protectedPath(name)) return { ok: false, reason: `protected path: ${name}` };
  }
  return { ok: true };
}

function failedChecksForFixRound(checks, required) {
  return (required || []).filter((name) => {
    const row = checks && checks[name];
    return !row || row.conclusion !== 'success';
  });
}

function fullVerifyRequired(failedFixChecks) {
  return (failedFixChecks || []).length === 0;
}

module.exports = {
  BUILD_ARTIFACT_SCHEMA,
  FIX_ROUND_PREFIX,
  parseBuildArtifact,
  validateArtifactAgainstClaim,
  failedChecksForFixRound,
  fullVerifyRequired,
};