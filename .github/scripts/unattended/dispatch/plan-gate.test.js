'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseGradeTransport,
  formatPlanGradePass,
  findBoundPlanPass,
  reduceGradeResults,
  GRADE_SCHEMA,
} = require('./plan-gate');

test('parseGradeTransport accepts PASS and REVISE', () => {
  const pass = parseGradeTransport(JSON.stringify({ schema: GRADE_SCHEMA, verdict: 'PASS', findings: [] }));
  assert.equal(pass.verdict, 'PASS');
  const revise = parseGradeTransport(JSON.stringify({ schema: GRADE_SCHEMA, verdict: 'REVISE', findings: ['x'] }));
  assert.equal(revise.verdict, 'REVISE');
});

test('plan grade pass marker binds comment id and body sha', () => {
  const body = formatPlanGradePass({ planCommentId: 42, planBodySha256: 'a'.repeat(64) });
  const plan = { databaseId: 42, commentId: '42', bodySha256: 'a'.repeat(64) };
  const bound = findBoundPlanPass([{ body, author: { login: 'SkyHigh-Mythos-Bot' } }], plan);
  assert.equal(bound.ok, true);
  const wrong = findBoundPlanPass([{ body, author: { login: 'bot' } }], {
    ...plan,
    bodySha256: 'b'.repeat(64),
  });
  assert.equal(wrong.ok, false);
});

test('reduceGradeResults revise until cap', () => {
  const revise = reduceGradeResults({ ok: true, verdict: 'REVISE', findings: [] }, 3, 1);
  assert.equal(revise.action, 'revise');
  const cap = reduceGradeResults({ ok: true, verdict: 'REVISE', findings: [] }, 3, 3);
  assert.equal(cap.action, 'hold');
  const pass = reduceGradeResults({ ok: true, verdict: 'PASS', findings: [] }, 3, 1);
  assert.equal(pass.action, 'pass');
});