'use strict';

const { diffWithinClaim } = require('./path-policy');

const BUILD_ARTIFACT_SCHEMA = 'mythos-build-artifact/v1';
const FIX_ROUND_PREFIX = 'mythos/fix-round';
const BUILD_REF_PREFIX = 'refs/mythos/build/';

const CLEAN_REL_PATH = /^[\w@./\-]+$/;

function buildLaneRef(provider) {
  const lane = String(provider || 'claude').trim().toLowerCase();
  if (lane !== 'claude' && lane !== 'codex') {
    throw new Error(`unsupported build lane: ${provider}`);
  }
  return `${BUILD_REF_PREFIX}${lane}`;
}

function pathSegmentsValid(relPath) {
  for (const seg of String(relPath || '').split('/')) {
    if (!seg || seg === '.' || seg === '..') return false;
  }
  return true;
}

function normalizeGitStatus(code) {
  const letter = String(code || '').charAt(0);
  switch (letter) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    default: return null;
  }
}

function validateDiffRow(row) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'row' };
  const status = row.status;
  if (!status || typeof status !== 'string') return { ok: false, reason: 'status' };
  const filename = row.filename;
  if (!filename || typeof filename !== 'string' || !filename.trim()) {
    return { ok: false, reason: 'path' };
  }
  if (
    !CLEAN_REL_PATH.test(filename)
    || filename.includes('..')
    || filename.startsWith('/')
    || filename.includes('\\')
    || !pathSegmentsValid(filename)
    || filename.includes('*')
    || filename.includes('?')
  ) {
    return { ok: false, reason: 'path' };
  }
  const normalized = normalizeGitStatus(status) || (['added', 'modified', 'deleted', 'renamed', 'copied'].includes(status) ? status : null);
  if (!normalized) return { ok: false, reason: 'status' };
  if (normalized === 'renamed') {
    const prev = row.previous_filename;
    if (!prev || typeof prev !== 'string' || !prev.trim()) {
      return { ok: false, reason: 'previous_filename' };
    }
    if (
      !CLEAN_REL_PATH.test(prev)
      || prev.includes('..')
      || prev.startsWith('/')
      || prev.includes('\\')
      || !pathSegmentsValid(prev)
      || prev.includes('*')
      || prev.includes('?')
    ) {
      return { ok: false, reason: 'path' };
    }
  }
  return {
    ok: true,
    row: {
      filename,
      status: normalized,
      previous_filename: normalized === 'renamed' ? row.previous_filename : (row.previous_filename || ''),
    },
  };
}

function parseGitNameStatusOutput(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 2) return { ok: false, reason: 'parse' };
    const code = parts[0];
    let candidate;
    if (code.startsWith('R') && parts.length >= 3) {
      candidate = { status: 'renamed', previous_filename: parts[1], filename: parts[2] };
    } else {
      const status = normalizeGitStatus(code);
      if (!status) return { ok: false, reason: 'status' };
      candidate = { status, filename: parts[parts.length - 1], previous_filename: '' };
    }
    const check = validateDiffRow(candidate);
    if (!check.ok) return check;
    rows.push(check.row);
  }
  return { ok: true, rows };
}

function validateTrustedDiffAgainstClaim(nameStatusOutput, claimFiles) {
  const parsed = parseGitNameStatusOutput(nameStatusOutput);
  if (!parsed.ok) return parsed;
  return diffWithinClaim(parsed.rows, claimFiles);
}

function parseBuildArtifact(stdout) {
  if (!stdout) return { ok: false, reason: 'empty' };
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (!data || data.schema !== BUILD_ARTIFACT_SCHEMA) return { ok: false, reason: 'schema' };
  if (data.status !== 'ok') return { ok: false, reason: 'status' };
  if (!Array.isArray(data.changedFiles)) return { ok: false, reason: 'files' };
  for (const name of data.changedFiles) {
    if (typeof name !== 'string' || !name.trim()) return { ok: false, reason: 'path' };
    if (
      !CLEAN_REL_PATH.test(name)
      || name.includes('..')
      || name.startsWith('/')
      || name.includes('\\')
      || !pathSegmentsValid(name)
      || name.includes('*')
      || name.includes('?')
    ) {
      return { ok: false, reason: 'path' };
    }
  }
  return { ok: true, artifact: data };
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
  BUILD_REF_PREFIX,
  FIX_ROUND_PREFIX,
  buildLaneRef,
  pathSegmentsValid,
  parseBuildArtifact,
  parseGitNameStatusOutput,
  validateDiffRow,
  validateTrustedDiffAgainstClaim,
  failedChecksForFixRound,
  fullVerifyRequired,
};