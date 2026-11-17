'use strict';

// Phase 1 identities. App IDs are configuration, checked against Actions variables
// before a token is used. The write app is never a PROOF builder.

const REPO = 'Sky-High-Infinite-Techwork/Mythos-Writer';
const WRITE_APP_ID = '5777914';
const WRITE_INSTALLATION_ID = '182422539';
const GATE_APP_ID = 5736520;
const CI_INTEGRATION_ID = 15368;
const CHECK_NAME = 'mythos/final-gate';
const REQUIRED_CHECKS = ['ci', 'notes-windows', 'screenshot-check'];
const HOLD_LABELS = ['tip-freeze', 'do-not-merge', 'hold', 'carve-out'];
// Independent proof is a successful Actions run of these files at main's blob.
const EVIDENCE_WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/screenshot-check.yml',
];
const RESULT_SCHEMA = 'mythos-gate-result/v1';

function sha40(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// Same ERE as batch-automerge.yml PROTECTED_RE. The workflow cannot load this
// module (it does not check the repo out). batch-automerge.test.js locks the copies.
const PROTECTED_RE_SOURCE = "(^|/)auth|payment|billing|stripe|(^|/)migrations?/|schema|(^|/)\\.github/|(^|/)release|electron-builder|\\.nsh$|(^|/)scripts/verify-fuses\\.mjs$|(^|/)scripts/fuses\\.expected\\.json$|^electron-main/src/db\\.ts$|secrets?\\.(ts|js|json|ya?ml)$|(^|/)\\.env($|\\.)|(^|/)agents\\.md$|(^|/)claude\\.md$|(^|/)\\.claude/|(^|/)\\.codex/|(^|/)\\.mcp\\.json$|(^|/)\\.npmrc$|(^|/)\\.yarnrc[^/]*$|(^|/)\\.husky/|(^|/)\\.gitmodules$|(^|/)[^/]+\\.config\\.[^/]+$|(^|/)(yarn|cargo|poetry|pipfile|uv|pdm|gemfile|composer|podfile|mix|pubspec|flake)\\.lock$|(^|/)(package-lock|npm-shrinkwrap|packages\\.lock)\\.json$|(^|/)pnpm-lock\\.yaml$|(^|/)bun\\.lockb?$|(^|/)go\\.sum$|(^|/)gradle\\.lockfile$|(^|/)package\\.json$|(^|/)cargo\\.toml$|(^|/)go\\.mod$|(^|/)gemfile$|(^|/)composer\\.json$|(^|/)pyproject\\.toml$|(^|/)pipfile$|(^|/)requirements[^/]*\\.txt$|(^|/)pom\\.xml$|(^|/)build\\.gradle[^/]*$|^(docs/)?codeowners$|(^|/)deno\\.lock$|(^|/)package\\.resolved$|(^|/)\\.terraform\\.lock\\.hcl$|(^|/)dev-requirements[^/]*\\.txt$|(^|/)setup\\.py$";
const PROTECTED_RE = new RegExp(PROTECTED_RE_SOURCE, 'i');
// .github/** stays owner-merged, including a nested path the batch ERE only anchors at ^.
const OWNER_RE = /(^|\/)\.github\//i;

function protectedPath(filename) {
  return PROTECTED_RE.test(String(filename || ''));
}

function ownerPath(filename) {
  return OWNER_RE.test(String(filename || ''));
}

module.exports = {
  REPO,
  WRITE_APP_ID,
  WRITE_INSTALLATION_ID,
  GATE_APP_ID,
  CI_INTEGRATION_ID,
  CHECK_NAME,
  REQUIRED_CHECKS,
  HOLD_LABELS,
  EVIDENCE_WORKFLOWS,
  RESULT_SCHEMA,
  PROTECTED_RE_SOURCE,
  sha40,
  protectedPath,
  ownerPath,
};
