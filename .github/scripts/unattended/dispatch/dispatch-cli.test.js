'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { main } = require('./dispatch-cli');
const { createDispatchClients } = require('./dispatch-client');
const { canaryScratchRef } = require('./constants');
const { UPDATE_REFS_REF_EXISTS } = require('./refs-graphql');

const RUN_ID = 4242;
const RUN_ATTEMPT = 1;
const MAIN_SHA = 'a'.repeat(40);
const SCRATCH = canaryScratchRef(RUN_ID, RUN_ATTEMPT);

function saveEnv(keys) {
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved) {
  for (const [key, val] of Object.entries(saved)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

function withCanaryCliEnv(extra, run) {
  const saved = saveEnv([
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'MAIN_SHA',
    'CANARY_INDEX',
    'CANARY_OUTCOME_PATH',
    'WRITE_TOKEN',
    'READ_TOKEN',
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cli-'));
  const outcomePath = path.join(dir, 'outcome.json');
  process.env.GITHUB_RUN_ID = String(RUN_ID);
  process.env.GITHUB_RUN_ATTEMPT = String(RUN_ATTEMPT);
  process.env.MAIN_SHA = MAIN_SHA;
  process.env.CANARY_INDEX = '2';
  process.env.CANARY_OUTCOME_PATH = outcomePath;
  process.env.WRITE_TOKEN = 'w';
  process.env.READ_TOKEN = 'r';
  Object.assign(process.env, extra);
  return run(outcomePath, dir).finally(() => {
    restoreEnv(saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function switchesOn() {
  return async () => ({ ok: true, enabled: true });
}

function readOutcome(outcomePath) {
  return JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
}

function mockCombinedClient({ createRefImpl } = {}) {
  const refs = new Map();
  return {
    combined: {
      async createRef({ ref, sha, afterOid }) {
        if (typeof createRefImpl === 'function') return createRefImpl({ ref, sha, afterOid, refs });
        const target = afterOid || sha;
        if (refs.has(ref)) {
          return { refExists: true, errors: [{ message: UPDATE_REFS_REF_EXISTS }] };
        }
        refs.set(ref, target);
        return { ok: true };
      },
    },
  };
}

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
  process.argv = ['node', 'dispatch-cli.js', 'sweep'];
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const code = await main({
      readDispatchSwitchesFn: async () => ({ ok: false, enabled: false }),
      createDispatchClientsFn: () => ({ combined: { listRefs: async () => ({ ok: true, refs: [] }) } }),
    });
    assert.equal(code, 1);
    assert.ok(errs.some((l) => l.includes('switch read failed')));
  } finally {
    process.argv = origArgv;
    console.error = origErr;
  }
});

test('dispatch-cli canary-ref win writes run-bound outcome', async () => {
  const origArgv = process.argv;
  process.argv = ['node', 'dispatch-cli.js', 'canary-ref'];
  await withCanaryCliEnv({}, async (outcomePath) => {
    const code = await main({
      readDispatchSwitchesFn: switchesOn(),
      createDispatchClientsFn: () => mockCombinedClient(),
    });
    assert.equal(code, 0);
    const outcome = readOutcome(outcomePath);
    assert.equal(outcome.kind, 'canary_win');
    assert.equal(outcome.runId, RUN_ID);
    assert.equal(outcome.runAttempt, RUN_ATTEMPT);
    assert.equal(outcome.scratchRef, SCRATCH);
    assert.equal(outcome.index, '2');
  });
  process.argv = origArgv;
});

test('dispatch-cli canary-ref lose on refExists', async () => {
  const origArgv = process.argv;
  process.argv = ['node', 'dispatch-cli.js', 'canary-ref'];
  await withCanaryCliEnv({}, async (outcomePath) => {
    const code = await main({
      readDispatchSwitchesFn: switchesOn(),
      createDispatchClientsFn: () => mockCombinedClient({
        createRefImpl: async ({ ref, sha, refs }) => {
          refs.set(ref, sha);
          return { refExists: true, errors: [{ message: UPDATE_REFS_REF_EXISTS }] };
        },
      }),
    });
    assert.equal(code, 0);
    const outcome = readOutcome(outcomePath);
    assert.equal(outcome.kind, 'canary_lose');
    assert.equal(outcome.scratchRef, SCRATCH);
  });
  process.argv = origArgv;
});

test('dispatch-cli canary-ref fatal and bad main sha', async () => {
  const origArgv = process.argv;
  process.argv = ['node', 'dispatch-cli.js', 'canary-ref'];
  await withCanaryCliEnv({ MAIN_SHA: 'not-hex' }, async (outcomePath) => {
    const code = await main({
      readDispatchSwitchesFn: switchesOn(),
      createDispatchClientsFn: () => mockCombinedClient(),
    });
    assert.equal(code, 1);
    assert.equal(readOutcome(outcomePath).kind, 'canary_fatal');
    assert.equal(readOutcome(outcomePath).reason, 'bad_main_sha');
  });
  process.argv = origArgv;
});

test('dispatch-cli canary-ref inert and abort legs', async () => {
  const origArgv = process.argv;
  process.argv = ['node', 'dispatch-cli.js', 'canary-ref'];
  const reads = { n: 0 };
  await withCanaryCliEnv({}, async (outcomePath) => {
    const inert = await main({
      readDispatchSwitchesFn: async () => ({ ok: true, enabled: false }),
      createDispatchClientsFn: () => mockCombinedClient({
        createRefImpl: async () => {
          throw new Error('createRef must not run when inert');
        },
      }),
    });
    assert.equal(inert, 0);
    assert.equal(readOutcome(outcomePath).kind, 'canary_inert');
    reads.n = 0;
    const abort = await main({
      readDispatchSwitchesFn: async () => {
        reads.n += 1;
        return { ok: true, enabled: reads.n === 1 };
      },
      createDispatchClientsFn: () => mockCombinedClient({
        createRefImpl: async () => {
          throw new Error('createRef must not run on abort');
        },
      }),
    });
    assert.equal(abort, 0);
    assert.equal(readOutcome(outcomePath).kind, 'canary_abort');
  });
  process.argv = origArgv;
});

test('dispatch-cli canary-ref transport fatal', async () => {
  const origArgv = process.argv;
  process.argv = ['node', 'dispatch-cli.js', 'canary-ref'];
  await withCanaryCliEnv({}, async (outcomePath) => {
    const code = await main({
      readDispatchSwitchesFn: switchesOn(),
      createDispatchClientsFn: () => mockCombinedClient({
        createRefImpl: async () => ({ ok: false, fatal: true, error: 'transport' }),
      }),
    });
    assert.equal(code, 1);
    assert.equal(readOutcome(outcomePath).kind, 'canary_fatal');
  });
  process.argv = origArgv;
});

test('dispatch-cli canary-ref skips mutation when switch off after repository lookup', async () => {
  const origArgv = process.argv;
  process.argv = ['node', 'dispatch-cli.js', 'canary-ref'];
  let gqlCalls = 0;
  const gh = (args) => {
    if (args.includes('graphql')) {
      gqlCalls += 1;
      return { status: 0, stdout: JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }) };
    }
    if (String(args).includes('.node_id')) return { status: 0, stdout: '"R_repo\n' };
    return { status: 0, stdout: '' };
  };
  let reads = 0;
  await withCanaryCliEnv({}, async (outcomePath) => {
    const code = await main({
      readDispatchSwitchesFn: async () => {
        reads += 1;
        return { ok: true, enabled: reads <= 2 };
      },
      createDispatchClientsFn: (opts) => createDispatchClients({ ...opts, gh }),
    });
    assert.equal(code, 1);
    assert.equal(gqlCalls, 0);
    assert.equal(readOutcome(outcomePath).kind, 'canary_fatal');
  });
  process.argv = origArgv;
});

test('dispatch-cli canary-ref fatal logs and artifacts use only allowlisted fields and stable codes', async () => {
  const origArgv = process.argv;
  process.argv = ['node', 'dispatch-cli.js', 'canary-ref'];
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(`log:${a.join(' ')}`);
  console.error = (...a) => logs.push(`err:${a.join(' ')}`);
  const leak = 'server-controlled diagnostic token=ghp_leaked and GraphQL boom';
  try {
    await withCanaryCliEnv({}, async (outcomePath) => {
      const code = await main({
        readDispatchSwitchesFn: switchesOn(),
        createDispatchClientsFn: () => mockCombinedClient({
          createRefImpl: async () => ({
            ok: false,
            fatal: true,
            error: `HTTP 500: ${leak}`,
            errors: [{ message: leak, path: ['updateRefs'], type: 'INTERNAL' }],
          }),
        }),
      });
      assert.equal(code, 1);
      const outcome = readOutcome(outcomePath);
      assert.equal(outcome.kind, 'canary_fatal');
      assert.equal(outcome.reason, 'write_failed');
      assert.equal(outcome.runId, RUN_ID);
      assert.equal(outcome.runAttempt, RUN_ATTEMPT);
      assert.equal(outcome.scratchRef, SCRATCH);
      assert.equal(outcome.errors, undefined);
      assert.equal(outcome.error, undefined);
      assert.deepEqual(Object.keys(outcome).sort(), ['index', 'kind', 'reason', 'runAttempt', 'runId', 'scratchRef'].sort());
      const dumped = `${JSON.stringify(outcome)}\n${logs.join('\n')}`;
      assert.equal(dumped.includes(leak), false);
      assert.equal(dumped.includes('HTTP 500'), false);
      assert.equal(dumped.includes('ghp_leaked'), false);
      assert.ok(logs.some((l) => l.includes('canary_fatal') && l.includes('write_failed')));
    });
  } finally {
    process.argv = origArgv;
    console.log = origLog;
    console.error = origErr;
  }
});

test('dispatch-cli canary-ref second switch read failure is canary_fatal exit 1, not abort', async () => {
  const origArgv = process.argv;
  process.argv = ['node', 'dispatch-cli.js', 'canary-ref'];
  const origErr = console.error;
  console.error = () => {};
  let reads = 0;
  let created = 0;
  try {
    await withCanaryCliEnv({}, async (outcomePath) => {
      const code = await main({
        readDispatchSwitchesFn: async () => {
          reads += 1;
          return reads === 1 ? { ok: true, enabled: true } : { ok: false, enabled: false };
        },
        createDispatchClientsFn: () => mockCombinedClient({
          createRefImpl: async () => {
            created += 1;
            return { ok: true };
          },
        }),
      });
      assert.equal(code, 1);
      assert.equal(created, 0);
      const outcome = readOutcome(outcomePath);
      assert.equal(outcome.kind, 'canary_fatal');
      assert.equal(outcome.reason, 'switch_read');
    });
  } finally {
    process.argv = origArgv;
    console.error = origErr;
  }
});

test('allowlistedCanaryOutcome drops errors and other extra keys', () => {
  const { allowlistedCanaryOutcome, writeCanaryOutcome } = require('./dispatch-cli');
  const leaked = 'token=ghp_leaked stderr from updateRefs';
  const cleaned = allowlistedCanaryOutcome({
    kind: 'canary_fatal',
    index: 0,
    runId: 1,
    runAttempt: 1,
    scratchRef: 'refs/mythos/dispatch/canary/scratch-1-1',
    reason: 'write_failed',
    errors: [{ message: leaked }],
    error: leaked,
    stderr: leaked,
  });
  assert.equal(cleaned.errors, undefined);
  assert.equal(cleaned.error, undefined);
  assert.equal(cleaned.stderr, undefined);
  assert.deepEqual(Object.keys(cleaned).sort(), [
    'index', 'kind', 'reason', 'runAttempt', 'runId', 'scratchRef',
  ].sort());
  assert.equal(JSON.stringify(cleaned).includes(leaked), false);
  assert.equal(JSON.stringify(cleaned).includes('ghp_leaked'), false);
});

test('writeCanaryOutcome drops injected errors from the artifact', async () => {
  await withCanaryCliEnv({}, async (outcomePath) => {
    const { writeCanaryOutcome } = require('./dispatch-cli');
    writeCanaryOutcome({
      kind: 'canary_fatal',
      index: '2',
      reason: 'write_failed',
      errors: 'raw boom',
      error: 'HTTP 500: ghp_leaked',
    });
    const outcome = readOutcome(outcomePath);
    assert.equal(outcome.kind, 'canary_fatal');
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.errors, undefined);
    assert.equal(JSON.stringify(outcome).includes('ghp_leaked'), false);
    assert.deepEqual(Object.keys(outcome).sort(), [
      'index', 'kind', 'reason', 'runAttempt', 'runId', 'scratchRef',
    ].sort());
  });
});

test('dispatch-cli canary-ref lose log is allowlisted and omits the raw client result', async () => {
  const origArgv = process.argv;
  process.argv = ['node', 'dispatch-cli.js', 'canary-ref'];
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(`log:${a.join(' ')}`);
  console.error = (...a) => logs.push(`err:${a.join(' ')}`);
  const leak = 'server-controlled diagnostic token=ghp_leaked and GraphQL boom';
  try {
    await withCanaryCliEnv({}, async (outcomePath) => {
      const code = await main({
        readDispatchSwitchesFn: switchesOn(),
        createDispatchClientsFn: () => mockCombinedClient({
          createRefImpl: async () => ({
            ok: false,
            refExists: true,
            error: leak,
            result: { error: leak, errors: [{ message: leak }] },
          }),
        }),
      });
      assert.equal(code, 0);
      const outcome = readOutcome(outcomePath);
      assert.equal(outcome.kind, 'canary_lose');
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.result, undefined);
      const dumped = `${JSON.stringify(outcome)}\n${logs.join('\n')}`;
      assert.equal(dumped.includes(leak), false);
      assert.equal(dumped.includes('ghp_leaked'), false);
      assert.ok(logs.some((l) => l.includes('canary_lose')));
      const loseLines = logs.filter((l) => l.includes('canary_lose'));
      for (const line of loseLines) {
        const json = line.replace(/^log:|^err:/, '');
        const row = JSON.parse(json);
        assert.equal(row.result, undefined);
        assert.equal(row.error, undefined);
        assert.equal(row.errors, undefined);
      }
    });
  } finally {
    process.argv = origArgv;
    console.log = origLog;
    console.error = origErr;
  }
});
