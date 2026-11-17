'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDispatchClients } = require('./dispatch-client');
const { MATCHING_REF_PREFIX } = require('./constants');

test('createDispatchClients uses matching-refs prefix without refs/', async () => {
  const calls = [];
  const gh = (args, token) => {
    calls.push({ args, token });
    if (args.includes('matching-refs')) {
      return { status: 0, stdout: '[]' };
    }
    return { status: 0, stdout: 'R_kgDOG' };
  };
  const { read } = createDispatchClients({ readToken: 'read', writeToken: 'write', gh });
  await read.listRefs({ prefix: 'refs/mythos/dispatch/' });
  const matchCall = calls.find((c) => c.args.some((a) => String(a).includes('matching-refs')));
  assert.ok(matchCall);
  const pathArg = matchCall.args.find((a) => String(a).includes('matching-refs'));
  assert.match(pathArg, /matching-refs\/mythos(%2F|\/)dispatch(%2F|\/)/);
  assert.equal(matchCall.token, 'read');
});

test('deleteRef and createRef use write token only', async () => {
  const calls = [];
  const gh = (args, token) => {
    calls.push({ args, token });
    if (args[0] === 'api' && args[1] && String(args[1]).endsWith(MATCHING_REF_PREFIX.slice(0, -1))) {
      return { status: 0, stdout: '[]' };
    }
    if (args.includes('graphql')) return { status: 0, stdout: '{}' };
    if (args.includes('--jq') && args.includes('.node_id')) return { status: 0, stdout: 'R_x\n' };
    return { status: 0, stdout: '{}' };
  };
  const { combined: client } = createDispatchClients({ readToken: 'read_tok', writeToken: 'write_tok', gh });
  await client.listRefs({ prefix: 'refs/mythos/dispatch/' });
  await client.createRef({
    ref: 'refs/mythos/dispatch/lane-00',
    sha: 'a'.repeat(40),
  });
  const readCalls = calls.filter((c) => c.token === 'read_tok');
  const writeCalls = calls.filter((c) => c.token === 'write_tok');
  assert.ok(readCalls.length >= 1);
  assert.ok(writeCalls.length >= 1);
});

test('issueComments jq requests user type', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return { status: 0, stdout: '' };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  read.issueComments({ issue: 1 });
  const jq = calls.flat().find((a) => String(a).includes('user.type'));
  assert.ok(jq);
});