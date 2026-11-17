'use strict';

const {
  parseLaneCap,
  slotRef,
  claimRef,
  leaseMessage,
  parseLeaseMessage,
  isExpired,
  DEFAULT_LEASE_MINUTES,
  clampLeaseMinutes,
} = require('./constants');
const { refUpdateDelete, refUpdateRenew } = require('./refs-graphql');
const { globsOverlap } = require('./path-policy');

const REF_EXISTS = 'ref_exists';
const LANE_REF_RE = /^refs\/mythos\/dispatch\/lane-\d{2}$/;
const CLAIM_REF_RE = /^refs\/mythos\/dispatch\/claim\/\d+-\d+$/;

function isSweepableRef(ref) {
  return LANE_REF_RE.test(ref) || CLAIM_REF_RE.test(ref);
}

function buildLeasePayload(input, leaseMinutes = DEFAULT_LEASE_MINUTES) {
  const minutes = clampLeaseMinutes(leaseMinutes);
  const now = new Date();
  const expires = new Date(now.getTime() + minutes * 60 * 1000);
  return {
    issue: input.issue,
    slice: input.slice,
    planCommentId: input.planCommentId,
    planBodySha256: input.planBodySha256,
    files: input.files || [],
    runId: input.runId,
    runAttempt: input.runAttempt,
    claimedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

function parseLaneIndex(ref) {
  if (!ref || !ref.includes('/lane-')) return null;
  const match = String(ref).match(/lane-(\d{2})$/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

function activeLeasesAll(refs, now = new Date()) {
  const active = [];
  for (const row of refs || []) {
    const index = parseLaneIndex(row.ref);
    if (index == null) continue;
    const lease = parseLeaseMessage(row.message);
    if (!lease || isExpired(lease, now)) continue;
    active.push({ ...row, lease, slot: index });
  }
  return active;
}

function activeLeasesWithinCap(refs, cap, now = new Date()) {
  const parsed = parseLaneCap(cap);
  const limit = parsed.ok ? parsed.value : 0;
  return activeLeasesAll(refs, now).filter((row) => row.slot < limit);
}

function assertFilesDisjoint(files, activeLeases) {
  for (const live of activeLeases) {
    if (globsOverlap(files, live.lease.files)) {
      return { ok: false, reason: 'files_overlap', ref: live.ref };
    }
  }
  return { ok: true };
}

async function refOwnedBySha(client, ref, leaseSha) {
  const got = await client.getRef({ ref });
  if (!got.ok || !got.sha) return false;
  return got.sha === leaseSha;
}

async function releaseOursIfHeld(client, ref, leaseSha, reReadSwitch) {
  const got = await client.getRef({ ref });
  if (got.ok && got.sha === leaseSha) {
    return releaseRefCas(client, ref, leaseSha, reReadSwitch);
  }
  return { ok: true, skipped: true };
}

async function tryCreateRefPair(client, { laneRef, claimRef: claimRefName, leaseSha, recoverSameSha = false, reReadSwitch }) {
  if (reReadSwitch) {
    const sw = await reReadSwitch();
    if (!sw.ok || !sw.enabled) return { ok: false, fatal: true, reason: 'switch_off' };
  }
  const result = await client.createRefPair({ laneRef, claimRef: claimRefName, afterOid: leaseSha });
  if (result.ok) return { ok: true, laneRef, claimRef: claimRefName };
  if (result.refExists) {
    const claimGot = await client.getRef({ ref: claimRefName });
    if (claimGot.ok && claimGot.sha !== leaseSha) {
      return { ok: false, reason: 'slice_already_claimed' };
    }
    if (recoverSameSha) {
      const laneOurs = await refOwnedBySha(client, laneRef, leaseSha);
      const claimOurs = await refOwnedBySha(client, claimRefName, leaseSha);
      if (laneOurs && claimOurs) {
        return { ok: true, laneRef, claimRef: claimRefName, recovered: true };
      }
    }
    await releaseOursIfHeld(client, laneRef, leaseSha, reReadSwitch);
    await releaseOursIfHeld(client, claimRefName, leaseSha, reReadSwitch);
    return { ok: false, reason: REF_EXISTS, refExists: true };
  }
  if (result.fatal) return { ok: false, fatal: true, reason: result.error || 'update_refs_failed' };
  const laneOurs = await refOwnedBySha(client, laneRef, leaseSha);
  const claimOurs = await refOwnedBySha(client, claimRefName, leaseSha);
  if (recoverSameSha && laneOurs && claimOurs) {
    return { ok: true, laneRef, claimRef: claimRefName, recovered: true };
  }
  if (laneOurs) await releaseOursIfHeld(client, laneRef, leaseSha, reReadSwitch);
  if (claimOurs) await releaseOursIfHeld(client, claimRefName, leaseSha, reReadSwitch);
  return { ok: false, reason: result.error || 'create_failed', ambiguous: true };
}

function computeWouldClaimSlot(refs, cap, payload, now = new Date()) {
  const parsed = parseLaneCap(cap);
  if (!parsed.ok) return { ok: false, reason: 'invalid_lane_cap' };
  const allLive = activeLeasesAll(refs, now);
  if (allLive.length >= parsed.value) return { ok: false, reason: 'lane_full' };
  const disjoint = assertFilesDisjoint(payload.files, allLive);
  if (!disjoint.ok) return { ok: false, reason: disjoint.reason };
  const usedSlots = new Set(allLive.map((row) => row.slot));
  for (let index = 0; index < parsed.value; index += 1) {
    if (!usedSlots.has(index)) {
      return { ok: true, slot: index, laneCap: parsed.value };
    }
  }
  return { ok: false, reason: 'lane_full' };
}

async function claimLaneAndSlice(client, { cap, leaseSha, payload, recoverSameSha = false, reReadSwitch }) {
  const parsed = parseLaneCap(cap);
  if (!parsed.ok) return { ok: false, fatal: true, reason: 'invalid_lane_cap' };
  const limit = parsed.value;
  const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/' });
  if (!listed.ok) return { ok: false, fatal: true, reason: 'list_failed' };
  const allLive = activeLeasesAll(listed.refs);
  if (allLive.length >= limit) return { ok: false, reason: 'lane_full' };
  const disjoint = assertFilesDisjoint(payload.files, allLive);
  if (!disjoint.ok) return { ok: false, reason: disjoint.reason };
  const usedSlots = new Set(allLive.map((row) => row.slot));
  for (let index = 0; index < limit; index += 1) {
    if (usedSlots.has(index)) continue;
    const laneRef = slotRef(index);
    const claimRefName = claimRef(payload.issue, payload.slice);
    // eslint-disable-next-line no-await-in-loop
    const attempt = await tryCreateRefPair(client, {
      laneRef, claimRef: claimRefName, leaseSha, recoverSameSha, reReadSwitch,
    });
    if (attempt.ok) {
      return {
        ok: true,
        slot: index,
        ref: laneRef,
        claimRef: claimRefName,
        payload,
        message: leaseMessage(payload),
      };
    }
    if (attempt.fatal) return { ok: false, fatal: true, reason: attempt.reason };
    if (attempt.reason === 'slice_already_claimed') {
      return { ok: false, reason: 'slice_already_claimed' };
    }
    if (attempt.reason !== REF_EXISTS) return { ok: false, reason: attempt.reason };
  }
  return { ok: false, reason: 'lane_full' };
}

async function releaseRefCas(client, ref, beforeOid, reReadSwitch) {
  if (reReadSwitch) {
    const sw = await reReadSwitch();
    if (!sw.ok || !sw.enabled) return { ok: false, reason: 'switch_off' };
  }
  assertDispatchRefFromClaim(ref);
  const del = await client.deleteRef({ ref, beforeOid });
  if (!del.ok) return { ok: false, reason: del.error || 'delete_failed' };
  return { ok: true };
}

function assertDispatchRefFromClaim(ref) {
  if (!String(ref).startsWith('refs/mythos/dispatch/')) {
    throw new Error(`dispatch ref expected: ${ref}`);
  }
}

async function releaseClaimPair(client, { laneRef, claimRef: claimRefName, leaseSha }, reReadSwitch) {
  const results = [];
  for (const ref of [claimRefName, laneRef]) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await releaseRefCas(client, ref, leaseSha, reReadSwitch));
  }
  return results;
}

async function listDispatchRefs(client) {
  const listed = await client.listRefs({ prefix: 'refs/mythos/dispatch/' });
  if (!listed || !listed.ok) return { ok: false, refs: [] };
  return { ok: true, refs: listed.refs || [] };
}

async function sweepDispatchRefs(client, { now = new Date(), reReadSwitch } = {}) {
  const listed = await listDispatchRefs(client);
  if (!listed.ok) return { ok: false, deleted: [], errors: ['list_failed'] };
  const deleted = [];
  const errors = [];
  for (const row of listed.refs) {
    if (!isSweepableRef(row.ref)) continue;
    if (reReadSwitch) {
      // eslint-disable-next-line no-await-in-loop
      const sw = await reReadSwitch();
      if (!sw.ok || !sw.enabled) return { ok: false, deleted, errors: ['switch_off'], aborted: true };
    }
    const lease = parseLeaseMessage(row.message);
    const stale = !lease || isExpired(lease, now);
    if (!stale) continue;
    const ref = row.ref;
    // eslint-disable-next-line no-await-in-loop
    const del = await client.deleteRef({ ref, beforeOid: row.sha });
    if (del.ok) deleted.push(ref);
    else errors.push(ref);
  }
  return { ok: errors.length === 0, deleted, errors };
}

/** Renew lane + identity refs in one updateRefs to a new lease commit OID. */
async function renewLeaseHeartbeat(client, { laneRef, claimRef: claimRefName, newLeaseSha, beforeOid }, reReadSwitch) {
  if (reReadSwitch) {
    const sw = await reReadSwitch();
    if (!sw.ok || !sw.enabled) return { ok: false, reason: 'switch_off' };
  }
  const holder = await assertHolderBeforePublish(client, [laneRef, claimRefName], beforeOid);
  if (!holder.ok) return { ok: false, reason: holder.reason };
  const renew = client.renewRefPair
    ? await client.renewRefPair({ laneRef, claimRef: claimRefName, afterOid: newLeaseSha, beforeOid })
    : await client.updateRefs([
      refUpdateRenew(laneRef, newLeaseSha, beforeOid),
      refUpdateRenew(claimRefName, newLeaseSha, beforeOid),
    ]);
  if (!renew.ok) return { ok: false, reason: renew.error || 'renew_failed' };
  return { ok: true };
}

async function assertHolderBeforePublish(client, refs, leaseSha) {
  for (const ref of refs || []) {
    const got = await client.getRef({ ref });
    if (!got.ok || got.sha !== leaseSha) return { ok: false, reason: 'lease_mismatch', ref };
  }
  return { ok: true };
}

async function concurrentSlotRace(client, slotIndex, leaseSha, workers) {
  const ref = slotRef(slotIndex);
  const claimRefName = `${claimRef(0, 0)}-race`;
  const attempts = await Promise.all(
    Array.from({ length: workers }, () => tryCreateRefPair(client, { laneRef: ref, claimRef: claimRefName, leaseSha })),
  );
  const wins = attempts.filter((row) => row.ok);
  const refExists = attempts.filter((row) => row.refExists || row.reason === REF_EXISTS).length;
  const fatal = attempts.filter((row) => row.fatal).length;
  return { ref, winners: wins.length, attempts, refExists, fatal };
}

module.exports = {
  REF_EXISTS,
  isSweepableRef,
  buildLeasePayload,
  computeWouldClaimSlot,
  activeLeasesAll,
  activeLeasesWithinCap,
  assertFilesDisjoint,
  tryCreateRefPair,
  claimLaneAndSlice,
  releaseRefCas,
  releaseClaimPair,
  releaseOursIfHeld,
  listDispatchRefs,
  sweepDispatchRefs,
  renewLeaseHeartbeat,
  assertHolderBeforePublish,
  concurrentSlotRace,
};