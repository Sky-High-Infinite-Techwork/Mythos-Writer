'use strict';

const {
  attemptsRef,
  doneRef,
  MAX_DISPATCH_ATTEMPTS,
} = require('./constants');
const { ZERO_OID } = require('./constants');

const ATTEMPTS_SCHEMA = 'mythos-dispatch-attempts/v1';

function attemptsMessage({ count, lastAttemptAt }) {
  return JSON.stringify({
    schema: ATTEMPTS_SCHEMA,
    count,
    lastAttemptAt,
  });
}

function parseAttemptsMessage(message) {
  if (!message) return null;
  try {
    const data = JSON.parse(message);
    if (!data || data.schema !== ATTEMPTS_SCHEMA) return null;
    if (!Number.isInteger(data.count) || data.count < 0) return null;
    if (!data.lastAttemptAt || Number.isNaN(Date.parse(data.lastAttemptAt))) return null;
    return data;
  } catch {
    return null;
  }
}

/** Exponential backoff minutes capped at 6h. */
function backoffMinutesForCount(count) {
  if (count <= 0) return 0;
  const exp = Math.min(count, 8);
  return Math.min(360, Math.max(1, 2 ** exp));
}

function inBackoff(attempts, now = new Date()) {
  if (!attempts || attempts.count <= 0) return { inBackoff: false };
  if (attempts.count >= MAX_DISPATCH_ATTEMPTS) {
    return { inBackoff: true, reason: 'max_attempts' };
  }
  const waitMin = backoffMinutesForCount(attempts.count);
  const last = Date.parse(attempts.lastAttemptAt);
  const elapsedMin = (now.getTime() - last) / 60000;
  if (elapsedMin < waitMin) {
    return { inBackoff: true, reason: 'backoff', waitMinutes: waitMin - elapsedMin };
  }
  return { inBackoff: false };
}

async function readAttemptsState(client, issue, slice) {
  const ref = attemptsRef(issue, slice);
  const got = await client.getRef({ ref });
  if (!got.ok) {
    if (got.status === 404) return { ok: true, attempts: null };
    return { ok: false, reason: 'attempts_read_failed' };
  }
  const attempts = parseAttemptsMessage(got.message);
  if (!attempts) return { ok: false, reason: 'attempts_unparseable' };
  return { ok: true, attempts, ref, sha: got.sha };
}

async function sliceDone(client, issue, slice) {
  const ref = doneRef(issue, slice);
  const got = await client.getRef({ ref });
  if (!got.ok) {
    if (got.status === 404) return { done: false };
    return { ok: false, reason: 'done_read_failed' };
  }
  return { done: true };
}

async function assessSliceProgress(client, issue, slice, now = new Date()) {
  const done = await sliceDone(client, issue, slice);
  if (done.ok === false) return { ok: false, reason: done.reason };
  if (done.done) return { ok: false, hold: true, reason: 'slice_done' };
  const read = await readAttemptsState(client, issue, slice);
  if (!read.ok) return { ok: false, reason: read.reason };
  const backoff = inBackoff(read.attempts, now);
  if (backoff.inBackoff) {
    return { ok: false, hold: true, reason: backoff.reason, waitMinutes: backoff.waitMinutes };
  }
  return { ok: true, attempts: read.attempts, attemptsRef: read.ref, attemptsSha: read.sha };
}

async function recordDispatchAttempt(client, issue, slice, options = {}) {
  const { reReadSwitch } = options;
  if (reReadSwitch) {
    const sw = await reReadSwitch();
    if (!sw.ok || !sw.enabled) return { ok: false, reason: 'switch_off' };
  }
  const ref = attemptsRef(issue, slice);
  const now = new Date().toISOString();
  const existing = await client.getRef({ ref });
  let count = 0;
  let beforeOid = ZERO_OID;
  if (existing.ok) {
    const parsed = parseAttemptsMessage(existing.message);
    count = parsed ? parsed.count + 1 : 1;
    beforeOid = existing.sha;
  } else if (existing.status !== 404) {
    return { ok: false, reason: 'attempts_read_failed' };
  } else {
    count = 1;
  }
  const message = attemptsMessage({ count, lastAttemptAt: now });
  let oid;
  if (typeof options.mintLeaseSha === 'function') {
    oid = await options.mintLeaseSha(message);
    if (!oid) return { ok: false, reason: 'attempts_commit_failed' };
  } else {
    oid = `a${String(count).padStart(39, '0')}`;
  }
  if (client.setRefMessage) client.setRefMessage(ref, message);
  const upd = beforeOid === ZERO_OID
    ? await client.createRef({ ref, sha: oid })
    : await client.renewRef({ ref, newOid: oid, beforeOid });
  if (!upd.ok) return { ok: false, reason: upd.error || 'attempts_write_failed' };
  return { ok: true, count };
}

function releaseResultsOk(results) {
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every((row) => row && row.ok);
}

module.exports = {
  ATTEMPTS_SCHEMA,
  attemptsMessage,
  parseAttemptsMessage,
  backoffMinutesForCount,
  inBackoff,
  assessSliceProgress,
  recordDispatchAttempt,
  releaseResultsOk,
};