'use strict';

const { gh } = require('./spawn');

// A live read of the repository variable. Only the literal string true enables
// work. A missing variable is off. Any other read failure is not a successful
// "off" — the caller must not write, and an act-mode job must fail.
function interpretSwitch(result) {
  if (result && result.status === 0) {
    const value = String(result.stdout || '').replace(/\r?\n$/, '');
    return { ok: true, enabled: value === 'true' };
  }
  const err = (result && result.stderr) || '';
  if (/\b404\b/.test(err) || /Not Found/.test(err)) return { ok: true, enabled: false };
  return { ok: false, enabled: false };
}

function readSwitch(repo, token) {
  if (!token) return { ok: false, enabled: false };
  const result = gh(
    ['api', `repos/${repo}/actions/variables/UNATTENDED_ENABLED`, '--jq', '.value'],
    token,
  );
  return interpretSwitch(result);
}

module.exports = { interpretSwitch, readSwitch };
