'use strict';

const {
  parseLaneCap,
  slotRef,
  claimRef,
} = require('./constants');
const {
  REF_EXISTS,
  tryCreateRefPair,
  assertHolderBeforePublish,
} = require('./claim');
const { refUpdateRenew } = require('./refs-graphql');
const { activeLeasesAll } = require('./claim');

function activeLeasesWithinCap(refs, cap, now = new Date()) {
  const parsed = parseLaneCap(cap);
  const limit = parsed.ok ? parsed.value : 0;
  return activeLeasesAll(refs, now).filter((row) => row.slot < limit);
}

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
  activeLeasesWithinCap,
  renewLeaseHeartbeat,
  concurrentSlotRace,
};