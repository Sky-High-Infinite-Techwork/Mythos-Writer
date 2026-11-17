#!/usr/bin/env bash
# Tier 1 barrier: every listed job must be success. Env: space-separated NEEDS_TIER1_RESULTS.
set -euo pipefail

tier1="${NEEDS_TIER1_RESULTS:-}"

echo "Tier 1 results: $tier1"
for r in $tier1; do
  if [ "$r" != "success" ]; then
    echo "ERROR: Tier 1 job outcome '${r}' — expected 'success'. Tier 2 jobs will not run. tier1-gate: FAILED." >&2
    exit 1
  fi
done
echo "Tier 1 green — Tier 2 (oracle-sweeps, build-electron, notes-windows, e2e) may run."