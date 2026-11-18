#!/usr/bin/env bash
# Tier 1 barrier: every listed job must be success. Env: space-separated NEEDS_TIER1_RESULTS (7 tokens).
set -euo pipefail

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

tier1="${NEEDS_TIER1_RESULTS:-}"
if [ -z "$tier1" ]; then
  fail "NEEDS_TIER1_RESULTS is missing or empty"
fi

set -f
IFS=$' \t\n' read -r -a results <<<"$tier1"
set +f
if [ "${#results[@]}" -ne 7 ]; then
  fail "expected 7 Tier 1 results, got ${#results[@]}"
fi

echo "Tier 1 results: $tier1"
for r in "${results[@]}"; do
  if [ -z "$r" ]; then
    fail "empty Tier 1 result token"
  fi
  if [ "$r" != "success" ]; then
    fail "Tier 1 job outcome '${r}' — expected 'success'. Tier 2 jobs will not run. tier1-gate: FAILED."
  fi
done
echo "Tier 1 green — Tier 2 (oracle-sweeps, build-electron, notes-windows, e2e) may run."
