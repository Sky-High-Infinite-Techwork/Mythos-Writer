'use strict';

const {
  clampLaneCap,
  slotRef,
  claimRef,
  leaseMessage,
  parseLeaseMessage,
  isExpired,
  DEFAULT_LEASE_MINUTES,
} = require('./constants');

const REF_EXISTS = 'ref_exists';

function buildLeasePayload(input, leaseMinutes = DEFAULT_LEASE_MINUTES) {
  const now = new Date();
  const expires = new Date(now.getTime() + leaseMinutes * 60 * 1000);
  return {
    issue: input.issue,
    slice: input.slice,
    planCommentId: input.planCommentId,
    planBodySha256: input.planBodySha256,
    runId: input.runId,
    runAttempt: input.runAttempt,
    claimedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

async function tryCreateRef(client, ref, sha) {
  const result = await client.createRef({ ref, sha });
  if (result && result.ok) return { ok: true, ref };
  if (result && result.status === 422) return { ok: false, reason: REF_EXISTS };
  return { ok: false, reason: result && result.error || 'create_failed' };
}

async function claimLaneSlot(client, { cap, leaseSha, payload }) {
  const limit = clampLaneCap(cap);
  for (let index = 0; index < limit; index += 1) {
    const ref = slotRef(index);
    // eslint-disable-next-line no-await-in-loop
    const attempt = await tryCreateRef(client, ref, leaseSha);
    if (attempt.ok) {
      return { ok: true, slot: index, ref, payload, message: leaseMessage(payload) };
    }
    if (attempt.reason !== REF_EXISTS) return { ok: false, reason: attempt.reason };
  }
  return { ok: false, reason: 'lane_full' };
}

async function claimSliceIdentity(client, { issue, slice, planBodySha256, leaseSha }) {
  const ref = claimRef(issue, slice, planBodySha256);
  const attempt = await tryCreateRef(client, ref, leaseSha);
  if (attempt.ok) return { ok: true, ref };
  if (attempt.reason === REF_EXISTS) return { ok: false, reason: 'slice_already_claimed' };
  return { ok: false, reason: attempt.reason };
}

async function releaseRefs(client, refs) {
  const results = [];
  for (const ref of refs || []) {
    // eslint-disable-next-line no-await-in-loop
    results.push({ ref, ...(await client.deleteRef({ ref })) });
  }
  return results;
}

async function listDispatchRefs(client) {
  const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/' });
  if (!listed || !listed.ok) return { ok: false, refs: [] };
  return { ok: true, refs: listed.refs || [] };
}

async function sweepExpiredLeases(client, { now = new Date() } = {}) {
  const listed = await listDispatchRefs(client);
  if (!listed.ok) return { ok: false, deleted: [], errors: ['list_failed'] };
  const deleted = [];
  const errors = [];
  for (const row of listed.refs) {
    const lease = parseLeaseMessage(row.message);
    if (!lease) continue;
    if (!isExpired(lease, now)) continue;
    const ref = row.ref;
    // eslint-disable-next-line no-await-in-loop
    const del = await client.deleteRef({ ref });
    if (del && del.ok) deleted.push(ref);
    else errors.push(ref);
  }
  return { ok: errors.length === 0, deleted, errors };
}

async function concurrentSlotRace(client, slotIndex, leaseSha, workers) {
  const ref = slotRef(slotIndex);
  const attempts = await Promise.all(
    Array.from({ length: workers }, () => tryCreateRef(client, ref, leaseSha)),
  );
  const wins = attempts.filter((row) => row.ok);
  return { ref, winners: wins.length, attempts };
}

module.exports = {
  REF_EXISTS,
  buildLeasePayload,
  tryCreateRef,
  claimLaneSlot,
  claimSliceIdentity,
  releaseRefs,
  listDispatchRefs,
  sweepExpiredLeases,
  concurrentSlotRace,
};