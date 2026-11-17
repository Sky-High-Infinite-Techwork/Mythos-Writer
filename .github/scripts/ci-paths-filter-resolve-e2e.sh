#!/usr/bin/env bash
# Resolve paths-filter run-e2e output (fail-closed). Reads FILTER_* / GITHUB_EVENT_NAME env.
set -euo pipefail

event_name="${GITHUB_EVENT_NAME:-pull_request}"
outcome="${FILTER_E2E_OUTCOME:-}"
raw="${FILTER_E2E_RUN_E2E:-}"

github_out() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1" >>"$GITHUB_OUTPUT"
  else
    echo "$1"
  fi
}

if [ "$event_name" = "merge_group" ] || [ "$event_name" = "workflow_dispatch" ] || [ "$event_name" = "push" ]; then
  github_out "run-e2e=true"
  exit 0
fi

if [ "$outcome" != "success" ] || [ -z "$raw" ]; then
  echo "paths-filter run-e2e step did not produce a valid value — defaulting run-e2e=true (fail-safe)." >&2
  github_out "run-e2e=true"
  exit 0
fi

case "$raw" in
  true) github_out "run-e2e=true" ;;
  false) github_out "run-e2e=false" ;;
  *)
    echo "paths-filter run-e2e output was not true/false (${raw@Q}) — defaulting run-e2e=true (fail-safe)." >&2
    github_out "run-e2e=true"
    ;;
esac