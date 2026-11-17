'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseGradeTransport,
  formatPlanGradePass,
  findBoundPlanPass,
  gradePublisherAllowlistConflictsWithPlanAuthors,
  reduceGradeResults,
  parsePlanGradePassMarker,
  GRADE_SCHEMA,
  PASS_MARKER_PREFIX,
} = require('./plan-gate');
const { decidePublish } = require('./plan-gate-publish');

const PASS_SHA = 'a'.repeat(64);
const plan = { databaseId: 42, commentId: '42', bodySha256: PASS_SHA };
const GRADE_BOT = 'mythos-independent-grade-bot';

process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST = GRADE_BOT;

function passComment(overrides = {}) {
  const body = formatPlanGradePass({ planCommentId: 42, planBodySha256: PASS_SHA });
  return {
    body,
    author: { login: 'Mythos-Independent-Grade-Bot' },
    ...overrides,
  };
}

test('parseGradeTransport requires ok status and findings array', () => {
  assert.equal(parseGradeTransport(JSON.stringify({ schema: GRADE_SCHEMA, verdict: 'PASS' })).ok, false);
  const passBody = {
    schema: GRADE_SCHEMA,
    status: 'ok',
    role: 'grade',
    verdict: 'PASS',
    findings: [],
    planCommentId: 42,
    planBodySha256: PASS_SHA,
  };
  assert.equal(parseGradeTransport(JSON.stringify(passBody)).ok, true);
  assert.equal(parseGradeTransport(JSON.stringify({
    schema: GRADE_SCHEMA,
    status: 'ok',
    role: 'grade',
    verdict: 'REVISE',
    findings: ['x'],
    planCommentId: 42,
    planBodySha256: PASS_SHA,
  })).verdict, 'REVISE');
  assert.equal(parseGradeTransport(JSON.stringify({ ...passBody, planCommentId: undefined })).ok, false);
  assert.equal(parseGradeTransport(JSON.stringify({ ...passBody, role: 'plan' })).ok, false);
});

test('parsePlanGradePassMarker is exact line match', () => {
  const marker = parsePlanGradePassMarker(`${PASS_MARKER_PREFIX} comment=42 sha=${PASS_SHA}`);
  assert.equal(marker.planCommentId, 42);
  assert.equal(parsePlanGradePassMarker(`${PASS_MARKER_PREFIX} comment=42 sha=${PASS_SHA} trailing`), null);
});

test('bound pass requires trusted publisher', () => {
  assert.equal(findBoundPlanPass([passComment()], plan).ok, true);
  assert.equal(findBoundPlanPass([passComment({ author: { login: 'random' } })], plan).ok, false);
});

test('bound pass fails closed without allowlist', () => {
  const prior = process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST;
  delete process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST;
  assert.equal(findBoundPlanPass([passComment()], plan).reason, 'grade_publisher_unconfigured');
  process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST = prior;
});

test('grade allowlist must not include official plan authors', () => {
  const prior = process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST;
  process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST = 'skyyplayz,skyhigh-mythos-bot';
  assert.equal(gradePublisherAllowlistConflictsWithPlanAuthors(), true);
  assert.equal(findBoundPlanPass([passComment()], plan).reason, 'grade_publisher_plan_author_overlap');
  process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST = prior;
});

test('plan author cannot self-post pass even when on grade allowlist', () => {
  const prior = process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST;
  process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST = 'skyyplayz,skyhigh-mythos-bot';
  const overlap = findBoundPlanPass([passComment()], plan);
  assert.equal(overlap.ok, false);
  assert.equal(overlap.reason, 'grade_publisher_plan_author_overlap');
  const body = formatPlanGradePass({ planCommentId: 42, planBodySha256: PASS_SHA });
  process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST = GRADE_BOT;
  assert.equal(findBoundPlanPass([{ body, author: { login: 'SkyyPlayz' } }], plan).ok, false);
  process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST = prior;
});

test('plan author cannot self-post pass when not on grade allowlist', () => {
  process.env.MYTHOS_GRADE_PUBLISHER_ALLOWLIST = GRADE_BOT;
  const body = formatPlanGradePass({ planCommentId: 42, planBodySha256: PASS_SHA });
  assert.equal(findBoundPlanPass([{ body, author: { login: 'SkyyPlayz' } }], plan).ok, false);
});

test('binding negative wrong sha comment id author', () => {
  const body = formatPlanGradePass({ planCommentId: 42, planBodySha256: PASS_SHA });
  assert.equal(findBoundPlanPass([{ body, author: { login: 'Mythos-Independent-Grade-Bot' } }], {
    ...plan,
    bodySha256: 'b'.repeat(64),
  }).ok, false);
  assert.equal(findBoundPlanPass([{
    body: formatPlanGradePass({ planCommentId: 99, planBodySha256: PASS_SHA }),
    author: { login: 'Mythos-Independent-Grade-Bot' },
  }], plan).ok, false);
  assert.equal(findBoundPlanPass([{
    body,
    author: { login: 'Mythos-Independent-Grade-Bot' },
  }], plan).ok, true);
  assert.equal(findBoundPlanPass([{
    body,
    author: { login: 'evil' },
  }], { ...plan, bodySha256: PASS_SHA }).ok, false);
});

test('reduceGradeResults revise until cap and invalid cap', () => {
  const grade = { ok: true, verdict: 'REVISE', findings: [] };
  assert.equal(reduceGradeResults(grade, 3, 1).action, 'revise');
  assert.equal(reduceGradeResults(grade, 3, 3).action, 'hold');
  assert.equal(reduceGradeResults({ ok: true, verdict: 'PASS', findings: [] }, 3, 1).action, 'pass');
  assert.equal(reduceGradeResults(grade, NaN, 1).reason, 'grade_round_cap_invalid');
  assert.equal(reduceGradeResults({ ok: false }, 3, 1).reason, 'grade_unavailable');
  assert.equal(reduceGradeResults({ ok: true, verdict: 'MAYBE', findings: [] }, 3, 1).reason, 'grade_unavailable');
});

test('transport stub never parses as PASS', () => {
  const stub = JSON.stringify({ schema: GRADE_SCHEMA, status: 'unavailable', findings: ['transport not armed'] });
  assert.equal(parseGradeTransport(stub).ok, false);
});

test('decidePublish binds plan revision', () => {
  const stdout = JSON.stringify({
    schema: GRADE_SCHEMA,
    status: 'ok',
    role: 'grade',
    verdict: 'PASS',
    findings: [],
    planCommentId: 42,
    planBodySha256: PASS_SHA,
  });
  const ok = decidePublish({
    gradeStdout: stdout,
    plan,
    planCommentId: 42,
    planBodySha256: PASS_SHA,
    maxRounds: 3,
    round: 1,
  });
  assert.equal(ok.ok, true);
  assert.match(ok.body, /^PLAN GRADE PASS @ comment=42 sha=/);
  const badSha = decidePublish({
    gradeStdout: stdout,
    plan,
    planCommentId: 42,
    planBodySha256: 'short',
    maxRounds: 3,
    round: 1,
  });
  assert.equal(badSha.ok, false);
  assert.equal(
    decidePublish({
      gradeStdout: stdout,
      plan,
      planCommentId: 99,
      planBodySha256: PASS_SHA,
      maxRounds: 3,
      round: 1,
    }).reason,
    'plan_revision_mismatch',
  );
});

test('formatPlanGradePass literal marker string', () => {
  const line = formatPlanGradePass({ planCommentId: 7, planBodySha256: PASS_SHA });
  assert.equal(line, `${PASS_MARKER_PREFIX} comment=7 sha=${PASS_SHA}`);
});