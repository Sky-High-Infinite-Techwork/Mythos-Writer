'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { main } = require('./dispatch-cli');
const switchMod = require('./switch');

test('dispatch-cli main rejects unknown command', async () => {
  const origArgv = process.argv;
  process.argv = ['node', 'dispatch-cli.js', 'not-a-command'];
  try {
    const code = await main();
    assert.equal(code, 1);
  } finally {
    process.argv = origArgv;
  }
});

test('dispatch-cli module import does not exit process', async () => {
  assert.equal(typeof main, 'function');
});

test('dispatch-cli sweep exits 1 when switch read fails', async () => {
  const origArgv = process.argv;
  const origRead = switchMod.readDispatchSwitches;
  switchMod.readDispatchSwitches = async () => ({ ok: false, enabled: false });
  process.argv = ['node', 'dispatch-cli.js', 'sweep'];
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const code = await main();
    assert.equal(code, 1);
    assert.ok(errs.some((l) => l.includes('switch read failed')));
  } finally {
    switchMod.readDispatchSwitches = origRead;
    process.argv = origArgv;
    console.error = origErr;
  }
});