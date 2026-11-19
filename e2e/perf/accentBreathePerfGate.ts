/**
 * ABBA accent-breathe perf gate (#1774): shared drop/fps math for the live
 * Playwright gate and red-on-revert pins (revert the helper and both fail).
 *
 * Fail-closed: baseline OFF drop rate = min(off1, off2). Worst ON drop rate =
 * max(on1, on2). Pass drop when (worstOn − offBaseline) ≤ +2 pp. Fps: worst ON
 * p95 floor vs best OFF p95 floor within −3 fps. If either OFF window exceeds
 * the OFF stall bar on its own, baseline stalled → never pass.
 */

import type { Expect } from '@playwright/test';

export const ABBA_DROP_DELTA_MAX_PP = 2;
export const ABBA_FPS_FLOOR_TOLERANCE = 3;
/**
 * Either OFF window above this absolute dropped-frame % is a stalled baseline
 * (fail closed). Higher than the +2pp delta bar so xvfb timing noise (~2.1pp OFF)
 * does not false-stall; Critic's fail-open case uses ~5–6% OFF.
 */
export const ABBA_OFF_DROP_STALL_MAX_PP = 4;

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
  offDropBaselinePp: number;
  onDropWorstPp: number;
  dropDeltaPp: number;
  fpsBestOffP95: number;
  fpsWorstOnP95: number;
  fpsMargin: number;
  baselineStalled: boolean;
  baselineStalledReason: string | null;
  passesDropGate: boolean;
  passesFpsGate: boolean;
};

function offStallReason(off1: number, off2: number): string | null {
  if (off1 > ABBA_OFF_DROP_STALL_MAX_PP) {
    return `baseline stalled: off1 dropped ${off1.toFixed(2)}% > ${ABBA_OFF_DROP_STALL_MAX_PP}pp`;
  }
  if (off2 > ABBA_OFF_DROP_STALL_MAX_PP) {
    return `baseline stalled: off2 dropped ${off2.toFixed(2)}% > ${ABBA_OFF_DROP_STALL_MAX_PP}pp`;
  }
  return null;
}

export function evaluateAbbaBreathePerfGate(
  windows: AbbaBreathePerfWindows,
): AbbaBreathePerfGateResult {
  const on1 = windows.pair1Drop.onDroppedPct;
  const off1 = windows.pair1Drop.offDroppedPct;
  const on2 = windows.pair2Drop.onDroppedPct;
  const off2 = windows.pair2Drop.offDroppedPct;

  const dropPair1Pp = on1 - off1;
  const dropPair2Pp = on2 - off2;
  const offDropBaselinePp = Math.min(off1, off2);
  const onDropWorstPp = Math.max(on1, on2);
  const dropDeltaPp = onDropWorstPp - offDropBaselinePp;

  const fpsBestOffP95 = Math.max(windows.pair1Fps.offP95Fps, windows.pair2Fps.offP95Fps);
  const fpsWorstOnP95 = Math.min(windows.pair1Fps.onP95Fps, windows.pair2Fps.onP95Fps);
  const fpsMargin = fpsWorstOnP95 - (fpsBestOffP95 - ABBA_FPS_FLOOR_TOLERANCE);

  const baselineStalledReason = offStallReason(off1, off2);
  const baselineStalled = baselineStalledReason !== null;

  const passesDropGate = !baselineStalled && dropDeltaPp <= ABBA_DROP_DELTA_MAX_PP;
  const passesFpsGate = !baselineStalled && fpsMargin >= 0;

  return {
    dropPair1Pp,
    dropPair2Pp,
    offDropBaselinePp,
    onDropWorstPp,
    dropDeltaPp,
    fpsBestOffP95,
    fpsWorstOnP95,
    fpsMargin,
    baselineStalled,
    baselineStalledReason,
    passesDropGate,
    passesFpsGate,
  };
}

export function assertAbbaBreathePerfGate(
  expect: Expect,
  windows: AbbaBreathePerfWindows,
): AbbaBreathePerfGateResult {
  const result = evaluateAbbaBreathePerfGate(windows);
  expect(result.baselineStalled, result.baselineStalledReason ?? 'baseline stalled').toBe(false);
  expect(result.dropDeltaPp).toBeLessThanOrEqual(ABBA_DROP_DELTA_MAX_PP);
  expect(result.fpsMargin).toBeGreaterThanOrEqual(0);
  return result;
}