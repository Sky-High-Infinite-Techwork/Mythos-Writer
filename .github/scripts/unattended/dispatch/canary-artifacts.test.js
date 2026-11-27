'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluateCanaryOutcomes, canaryOutcomeArtifactName, canaryOutcomeArtifactPattern } = require('./canary-artifacts');

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

test('canary artifact names and download pattern are scoped to the run attempt', () => {
  assert.equal(canaryOutcomeArtifactName(2, 3), 'canary-outcome-2-3');
  assert.equal(canaryOutcomeArtifactPattern(2), 'canary-outcome-2-*');
});
