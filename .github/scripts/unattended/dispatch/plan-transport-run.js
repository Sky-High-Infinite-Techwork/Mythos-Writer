'use strict';

const { GRADE_SCHEMA } = require('./plan-gate');

function emitUnavailable(role) {
  const payload = {
    schema: GRADE_SCHEMA,
    role,
    status: 'unavailable',
    findings: ['transport not armed'],
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 2;
}

function main() {
  const role = process.env.PLAN_ROLE || 'grade';
  if (role === 'plan' && !process.env.CLAUDE_CODE_OAUTH_TOKEN) return emitUnavailable('plan');
  if (role === 'grade' && !process.env.CLAUDE_CODE_OAUTH_TOKEN) return emitUnavailable('grade');
  return emitUnavailable(role);
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { emitUnavailable };