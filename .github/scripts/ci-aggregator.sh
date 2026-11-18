#!/usr/bin/env bash
# Required ci job aggregator. Env: NEEDS_*_RESULT, PATHS_FILTER_RUN_E2E, GITHUB_EVENT_NAME.
set -euo pipefail

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_nonempty() {
  local name=$1
  local value=$2
  if [ -z "$value" ]; then
    fail "${name} is missing or empty"
  fi
}

require_success() {
  local name=$1
  local value=$2
  require_nonempty "$name" "$value"
  if [ "$value" != "success" ]; then
    fail "${name} is '${value}' — expected 'success'. CI aggregator: FAILED."
  fi
}

event="${GITHUB_EVENT_NAME:-}"
require_nonempty "GITHUB_EVENT_NAME" "$event"

require_success "NEEDS_TIER1_GATE_RESULT" "${NEEDS_TIER1_GATE_RESULT:-}"

require_success "NEEDS_LINT_RESULT" "${NEEDS_LINT_RESULT:-}"
require_success "NEEDS_TYPECHECK_RESULT" "${NEEDS_TYPECHECK_RESULT:-}"
require_success "NEEDS_UNIT_RESULT" "${NEEDS_UNIT_RESULT:-}"
require_success "NEEDS_DIFF_GUARD_RESULT" "${NEEDS_DIFF_GUARD_RESULT:-}"

require_success "NEEDS_ORACLE_SWEEPS_RESULT" "${NEEDS_ORACLE_SWEEPS_RESULT:-}"

run_e2e="${PATHS_FILTER_RUN_E2E:-}"
require_e2e=false
if [ "$event" = "merge_group" ] || [ "$event" = "push" ] || [ "$event" = "workflow_dispatch" ]; then
  require_e2e=true
elif [ "$run_e2e" = "true" ]; then
  require_e2e=true
elif [ "$run_e2e" = "false" ]; then
  require_e2e=false
else
  fail "PATHS_FILTER_RUN_E2E must be 'true' or 'false' for pull_request (got '${run_e2e}')"
fi

shard_results=(
  "${NEEDS_E2E_SHARD_1_RESULT:-}"
  "${NEEDS_E2E_SHARD_2_RESULT:-}"
  "${NEEDS_E2E_SHARD_3_RESULT:-}"
  "${NEEDS_E2E_SHARD_4_RESULT:-}"
)
echo "E2E shard results: ${shard_results[*]} (require_e2e=${require_e2e})"

i=1
for r in "${shard_results[@]}"; do
  require_nonempty "NEEDS_E2E_SHARD_${i}_RESULT" "$r"
  if [ "$require_e2e" = true ]; then
    if [ "$r" != "success" ]; then
      fail "NEEDS_E2E_SHARD_${i}_RESULT is '${r}' — expected 'success' when e2e is required. CI aggregator: FAILED."
    fi
  else
    if [ "$r" != "success" ] && [ "$r" != "skipped" ]; then
      fail "NEEDS_E2E_SHARD_${i}_RESULT is '${r}' — expected 'success' or 'skipped'. CI aggregator: FAILED."
    fi
  fi
  i=$((i + 1))
done

echo "All checks passed — lint, typecheck, unit, and applicable E2E shards are green."
