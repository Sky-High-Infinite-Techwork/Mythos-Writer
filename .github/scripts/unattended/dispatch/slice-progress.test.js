'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  backoffMinutesForCount,
  inBackoff,
  recordDispatchAttempt,
  attemptsMessage,
} = require('./slice-progress');
const { createMockRefClient } = require('./mock-client');
const { attemptsRef, MAX_DISPATCH_ATTEMPTS } = require('./constants');

test('backoffMinutesForCount grows exponentially and caps at six hours', () => {
  assert.equal(backoffMinutesForCount(0), 0);
  assert.equal(backoffMinutesForCount(1), 2);
  assert.equal(backoffMinutesForCount(3), 8);
  assert.equal(backoffMinutesForCount(8), 256);
  assert.equal(backoffMinutesForCount(20), 256);
  assert.equal(backoffMinutesForCount(9), 256);
});

test('inBackoff respects elapsed boundary and max attempts', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const justReady = inBackoff(
    { count: 1, lastAttemptAt: '2026-06-01T11:58:00.000Z' },
    now,
  );
  assert.equal(justReady.inBackoff, false);

  const stillWaiting = inBackoff(
    { count: 1, lastAttemptAt: '2026-06-01T11:59:30.000Z' },
    now,
  );
  assert.equal(stillWaiting.inBackoff, true);
  assert.equal(stillWaiting.reason, 'backoff');
  assert.ok(stillWaiting.waitMinutes > 0 && stillWaiting.waitMinutes < 2);

  const maxed = inBackoff(
    { count: MAX_DISPATCH_ATTEMPTS, lastAttemptAt: '2020-01-01T00:00:00.000Z' },
    now,
  );
  assert.equal(maxed.inBackoff, true);
  assert.equal(maxed.reason, 'max_attempts');
});

test('recordDispatchAttempt fails closed without mintLeaseSha', async () => {
  const client = createMockRefClient();
  const noMint = await recordDispatchAttempt(client, 1, 0, {});
  assert.equal(noMint.ok, false);
  assert.equal(noMint.reason, 'attempts_commit_failed');
  const ref = attemptsRef(1, 0);
  assert.equal(client.exists(ref), false);
});

test('recordDispatchAttempt succeeds with mintLeaseSha', async () => {
  const client = createMockRefClient();
  const ok = await recordDispatchAttempt(client, 2, 0, {
    mintLeaseSha: async () => 'a'.repeat(40),
  });
  assert.equal(ok.ok, true);
  const ref = attemptsRef(2, 0);
  assert.equal(client.exists(ref), true);
  const got = await client.getRef({ ref });
  assert.match(got.message, /"count":1/);
});