'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDispatchClients, UPDATE_REFS_REF_EXISTS } = require('./dispatch-client');
const { MATCHING_REF_PREFIX } = require('./constants');
const { refUpdateCreate, refUpdateDelete, refUpdateRenew } = require('./refs-graphql');

const switchesOn = async () => ({ ok: true, enabled: true });

function writeClient(gh, extra = {}) {
  return createDispatchClients({
    readToken: 'r',
    writeToken: 'w',
    gh,
    reReadSwitch: switchesOn,
    ...extra,
  });
}

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

test('getRef returns commit message like listRefs', async () => {
  const sha = 'd'.repeat(40);
  const gh = (args) => {
    const flat = args.map((a) => String(a));
    if (flat.some((a) => a.includes('/git/ref/'))) {
      return { status: 0, stdout: JSON.stringify({ object: { sha } }) };
    }
    if (flat.some((a) => a.includes('/git/commits/'))) {
      return { status: 0, stdout: '{"schema":"mythos-dispatch-attempts/v1","count":1,"lastAttemptAt":"2026-01-01T00:00:00Z"}' };
    }
    return { status: 404, stdout: '' };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  const got = await read.getRef({ ref: 'refs/mythos/dispatch/lane-00' });
  assert.equal(got.ok, true);
  assert.match(got.message, /mythos-dispatch-attempts\/v1/);
});

test('updateRefs sends JSON body with afterOid refUpdates', async () => {
  const calls = [];
  const gh = (args, token, input) => {
    calls.push({ args, token, input });
    if (args.includes('graphql')) {
      return { status: 0, stdout: JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }) };
    }
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write } = createDispatchClients({
    readToken: 'read',
    writeToken: 'write_tok',
    gh,
    reReadSwitch: switchesOn,
  });
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

test('updateRefs fails closed on empty success body', async () => {
  const gh = (args) => {
    if (args.includes('graphql')) return { status: 0, stdout: '{}' };
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write } = writeClient(gh);
  const result = await write.updateRefs([refUpdateCreate('refs/mythos/dispatch/lane-02', 'b'.repeat(40))]);
  assert.equal(result.fatal, true);
  assert.equal(result.error, 'graphql_no_update_refs');
});

test('updateRefs fails closed when updateRefs field is null', async () => {
  const gh = (args) => {
    if (args.includes('graphql')) {
      return { status: 0, stdout: JSON.stringify({ data: { updateRefs: null } }) };
    }
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write } = writeClient(gh);
  const result = await write.updateRefs([refUpdateCreate('refs/mythos/dispatch/lane-03', 'c'.repeat(40))]);
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.equal(result.error, 'graphql_no_update_refs');
});

test('updateRefs and createLeaseCommit fail closed without switch reader', async () => {
  const gh = (args) => {
    if (args.includes('graphql')) return { status: 0, stdout: JSON.stringify({ data: { updateRefs: {} } }) };
    if (String(args).includes('.tree.sha')) return { status: 0, stdout: 't'.repeat(40) + '\n' };
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write } = createDispatchClients({ readToken: 'r', writeToken: 'w', gh });
  const refs = await write.updateRefs([refUpdateCreate('refs/mythos/dispatch/lane-00', 'a'.repeat(40))]);
  assert.equal(refs.error, 'switch_read');
  const commit = await write.createLeaseCommit('m', 'a'.repeat(40));
  assert.equal(commit.error, 'switch_read');
});

test('updateRefs aborts when switches fail after repository node lookup', async () => {
  let gqlCalls = 0;
  const gh = (args) => {
    if (args.includes('graphql')) {
      gqlCalls += 1;
      return { status: 0, stdout: JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }) };
    }
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write } = createDispatchClients({
    readToken: 'r',
    writeToken: 'w',
    gh,
    reReadSwitch: async () => ({ ok: false, enabled: false }),
  });
  const result = await write.updateRefs([refUpdateCreate('refs/mythos/dispatch/lane-00', 'a'.repeat(40))]);
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.equal(result.error, 'switch_read');
  assert.equal(gqlCalls, 0);
});

test('updateRefs aborts when switches off after repository node lookup', async () => {
  let gqlCalls = 0;
  const gh = (args) => {
    if (args.includes('graphql')) {
      gqlCalls += 1;
      return { status: 0, stdout: JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }) };
    }
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write } = createDispatchClients({
    readToken: 'r',
    writeToken: 'w',
    gh,
    reReadSwitch: async () => ({ ok: true, enabled: false }),
  });
  const result = await write.updateRefs([refUpdateCreate('refs/mythos/dispatch/lane-00', 'a'.repeat(40))]);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'switch_off');
  assert.equal(gqlCalls, 0);
});

test('combined createLeaseCommit forwards switch options and skips POST when off', async () => {
  let postCalls = 0;
  const gh = (args) => {
    const flat = args.map((a) => String(a));
    if (flat.includes('-X') && flat.some((a) => a.includes('/git/commits'))) {
      postCalls += 1;
      return { status: 0, stdout: JSON.stringify({ sha: 'c'.repeat(40) }) };
    }
    if (flat.some((a) => a.includes('/git/commits/') && flat.includes('.tree.sha'))) {
      return { status: 0, stdout: 't'.repeat(40) + '\n' };
    }
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { combined } = createDispatchClients({
    readToken: 'r',
    writeToken: 'w',
    gh,
    reReadSwitch: async () => ({ ok: true, enabled: false }),
  });
  const result = await combined.createLeaseCommit('lease-msg', 'a'.repeat(40));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'switch_off');
  assert.equal(postCalls, 0);
});

test('createLeaseCommit aborts when switch flips after parent tree fetch', async () => {
  let calls = 0;
  const gh = (args) => {
    const flat = args.map((a) => String(a));
    if (flat.some((a) => a.includes('/git/commits/') && flat.includes('.tree.sha'))) {
      return { status: 0, stdout: 't'.repeat(40) + '\n' };
    }
    if (flat.includes('-X') && flat.some((a) => a.includes('/git/commits'))) {
      return { status: 0, stdout: JSON.stringify({ sha: 'c'.repeat(40) }) };
    }
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write } = createDispatchClients({
    readToken: 'r',
    writeToken: 'w',
    gh,
    reReadSwitch: async () => ({ ok: true, enabled: false }),
  });
  const created = await write.createLeaseCommit('msg', 'a'.repeat(40));
  assert.equal(created.ok, false);
  assert.equal(created.error, 'switch_off');
});

test('refExists is exact message only; other graphql errors are fatal', async () => {
  const gh = (args) => {
    if (args.includes('graphql')) {
      return {
        status: 1,
        stdout: JSON.stringify({ errors: [{ message: UPDATE_REFS_REF_EXISTS }] }),
        stderr: 'gh: GraphQL error',
      };
    }
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write } = writeClient(gh);
  const exists = await write.updateRefs([refUpdateCreate('refs/mythos/dispatch/lane-01', 'b'.repeat(40))]);
  assert.equal(exists.refExists, true);
  assert.equal(exists.fatal, undefined);

  const gh2 = (args) => {
    if (args.includes('graphql')) {
      return {
        status: 1,
        stdout: JSON.stringify({ errors: [{ message: 'Something else' }] }),
        stderr: 'gh: GraphQL error',
      };
    }
    return { status: 0, stdout: '"R_x"\n' };
  };
  const { write: w2 } = writeClient(gh2);
  const fatal = await w2.updateRefs([refUpdateCreate('refs/mythos/dispatch/lane-01', 'b'.repeat(40))]);
  assert.equal(fatal.fatal, true);
  assert.notEqual(fatal.refExists, true);
});

test('listRefs fails closed when commit message GET fails', async () => {
  const gh = (args) => {
    const flat = args.map((a) => String(a));
    if (flat.some((a) => a.includes('matching-refs'))) {
      return { status: 0, stdout: JSON.stringify([{ ref: 'refs/mythos/dispatch/lane-00', object: { sha: 'c'.repeat(40) } }]) };
    }
    if (flat.some((a) => a.includes('/git/commits/'))) return { status: 500, stderr: 'denied' };
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

test('listRefs skips commit messages for attempts and done refs', async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const flat = args.map((a) => String(a));
    if (flat.some((a) => a.includes('matching-refs'))) {
      return {
        status: 0,
        stdout: JSON.stringify([
          { ref: 'refs/mythos/dispatch/lane-00', object: { sha: 'c'.repeat(40) } },
          { ref: 'refs/mythos/dispatch/attempts/1-0', object: { sha: 'd'.repeat(40) } },
        ]),
      };
    }
    if (flat.some((a) => a.includes('/git/commits/'))) return { status: 0, stdout: 'lease-msg' };
    return { status: 0, stdout: '[]' };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  const listed = await read.listRefs({ prefix: MATCHING_REF_PREFIX });
  assert.equal(listed.ok, true);
  assert.equal(listed.refs.find((r) => r.ref.includes('lane')).message, 'lease-msg');
  assert.equal(listed.refs.find((r) => r.ref.includes('attempts')).message, null);
  assert.equal(calls.filter((a) => a.map(String).join('|').includes('/git/commits/')).length, 1);
});

test('write paths reject refs outside dispatch namespace', () => {
  const oid = 'a'.repeat(40);
  assert.throws(() => refUpdateCreate('refs/heads/main', oid));
  assert.throws(() => refUpdateDelete('refs/heads/main', oid));
  assert.throws(() => refUpdateRenew('refs/heads/main', oid, oid));
});

test('issueCommentContentEdits paginates edit history', async () => {
  const nodeId = 'IC_kwDOTestComment42';
  const pages = [
    {
      data: {
        node: {
          id: nodeId,
          userContentEdits: {
            pageInfo: { hasNextPage: true, endCursor: 'edit-cursor' },
            nodes: [{ editor: { login: 'SkyyPlayz', __typename: 'User' } }],
          },
        },
      },
    },
    {
      data: {
        node: {
          id: nodeId,
          userContentEdits: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ editor: { login: 'SkyyPlayz', __typename: 'User' } }],
          },
        },
      },
    },
  ];
  let n = 0;
  const queries = [];
  const gh = (args, _tok, input) => {
    if (args.includes('graphql')) {
      queries.push(JSON.parse(input));
      const out = pages[Math.min(n, pages.length - 1)];
      n += 1;
      return { status: 0, stdout: JSON.stringify(out) };
    }
    return { status: 0, stdout: '' };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  const edits = await read.issueCommentContentEdits({ issue: 1, commentNodeId: nodeId });
  assert.equal(edits.ok, true);
  assert.equal(edits.editors.length, 2);
  assert.equal(edits.complete, true);
  assert.equal(queries.length, 2);
  assert.match(queries[0].query, /node\(id:\$id\)/);
  assert.equal(queries[0].variables.id, nodeId);
  assert.equal(queries[1].variables.after, 'edit-cursor');
});

test('issueCommentContentEdits holds on redacted editor', async () => {
  const nodeId = 'IC_kwDOTestComment7';
  const gh = (args, _tok) => {
    if (!args.includes('graphql')) return { status: 0, stdout: '' };
    return {
      status: 0,
      stdout: JSON.stringify({
        data: {
          node: {
            id: nodeId,
            userContentEdits: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ editor: null }],
            },
          },
        },
      }),
    };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  const edits = await read.issueCommentContentEdits({ issue: 1, commentNodeId: nodeId });
  assert.equal(edits.ok, false);
  assert.equal(edits.error, 'editor_redacted');
});

test('issueComments maps JSONL paginate output including Bot authors', async () => {
  const gh = (args) => {
    const flat = args.map((a) => String(a));
    if (flat.some((a) => a.includes('/issues/') && a.includes('/comments'))) {
      return {
        status: 0,
        stdout: [
          JSON.stringify({
            id: 11,
            node_id: 'IC_kwDOBot11',
            body: '## Files\nbot-a.ts',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            user: { login: 'dependabot[bot]', type: 'Bot' },
          }),
          JSON.stringify({
            id: 12,
            node_id: 'IC_kwDOUser12',
            body: '## Files\nuser-a.ts',
            created_at: '2026-01-02T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
            user: { login: 'SkyyPlayz', type: 'User' },
          }),
        ].join('\n'),
      };
    }
    return { status: 0, stdout: '' };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  const listed = await read.issueComments({ issue: 42 });
  assert.equal(listed.ok, true);
  assert.equal(listed.comments.length, 2);
  assert.equal(listed.comments[0].author.__typename, 'Bot');
  assert.equal(listed.comments[0].author.login, 'dependabot[bot]');
  assert.equal(listed.comments[0].nodeId, 'IC_kwDOBot11');
  assert.equal(listed.comments[1].author.__typename, 'User');
  assert.equal(listed.comments[1].nodeId, 'IC_kwDOUser12');
});

test('getIssue failed gh exit does not masquerade as success', async () => {
  const gh = (args) => {
    const flat = args.map((a) => String(a));
    if (flat.some((a) => a.includes('/issues/') && !a.includes('/comments'))) {
      return { status: 1, stderr: 'HTTP 403: Forbidden', stdout: '' };
    }
    return { status: 0, stdout: '{}' };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  const got = await read.getIssue({ issue: 9 });
  assert.equal(got.ok, false);
  assert.match(got.error, /403|Forbidden/);
});

test('issueCommentContentEdits matches a REST comment ID above 32-bit GraphQL databaseId via node ID', async () => {
  const LARGE_ID = 2147483648;
  const NODE_ID = 'IC_kwDOOverInt32Comment';
  const queries = [];
  const gh = (args, _tok, input) => {
    const flat = args.map((a) => String(a));
    if (flat.some((a) => a.includes('/issues/') && a.includes('/comments'))) {
      return {
        status: 0,
        stdout: JSON.stringify({
          id: LARGE_ID,
          node_id: NODE_ID,
          body: '## Files\nfrontend/a.ts',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          user: { login: 'SkyyPlayz', type: 'User' },
        }),
      };
    }
    if (args.includes('graphql')) {
      const body = JSON.parse(input);
      queries.push(body);
      assert.equal(body.variables.id, NODE_ID);
      assert.doesNotMatch(body.query, /databaseId/);
      return {
        status: 0,
        stdout: JSON.stringify({
          data: {
            node: {
              id: NODE_ID,
              userContentEdits: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ editor: { login: 'SkyyPlayz', __typename: 'User' } }],
              },
            },
          },
        }),
      };
    }
    return { status: 0, stdout: '' };
  };
  const { read } = createDispatchClients({ readToken: 'r', gh });
  const listed = await read.issueComments({ issue: 1 });
  assert.equal(listed.ok, true);
  assert.equal(listed.comments[0].databaseId, LARGE_ID);
  assert.equal(listed.comments[0].nodeId, NODE_ID);
  const { findOfficialPlan } = require('./official-plan');
  const official = findOfficialPlan(listed.comments);
  assert.ok(official && !official.hold);
  assert.equal(official.nodeId, NODE_ID);
  const edits = await read.issueCommentContentEdits({
    issue: 1,
    commentNodeId: official.nodeId,
    commentDatabaseId: official.databaseId,
  });
  assert.equal(edits.ok, true);
  assert.equal(edits.complete, true);
  assert.equal(edits.editors[0].login, 'SkyyPlayz');
  assert.equal(queries.length, 1);

  const missing = await read.issueCommentContentEdits({
    issue: 1,
    commentDatabaseId: LARGE_ID,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'bad_comment');
});
