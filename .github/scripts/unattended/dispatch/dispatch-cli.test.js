'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { main } = require('./dispatch-cli');

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