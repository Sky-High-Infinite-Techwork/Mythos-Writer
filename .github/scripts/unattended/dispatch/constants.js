'use strict';

const { REPO, protectedPath, ownerPath } = require('../constants');
const crypto = require('node:crypto');

const DISPATCH_REF_PREFIX = 'refs/mythos/dispatch';
const MATCHING_REF_PREFIX = 'mythos/dispatch/';
const LANE_SLOT_MAX = 20;
const DEFAULT_LANE_CAP = 5;
const MIN_LEASE_MINUTES = 30;
const MAX_LEASE_MINUTES = 360;
/** Exceeds longest dispatch job (15m) + margin. */
const DEFAULT_LEASE_MINUTES = 180;
const LEASE_SCHEMA = 'mythos-dispatch-lease/v1';
const MAX_DISPATCH_ATTEMPTS = 5;
const ZERO_OID = '0000000000000000000000000000000000000000';

const OFFICIAL_PLAN_AUTHORS = new Set(['skyyplayz', 'skyhigh-mythos-bot']);
const OFFICIAL_FILES_HEADING = '## Files';

function parseLaneCap(raw) {
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!text || !/^\d+$/.test(text)) return { ok: false, value: null };
  const n = parseInt(text, 10);
  if (n < 1 || n > LANE_SLOT_MAX) return { ok: false, value: null };
  return { ok: true, value: n };
}

function clampLeaseMinutes(raw) {
  const n = parseInt(String(raw || DEFAULT_LEASE_MINUTES), 10);
  if (!Number.isFinite(n)) return DEFAULT_LEASE_MINUTES;
  return Math.min(MAX_LEASE_MINUTES, Math.max(MIN_LEASE_MINUTES, n));
}

function slotRef(index) {
  const ii = String(index).padStart(2, '0');
  return `${DISPATCH_REF_PREFIX}/lane-${ii}`;
}

function claimRef(issueNumber, sliceIndex) {
  return `${DISPATCH_REF_PREFIX}/claim/${issueNumber}-${sliceIndex}`;
}

function attemptsRef(issueNumber, sliceIndex) {
  return `${DISPATCH_REF_PREFIX}/attempts/${issueNumber}-${sliceIndex}`;
}

function doneRef(issueNumber, sliceIndex) {
  return `${DISPATCH_REF_PREFIX}/done/${issueNumber}-${sliceIndex}`;
}

function scratchCanaryRef(matrixIndex) {
  return `${DISPATCH_REF_PREFIX}/canary/scratch-${matrixIndex}`;
}

const CANARY_SCRATCH_SHARED_REF = `${DISPATCH_REF_PREFIX}/canary/scratch-shared`;

function protectedLiteralPrefix(literal) {
  const pre = String(literal || '');
  if (!pre) return true;
  if (protectedPath(pre) || ownerPath(pre)) return true;
  if (protectedPath(`${pre}/x.ts`)) return true;
  if (pre.startsWith('.github') || pre.includes('/.github/')) return true;
  if (/^\.git/.test(pre) && !pre.startsWith('.github')) return true;
  return false;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function leaseMessage(payload) {
  return JSON.stringify({ schema: LEASE_SCHEMA, ...payload });
}

function parseLeaseMessage(message) {
  if (!message) return null;
  try {
    const data = JSON.parse(message);
    if (!data || data.schema !== LEASE_SCHEMA) return null;
    if (!Number.isInteger(data.issue) || data.issue < 1) return null;
    if (!Number.isInteger(data.slice) || data.slice < 0) return null;
    if (!Array.isArray(data.files)) return null;
    if (!data.expiresAt || Number.isNaN(Date.parse(data.expiresAt))) return null;
    return data;
  } catch {
    return null;
  }
}

function isExpired(lease, now = new Date()) {
  if (!lease || !lease.expiresAt) return true;
  return Date.parse(lease.expiresAt) <= now.getTime();
}

module.exports = {
  REPO,
  DISPATCH_REF_PREFIX,
  MATCHING_REF_PREFIX,
  LANE_SLOT_MAX,
  DEFAULT_LANE_CAP,
  MIN_LEASE_MINUTES,
  MAX_LEASE_MINUTES,
  DEFAULT_LEASE_MINUTES,
  LEASE_SCHEMA,
  MAX_DISPATCH_ATTEMPTS,
  ZERO_OID,
  OFFICIAL_PLAN_AUTHORS,
  OFFICIAL_FILES_HEADING,
  parseLaneCap,
  clampLeaseMinutes,
  slotRef,
  claimRef,
  attemptsRef,
  doneRef,
  scratchCanaryRef,
  CANARY_SCRATCH_SHARED_REF,
  protectedLiteralPrefix,
  sha256Hex,
  leaseMessage,
  parseLeaseMessage,
  isExpired,
  protectedPath,
  ownerPath,
};