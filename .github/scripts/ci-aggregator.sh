#!/usr/bin/env bash
# Required ci job aggregator. Env: NEEDS_*_RESULT, PATHS_FILTER_RUN_E2E, GITHUB_EVENT_NAME.
set -euo pipefail

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [ "${NEEDS_TIER1_GATE_RESULT:-}" != "success" ]; then
  fail "needs.tier1-gate.result is '${NEEDS_TIER1_GATE_RESULT:-}' — expected 'success'. CI aggregator: FAILED."
fi

tier1="${NEEDS_LINT_RESULT:-} ${NEEDS_TYPECHECK_RESULT:-} ${NEEDS_UNIT_RESULT:-} ${NEEDS_DIFF_GUARD_RESULT:-}"
echo "Tier 1 (lint/typecheck/unit/diff-guard) results: $tier1"
for r in $tier1; do
  if [ "$r" != "success" ]; then
    fail "Required Tier 1 job outcome '${r}' — expected 'success'. CI aggregator: FAILED."
  fi
done

if [ "${NEEDS_ORACLE_SWEEPS_RESULT:-}" != "success" ]; then
  fail "needs.oracle-sweeps.result is '${NEEDS_ORACLE_SWEEPS_RESULT:-}' — expected 'success'. Skipped, cancelled, or failed legs are not success. CI aggregator: FAILED."
fi

run_e2e="${PATHS_FILTER_RUN_E2E:-}"
event="${GITHUB_EVENT_NAME:-pull_request}"
require_e2e=false
if [ "$run_e2e" = "true" ] || [ "$event" = "merge_group" ]; then
  require_e2e=true
fi

e2e="${NEEDS_E2E_SHARD_1_RESULT:-} ${NEEDS_E2E_SHARD_2_RESULT:-} ${NEEDS_E2E_SHARD_3_RESULT:-} ${NEEDS_E2E_SHARD_4_RESULT:-}"
echo "E2E shard results: $e2e (require_e2e=${require_e2e})"

for r in $e2e; do
  if [ "$require_e2e" = true ]; then
    if [ "$r" != "success" ]; then
      fail "E2E shard outcome '${r}' — expected 'success' when run-e2e is true or event is merge_group. CI aggregator: FAILED."
    fi
  else
    if [ "$r" != "success" ] && [ "$r" != "skipped" ]; then
      fail "E2E shard outcome '${r}' — expected 'success' or 'skipped'. CI aggregator: FAILED."
    fi
  fi
done

echo "All checks passed — lint, typecheck, unit, and applicable E2E shards are green."