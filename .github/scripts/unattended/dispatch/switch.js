'use strict';

const { interpretSwitch } = require('../switch');
const { gh } = require('../spawn');

function readRepoVariable(repo, token, name, ghFn = gh) {
  if (!token) return { ok: false, value: null, reason: 'no_token' };
  const result = ghFn(
    ['api', `repos/${repo}/actions/variables/${name}`, '--jq', '.value'],
    token,
  );
  if (result && result.status === 0) {
    return { ok: true, value: String(result.stdout || '').replace(/\r?\n$/, ''), unset: false };
  }
  const err = (result && result.stderr) || '';
  if (/\b404\b/.test(err) || /Not Found/.test(err)) return { ok: true, value: null, unset: true };
  return { ok: false, value: null, reason: 'access_denied' };
}

function readDispatchSwitches(repo, controlToken, ghFn = gh) {
  const unattended = ghFn(
    ['api', `repos/${repo}/actions/variables/UNATTENDED_ENABLED`, '--jq', '.value'],
    controlToken,
  );
  const u = interpretSwitch(unattended);
  const dispatch = readRepoVariable(repo, controlToken, 'MYTHOS_DISPATCH_ENABLED', ghFn);
  const enabled = u.ok && u.enabled === true
    && dispatch.ok && dispatch.value === 'true';
  if (!u.ok || !dispatch.ok) return { ok: false, enabled: false, unattended: u, dispatch };
  return { ok: true, enabled, unattended: u, dispatch };
}

function actWritesEnabled(switches) {
  return switches.ok && switches.enabled === true;
}

module.exports = {
  readRepoVariable,
  readDispatchSwitches,
  actWritesEnabled,
};