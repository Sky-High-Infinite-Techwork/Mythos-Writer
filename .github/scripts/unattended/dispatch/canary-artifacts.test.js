'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluateCanaryOutcomes } = require('./canary-artifacts');

test('evaluateCanaryOutcomes requires exactly one win and five loses', () => {
  const okRows = Array.from({ length: 6 }, (_, i) => ({
    index: i,
    kind: i === 0 ? 'canary_win' : 'canary_lose',
  }));
  assert.equal(evaluateCanaryOutcomes(okRows).ok, true);

  const oneWinFiveFatals = [
    { index: 0, kind: 'canary_win' },
    ...[1, 2, 3, 4, 5].map((i) => ({ index: i, kind: 'canary_fatal' })),
  ];
  const scored = evaluateCanaryOutcomes(oneWinFiveFatals);
  assert.equal(scored.ok, false);
  assert.equal(scored.reason, 'counts');
  assert.equal(scored.wins, 1);
  assert.equal(scored.fatals, 5);
});