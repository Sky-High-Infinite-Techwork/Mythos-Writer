'use strict';

const ZERO_OID = '0000000000000000000000000000000000000000';
const DISPATCH_REF_ROOT = 'refs/mythos/dispatch/';
const OID_HEX = /^[0-9a-f]{40}$/i;

/** GitHub GraphQL updateRefs lost-race message (canary records this exact string). */
const UPDATE_REFS_REF_EXISTS = 'Reference already exists';

const UPDATE_REFS_MUTATION = 'mutation($repositoryId:ID!,$refUpdates:[RefUpdate!]!){updateRefs(input:{repositoryId:$repositoryId,refUpdates:$refUpdates}){clientMutationId}}';

function assertDispatchRef(ref) {
  if (!ref || !String(ref).startsWith(DISPATCH_REF_ROOT)) {
    throw new Error(`ref outside dispatch namespace: ${ref}`);
  }
  return ref;
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
  OID_HEX,
  UPDATE_REFS_REF_EXISTS,
  UPDATE_REFS_MUTATION,
  assertDispatchRef,
  assertSha40,
  refUpdateCreate,
  refUpdateDelete,
  refUpdateRenew,
  parseGraphqlErrors,
  isRefExistsError,
};