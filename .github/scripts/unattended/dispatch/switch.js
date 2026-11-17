'use strict';

const { interpretSwitch } = require('../switch');
const { gh } = require('../spawn');

function readRepoVariable(repo, token, name) {
  if (!token) return { ok: false, value: null };
  const result = gh(
    ['api', `repos/${repo}/actions/variables/${name}`, '--jq', '.value'],
    token,
  );
  if (result && result.status === 0) {
    return { ok: true, value: String(result.stdout || '').replace(/\r?\n$/, '') };
  }
  const err = (result && result.stderr) || '';
  if (/\b404\b/.test(err) || /Not Found/.test(err)) return { ok: true, value: null };
  return { ok: false, value: null };
}

function readDispatchSwitches(repo, controlToken) {
  const unattended = gh(
    ['api', `repos/${repo}/actions/variables/UNATTENDED_ENABLED`, '--jq', '.value'],
    controlToken,
  );
  const u = interpretSwitch(unattended);
  const dispatch = readRepoVariable(repo, controlToken, 'MYTHOS_DISPATCH_ENABLED');
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