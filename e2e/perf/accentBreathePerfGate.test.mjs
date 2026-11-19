// Pinned ABBA gate math (fail-closed). Run: node --test e2e/perf/accentBreathePerfGate.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ABBA_DROP_DELTA_MAX_PP,
  evaluateAbbaBreathePerfGate,
} from './accentBreathePerfGate.ts';

const neutralFps = {
  pair1Fps: { onP95Fps: 59.5, offP95Fps: 59.9 },
  pair2Fps: { onP95Fps: 59.5, offP95Fps: 59.9 },
};

test('Critic fail-open example: one stalled OFF hides ON regression → FAIL', () => {
  const gate = evaluateAbbaBreathePerfGate({
    pair1Drop: { onDroppedPct: 6, offDroppedPct: 5 },
    pair2Drop: { onDroppedPct: 7, offDroppedPct: 0 },
    ...neutralFps,
  });
  assert.equal(gate.passesDropGate, false);
  assert.ok(gate.dropDeltaPp > ABBA_DROP_DELTA_MAX_PP);
});

test('elevated OFF baseline 3.9/3.9 hides ON 5.8pp via low delta → FAIL (stalled)', () => {
  const gate = evaluateAbbaBreathePerfGate({
    pair1Drop: { onDroppedPct: 5.8, offDroppedPct: 3.9 },
    pair2Drop: { onDroppedPct: 5.8, offDroppedPct: 3.9 },
    ...neutralFps,
  });
  assert.equal(gate.baselineStalled, true);
  assert.equal(gate.passesDropGate, false);
  assert.ok(gate.dropDeltaPp <= ABBA_DROP_DELTA_MAX_PP);
});

test('pre-#1774 ON regression with clean OFF windows → FAIL (drop bar)', () => {
  const gate = evaluateAbbaBreathePerfGate({
    pair1Drop: { onDroppedPct: 5.8, offDroppedPct: 0.2 },
    pair2Drop: { onDroppedPct: 7.1, offDroppedPct: 0.3 },
    ...neutralFps,
  });
  assert.equal(gate.baselineStalled, false);
  assert.equal(gate.passesDropGate, false);
});

test('pre-#1774 ON regression with one high OFF but min OFF clean → FAIL (drop bar)', () => {
  const gate = evaluateAbbaBreathePerfGate({
    pair1Drop: { onDroppedPct: 5.8, offDroppedPct: 0.2 },
    pair2Drop: { onDroppedPct: 7.1, offDroppedPct: 6 },
    ...neutralFps,
  });
  assert.equal(gate.baselineStalled, false);
  assert.equal(gate.passesDropGate, false);
});

test('clean OFF windows + modest ON deltas → PASS', () => {
  const gate = evaluateAbbaBreathePerfGate({
    pair1Drop: { onDroppedPct: 1.2, offDroppedPct: 0.2 },
    pair2Drop: { onDroppedPct: 1.0, offDroppedPct: 0.4 },
    pair1Fps: { onP95Fps: 59.6, offP95Fps: 59.8 },
    pair2Fps: { onP95Fps: 59.5, offP95Fps: 59.7 },
  });
  assert.equal(gate.baselineStalled, false);
  assert.equal(gate.passesDropGate, true);
  assert.equal(gate.passesFpsGate, true);
});