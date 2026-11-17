'use strict';

const ZERO_OID = '0000000000000000000000000000000000000000';
const DISPATCH_REF_ROOT = 'refs/mythos/dispatch/';

const UPDATE_REFS_MUTATION = 'mutation($repositoryId:ID!,$refUpdates:[RefUpdate!]!){updateRefs(input:{repositoryId:$repositoryId,refUpdates:$refUpdates}){clientMutationId}}';

function assertDispatchRef(ref) {
  if (!ref || !String(ref).startsWith(DISPATCH_REF_ROOT)) {
    throw new Error(`ref outside dispatch namespace: ${ref}`);
  }
  return ref;
}

function refUpdateCreate(ref, oid) {
  assertDispatchRef(ref);
  return { name: ref, oid, beforeOid: ZERO_OID };
}

function refUpdateDelete(ref, beforeOid) {
  assertDispatchRef(ref);
  return { name: ref, oid: ZERO_OID, beforeOid };
}

function refUpdateRenew(ref, newOid, beforeOid) {
  assertDispatchRef(ref);
  return { name: ref, oid: newOid, beforeOid };
}

function parseGraphqlErrors(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  try {
    const data = JSON.parse(stdout || '{}');
    if (data.errors) return data.errors;
  } catch {
    /* fall through */
  }
  if (/Reference already exists/i.test(text)) {
    return [{ message: 'Reference already exists' }];
  }
  return null;
}

function isRefExistsError(errors) {
  return Array.isArray(errors) && errors.some((e) => e && e.message === 'Reference already exists');
}

module.exports = {
  ZERO_OID,
  DISPATCH_REF_ROOT,
  UPDATE_REFS_MUTATION,
  assertDispatchRef,
  refUpdateCreate,
  refUpdateDelete,
  refUpdateRenew,
  parseGraphqlErrors,
  isRefExistsError,
};