'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDispatchClients, UPDATE_REFS_REF_EXISTS } = require('./dispatch-client');
const { MATCHING_REF_PREFIX } = require('./constants');
const { refUpdateCreate } = require('./refs-graphql');

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

test('getRef uses git/ref URL and rejects bad sha', async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (String(args[1]).includes('/git/ref/')) {
      return { status: 0, stdout: JSON.stringify({ object: { sha: 'abc' } }) };
    }
    return { status: 404, stdout: '' };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  const bad = await read.getRef({ ref: 'refs/mythos/dispatch/lane-00' });
  assert.equal(bad.ok, false);
  assert.match(calls.find((a) => a[1] && a[1].includes('/git/ref/')).join('|'), /git\/ref\/mythos/);
});

test('updateRefs sends JSON body with afterOid refUpdates', async () => {
  const calls = [];
  const gh = (args, token, input) => {
    calls.push({ args, token, input });
    if (args.includes('graphql')) return { status: 0, stdout: '{}' };
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write } = createDispatchClients({ readToken: 'read', writeToken: 'write_tok', gh });
  const sha = 'a'.repeat(40);
  await write.updateRefs([refUpdateCreate('refs/mythos/dispatch/lane-00', sha)]);
  const gql = calls.find((c) => c.args.includes('graphql'));
  assert.ok(gql);
  assert.equal(gql.args.includes('--input'), true);
  assert.equal(gql.args.includes('-'), true);
  assert.equal(gql.token, 'write_tok');
  const body = JSON.parse(gql.input);
  assert.match(body.query, /updateRefs/);
  assert.equal(Array.isArray(body.variables.refUpdates), true);
  assert.equal(body.variables.refUpdates[0].afterOid, sha);
  assert.equal(body.variables.refUpdates[0].beforeOid, '0000000000000000000000000000000000000000');
});

test('refExists is exact message only; other graphql errors are fatal', async () => {
  const gh = (args) => {
    if (args.includes('graphql')) {
      return { status: 0, stdout: JSON.stringify({ errors: [{ message: UPDATE_REFS_REF_EXISTS }] }) };
    }
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write } = createDispatchClients({ readToken: 'r', writeToken: 'w', gh });
  const exists = await write.updateRefs([refUpdateCreate('refs/mythos/dispatch/lane-01', 'b'.repeat(40))]);
  assert.equal(exists.refExists, true);
  assert.equal(exists.fatal, undefined);

  const gh2 = (args) => {
    if (args.includes('graphql')) {
      return { status: 0, stdout: JSON.stringify({ errors: [{ message: 'Something else' }] }) };
    }
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write: w2 } = createDispatchClients({ readToken: 'r', writeToken: 'w', gh: gh2 });
  const fatal = await w2.updateRefs([refUpdateCreate('refs/mythos/dispatch/lane-01', 'b'.repeat(40))]);
  assert.equal(fatal.fatal, true);
  assert.notEqual(fatal.refExists, true);
});

test('listRefs fails closed when commit message GET fails', async () => {
  const gh = (args) => {
    if (args.includes('matching-refs')) {
      return { status: 0, stdout: JSON.stringify([{ ref: 'refs/mythos/dispatch/lane-00', object: { sha: 'c'.repeat(40) } }]) };
    }
    if (args.some((a) => String(a).includes('/git/commits/'))) return { status: 500, stderr: 'denied' };
    return { status: 0, stdout: '[]' };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  const listed = await read.listRefs({ prefix: MATCHING_REF_PREFIX });
  assert.equal(listed.ok, false);
});

test('deleteRef requires beforeOid', async () => {
  const { write } = createDispatchClients({ writeToken: 'w' });
  const del = await write.deleteRef({ ref: 'refs/mythos/dispatch/lane-00' });
  assert.equal(del.fatal, true);
});