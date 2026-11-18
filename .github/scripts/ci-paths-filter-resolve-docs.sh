#!/usr/bin/env bash
# Resolve paths-filter docs-only output (fail-closed). Reads FILTER_* env; writes to GITHUB_OUTPUT.
set -euo pipefail

outcome="${FILTER_DOCS_OUTCOME:-}"
raw="${FILTER_DOCS_DOCS_ONLY:-}"

github_out() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1" >>"$GITHUB_OUTPUT"
  else
    echo "$1"
  fi
}

value="false"
if [ "$outcome" = "success" ]; then
  case "$raw" in
    true) value="true" ;;
    false) value="false" ;;
    *) value="false" ;;
  esac
fi

github_out "docs-only=${value}"
