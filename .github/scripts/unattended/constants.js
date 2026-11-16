'use strict';

// Phase 1 identities. App IDs are configuration, checked against Actions variables
// before a token is used. The write app is never a PROOF builder.

const REPO = 'Sky-High-Infinite-Techwork/Mythos-Writer';
const WRITE_APP_ID = '5777914';
const WRITE_INSTALLATION_ID = '182422539';
const GATE_APP_ID = 5736520;
const CHECK_NAME = 'mythos/final-gate';
const REQUIRED_CHECKS = ['ci', 'notes-windows', 'screenshot-check'];
const PROOF_BUILDER = 'cursor[bot]';
const HOLD_LABELS = ['tip-freeze', 'do-not-merge', 'hold', 'carve-out'];
const RESULT_SCHEMA = 'mythos-gate-result/v1';

const PROTECTED_PATH = [
  /(^|\/)\.github\//i,
  /^electron-main\/src\/db\.ts$/,
  /(^|\/)electron-builder[^/]*$/i,
  /(^|\/)\.env($|\.)/,
  /secrets?\.(ts|js|json|ya?ml)$/i,
  /(^|\/)auth(\/|$)/i,
  /(^|\/)release\//i,
];

function sha40(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function protectedPath(filename) {
  return PROTECTED_PATH.some((re) => re.test(filename));
}

module.exports = {
  REPO,
  WRITE_APP_ID,
  WRITE_INSTALLATION_ID,
  GATE_APP_ID,
  CHECK_NAME,
  REQUIRED_CHECKS,
  PROOF_BUILDER,
  HOLD_LABELS,
  RESULT_SCHEMA,
  sha40,
  protectedPath,
};
