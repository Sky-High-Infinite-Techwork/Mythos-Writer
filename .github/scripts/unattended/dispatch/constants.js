'use strict';

const { REPO, protectedPath } = require('../constants');
const crypto = require('node:crypto');

const DISPATCH_REF_PREFIX = 'refs/mythos/dispatch';
const LANE_SLOT_MAX = 20;
const DEFAULT_LANE_CAP = 5;
const DEFAULT_LEASE_MINUTES = 120;
const LEASE_SCHEMA = 'mythos-dispatch-lease/v1';

const OFFICIAL_PLAN_AUTHORS = new Set(['skyyplayz', 'skyhigh-mythos-bot']);
const OFFICIAL_FILES_HEADING = '## Files';

function clampLaneCap(raw) {
  const n = parseInt(String(raw || DEFAULT_LANE_CAP), 10);
  if (!Number.isFinite(n)) return DEFAULT_LANE_CAP;
  return Math.min(LANE_SLOT_MAX, Math.max(1, n));
}

function slotRef(index) {
  const ii = String(index).padStart(2, '0');
  return `${DISPATCH_REF_PREFIX}/lane-${ii}`;
}

function claimRef(issueNumber, sliceIndex, planBodySha256) {
  const prefix = String(planBodySha256 || '').slice(0, 12);
  return `${DISPATCH_REF_PREFIX}/claim/${issueNumber}-${sliceIndex}-${prefix}`;
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
  LANE_SLOT_MAX,
  DEFAULT_LANE_CAP,
  DEFAULT_LEASE_MINUTES,
  LEASE_SCHEMA,
  OFFICIAL_PLAN_AUTHORS,
  OFFICIAL_FILES_HEADING,
  clampLaneCap,
  slotRef,
  claimRef,
  sha256Hex,
  leaseMessage,
  parseLeaseMessage,
  isExpired,
  protectedPath,
};