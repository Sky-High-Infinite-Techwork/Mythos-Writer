/**
 * ABBA accent-breathe perf gate (#1774): shared drop/fps math for the live
 * Playwright gate and red-on-revert pins (revert the helper and both fail).
 */

import type { Expect } from '@playwright/test';

export const ABBA_DROP_DELTA_MAX_PP = 2;
export const ABBA_FPS_FLOOR_TOLERANCE = 3;

export type AbbaPairDroppedPct = {
  onDroppedPct: number;
  offDroppedPct: number;
};

export type AbbaPairFpsFloor = {
  onP95Fps: number;
  offP95Fps: number;
};

export type AbbaBreathePerfWindows = {
  pair1Drop: AbbaPairDroppedPct;
  pair2Drop: AbbaPairDroppedPct;
  pair1Fps: AbbaPairFpsFloor;
  pair2Fps: AbbaPairFpsFloor;
};

export type AbbaBreathePerfGateResult = {
  dropPair1Pp: number;
  dropPair2Pp: number;
  dropDeltaPp: number;
  fpsPair1: number;
  fpsPair2: number;
  fpsPairBest: number;
  passesDropGate: boolean;
  passesFpsGate: boolean;
};

export function evaluateAbbaBreathePerfGate(
  windows: AbbaBreathePerfWindows,
): AbbaBreathePerfGateResult {
  const dropPair1Pp = windows.pair1Drop.onDroppedPct - windows.pair1Drop.offDroppedPct;
  const dropPair2Pp = windows.pair2Drop.onDroppedPct - windows.pair2Drop.offDroppedPct;
  const dropDeltaPp = Math.min(dropPair1Pp, dropPair2Pp);
  const fpsPair1 =
    windows.pair1Fps.onP95Fps - (windows.pair1Fps.offP95Fps - ABBA_FPS_FLOOR_TOLERANCE);
  const fpsPair2 =
    windows.pair2Fps.onP95Fps - (windows.pair2Fps.offP95Fps - ABBA_FPS_FLOOR_TOLERANCE);
  const fpsPairBest = Math.max(fpsPair1, fpsPair2);
  return {
    dropPair1Pp,
    dropPair2Pp,
    dropDeltaPp,
    fpsPair1,
    fpsPair2,
    fpsPairBest,
    passesDropGate: dropDeltaPp <= ABBA_DROP_DELTA_MAX_PP,
    passesFpsGate: fpsPairBest >= 0,
  };
}

export function assertAbbaBreathePerfGate(
  expect: Expect,
  windows: AbbaBreathePerfWindows,
): AbbaBreathePerfGateResult {
  const result = evaluateAbbaBreathePerfGate(windows);
  expect(result.dropDeltaPp).toBeLessThanOrEqual(ABBA_DROP_DELTA_MAX_PP);
  expect(result.fpsPairBest).toBeGreaterThanOrEqual(0);
  return result;
}