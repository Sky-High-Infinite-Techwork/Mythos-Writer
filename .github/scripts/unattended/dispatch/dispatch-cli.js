'use strict';

const { REPO } = require('./constants');
const { createDispatchClients } = require('./dispatch-client');
const { runDispatchPlan } = require('./dispatch-run');
const { sweepDispatchRefs } = require('./claim');
const { readDispatchSwitches, actWritesEnabled } = require('./switch');
const { activeClaimsFromRefs } = require('./dispatch-helpers');

async function main() {
  const command = process.argv[2] || 'plan';
  const readToken = process.env.READ_TOKEN || process.env.GITHUB_TOKEN || '';
  const writeToken = process.env.WRITE_TOKEN || '';
  const { combined: client } = createDispatchClients({
    repo: process.env.REPO || REPO,
    readToken,
    writeToken,
  });

  const reReadSwitch = async () => readDispatchSwitches(process.env.REPO || REPO, process.env.CONTROL_TOKEN);

  if (command === 'sweep') {
    const switches = await reReadSwitch();
    if (!actWritesEnabled(switches)) {
      console.log('sweep: inert');
      return 0;
    }
    const result = await sweepDispatchRefs(client, { reReadSwitch });
    console.log(JSON.stringify({ kind: 'sweep', ...result }));
    return result.ok ? 0 : 1;
  }

  if (command === 'canary-ref') {
    const sha = process.env.MAIN_SHA || '0'.repeat(40);
    const ref = 'refs/mythos/dispatch/canary/scratch-0';
    const result = await client.createRef({ ref, sha });
    if (result.ok) {
      console.log(JSON.stringify({ kind: 'canary_win', index, status: 201 }));
      return 0;
    }
    if (result.refExists) {
      console.log(JSON.stringify({ kind: 'canary_lose', index, message: 'Reference already exists' }));
      return 0;
    }
    console.error(result.error || 'canary_failed');
    return 1;
  }

  if (command === 'plan') {
    const env = {
      MODE: process.env.MODE,
      REPO: process.env.REPO || REPO,
      CONTROL_TOKEN: process.env.CONTROL_TOKEN,
      RUN_ID: parseInt(process.env.GITHUB_RUN_ID || '0', 10),
      RUN_ATTEMPT: parseInt(process.env.GITHUB_RUN_ATTEMPT || '1', 10),
      MAIN_SHA: process.env.MAIN_SHA || '',
      client,
      activeClaimsFromRefs: (refs) => activeClaimsFromRefs(refs),
    };
    return runDispatchPlan(env);
  }

  console.error(`unknown command: ${command}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });