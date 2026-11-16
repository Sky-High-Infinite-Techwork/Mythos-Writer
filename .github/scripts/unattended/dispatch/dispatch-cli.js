'use strict';

const { REPO } = require('./constants');
const { createGhDispatchClient } = require('./dispatch-client');
const { runDispatchPlan } = require('./dispatch-run');
const { sweepExpiredLeases } = require('./claim');
const { readDispatchSwitches } = require('./switch');

async function main() {
  const command = process.argv[2] || 'plan';
  const token = process.env.WRITE_TOKEN || process.env.READ_TOKEN || process.env.GITHUB_TOKEN || '';
  const client = createGhDispatchClient(token, process.env.REPO || REPO);

  if (command === 'sweep') {
    const switches = readDispatchSwitches(process.env.REPO || REPO, process.env.CONTROL_TOKEN);
    if (!switches.enabled) {
      console.log('sweep: inert');
      return 0;
    }
    const result = await sweepExpiredLeases(client);
    console.log(JSON.stringify({ kind: 'sweep', ...result }));
    return result.ok ? 0 : 1;
  }

  if (command === 'plan') {
    const env = {
      MODE: process.env.MODE,
      REPO: process.env.REPO || REPO,
      CONTROL_TOKEN: process.env.CONTROL_TOKEN,
      RUN_ID: parseInt(process.env.GITHUB_RUN_ID || '0', 10),
      RUN_ATTEMPT: parseInt(process.env.GITHUB_RUN_ATTEMPT || '1', 10),
      client,
    };
    env.MAIN_SHA = process.env.MAIN_SHA || '';
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