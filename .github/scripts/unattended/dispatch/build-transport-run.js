'use strict';

const { BUILD_ARTIFACT_SCHEMA } = require('./build-lane');

function main() {
  const provider = process.env.BUILD_PROVIDER || 'claude';
  if (provider === 'claude' && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.stdout.write(`${JSON.stringify({
      schema: BUILD_ARTIFACT_SCHEMA,
      status: 'unavailable',
      changedFiles: [],
    })}\n`);
    return 2;
  }
  if (provider === 'codex' && !process.env.OPENAI_API_KEY) {
    process.stdout.write(`${JSON.stringify({
      schema: BUILD_ARTIFACT_SCHEMA,
      status: 'unavailable',
      changedFiles: [],
    })}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify({
    schema: BUILD_ARTIFACT_SCHEMA,
    status: 'unavailable',
    changedFiles: [],
  })}\n`);
  return 2;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };