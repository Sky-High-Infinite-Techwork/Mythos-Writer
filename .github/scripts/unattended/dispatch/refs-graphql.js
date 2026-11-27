'use strict';

const ZERO_OID = '0000000000000000000000000000000000000000';
const DISPATCH_REF_ROOT = 'refs/mythos/dispatch/';
const OID_HEX = /^[0-9a-f]{40}$/i;
/** Exact allowed write/get shapes. Prefix-only would allow look-alikes such as ../heads. */
const ALLOWED_DISPATCH_REF = /^refs\/mythos\/dispatch\/(lane-\d{2}|claim\/\d+-\d+|attempts\/\d+-\d+|done\/\d+-\d+|canary\/scratch-\d+-\d+)$/;
const STABLE_DELETE_REASONS = new Set(['ref_changed', 'not_found', 'write_failed']);
const STABLE_MUTATION_REASONS = new Set([
  'ref_changed',
  'not_found',
  'write_failed',
  'ref_exists',
  'lane_full',
  'files_overlap',
  'slice_already_claimed',
  'switch_off',
  'switch_read',
  'list_failed',
  'invalid_lane_cap',
  'no_write_token',
  'repo_node_id',
  'missing_before_oid',
  'missing_oid',
  'graphql_no_update_refs',
  'create_failed',
  'update_refs_failed',
  'delete_failed',
  'lease_mismatch',
  'parent_tree',
  'commit_parse',
  'invalid_parent_sha',
  'attempts_write_failed',
]);

/** GitHub GraphQL updateRefs lost-race message (canary records this exact string). */
const UPDATE_REFS_REF_EXISTS = 'Reference already exists';

const UPDATE_REFS_MUTATION = 'mutation($repositoryId:ID!,$refUpdates:[RefUpdate!]!){updateRefs(input:{repositoryId:$repositoryId,refUpdates:$refUpdates}){clientMutationId}}';

function assertDispatchRef(ref) {
  const name = String(ref || '');
  if (!ALLOWED_DISPATCH_REF.test(name)) {
    throw new Error('ref outside dispatch namespace');
  }
  return ref;
}

function stableDispatchDeleteReason(result) {
  const err = result && typeof result.error === 'string' ? result.error : '';
  const reason = result && typeof result.reason === 'string' ? result.reason : '';
  if (STABLE_DELETE_REASONS.has(err)) return err;
  if (STABLE_DELETE_REASONS.has(reason)) return reason;
  const status = result && (result.status ?? result.ghStatus);
  const text = `${err} ${reason}`;
  if (status === 404 || /\b404\b/.test(text) || /not found|does not exist|reference does not/i.test(text)) {
    return 'not_found';
  }
  if (
    status === 409
    || /ref_changed|updated from|has been updated|not at the expected|expected oid|conflict|oid mismatch/i.test(text)
  ) {
    return 'ref_changed';
  }
  return 'write_failed';
}

function stableDispatchMutationReason(err, fallback = 'write_failed') {
  if (STABLE_MUTATION_REASONS.has(err)) return err;
  if (STABLE_DELETE_REASONS.has(err)) return err;
  const mapped = stableDispatchDeleteReason({ error: typeof err === 'string' ? err : '' });
  if (mapped !== 'write_failed') return mapped;
  return STABLE_MUTATION_REASONS.has(fallback) ? fallback : 'write_failed';
}

function assertSha40(oid, label) {
  if (!OID_HEX.test(String(oid || ''))) {
    throw new Error(`${label} must be a 40-character hex OID`);
  }
}

function refUpdateCreate(ref, afterOid) {
  assertDispatchRef(ref);
  assertSha40(afterOid, 'afterOid');
  return { name: ref, afterOid, beforeOid: ZERO_OID };
}

function refUpdateDelete(ref, beforeOid) {
  assertDispatchRef(ref);
  assertSha40(beforeOid, 'beforeOid');
  return { name: ref, afterOid: ZERO_OID, beforeOid };
}

function refUpdateRenew(ref, afterOid, beforeOid) {
  assertDispatchRef(ref);
  assertSha40(afterOid, 'afterOid');
  assertSha40(beforeOid, 'beforeOid');
  if (beforeOid === ZERO_OID) {
    throw new Error('beforeOid must not be the zero OID for renew');
  }
  if (afterOid === ZERO_OID) {
    throw new Error('afterOid must not be the zero OID for renew');
  }
  return { name: ref, afterOid, beforeOid, force: true };
}

function parseGraphqlErrors(stdout) {
  try {
    const data = JSON.parse(stdout || '{}');
    if (Array.isArray(data.errors) && data.errors.length) return data.errors;
  } catch {
    /* not JSON */
  }
  return null;
}

function isRefExistsError(errors) {
  return Array.isArray(errors) && errors.some((e) => e && e.message === UPDATE_REFS_REF_EXISTS);
}

module.exports = {
  ZERO_OID,
  DISPATCH_REF_ROOT,
  ALLOWED_DISPATCH_REF,
  OID_HEX,
  UPDATE_REFS_REF_EXISTS,
  UPDATE_REFS_MUTATION,
  STABLE_DELETE_REASONS,
  stableDispatchDeleteReason,
  stableDispatchMutationReason,
  assertDispatchRef,
  assertSha40,
  refUpdateCreate,
  refUpdateDelete,
  refUpdateRenew,
  parseGraphqlErrors,
  isRefExistsError,
};