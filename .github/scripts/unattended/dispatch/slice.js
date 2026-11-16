'use strict';

const { protectedPath } = require('./constants');

function globToRegExp(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function pathMatchesClaim(changedPath, claimEntry) {
  if (!changedPath || !claimEntry) return false;
  if (claimEntry.includes('*')) return globToRegExp(claimEntry).test(changedPath);
  return changedPath === claimEntry;
}

function pathsOverlap(filesA, filesB) {
  const a = filesA || [];
  const b = filesB || [];
  for (const left of a) {
    for (const right of b) {
      if (left === right) return true;
      if (left.includes('*') || right.includes('*')) {
        const l = globToRegExp(left);
        const r = globToRegExp(right);
        if (l.test(right) || r.test(left)) return true;
      }
    }
  }
  return false;
}

function defaultSlices(planFiles) {
  return [{ index: 0, files: planFiles.slice() }];
}

function anyProtectedInClaim(files) {
  return (files || []).some((entry) => {
    if (entry.includes('*')) return false;
    return protectedPath(entry);
  });
}

function diffWithinClaim(changedFiles, claimFiles) {
  for (const file of changedFiles || []) {
    const name = file.filename || file;
    const ok = (claimFiles || []).some((entry) => pathMatchesClaim(name, entry));
    if (!ok) return { ok: false, reason: `out of claim: ${name}` };
    if (protectedPath(name) || protectedPath(file.previous_filename || '')) {
      return { ok: false, reason: `protected path: ${name}` };
    }
  }
  return { ok: true };
}

module.exports = {
  globToRegExp,
  pathMatchesClaim,
  pathsOverlap,
  defaultSlices,
  anyProtectedInClaim,
  diffWithinClaim,
};