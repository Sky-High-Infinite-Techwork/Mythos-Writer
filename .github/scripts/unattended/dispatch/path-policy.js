'use strict';

const { protectedPath, protectedLiteralPrefix } = require('./constants');

const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

function literalPrefixBeforeWildcard(glob) {
  const idx = String(glob).search(/[*?[]/);
  if (idx < 0) return glob;
  return glob.slice(0, idx);
}

function validatePlanPathEntry(raw) {
  const entry = String(raw || '').trim();
  if (!entry) return { ok: false, reason: 'empty' };
  if (CONTROL_CHAR.test(entry)) return { ok: false, reason: 'control_char' };
  if (entry.includes('..')) return { ok: false, reason: 'dotdot' };
  if (entry.startsWith('/') || entry.startsWith('./')) return { ok: false, reason: 'absolute' };
  if (entry.includes('\\')) return { ok: false, reason: 'backslash' };
  if (entry === '*' || entry === '**') return { ok: false, reason: 'bare_glob' };
  if (/[\[\]]/.test(entry)) return { ok: false, reason: 'bracket_char' };
  if (!/^[\w@./\-*?]+$/i.test(entry)) return { ok: false, reason: 'not_path_like' };
  return { ok: true, entry };
}

function normalizePlanPaths(entries) {
  const normalized = [];
  for (const raw of entries || []) {
    const check = validatePlanPathEntry(raw);
    if (!check.ok) return { ok: false, reason: check.reason, entry: raw };
    normalized.push(check.entry);
  }
  return { ok: true, files: normalized };
}

function globEntryOverlaps(a, b) {
  const left = String(a);
  const right = String(b);
  if (left === right) return true;
  const pL = literalPrefixBeforeWildcard(left);
  const pR = literalPrefixBeforeWildcard(right);
  if (!left.includes('*') && !left.includes('?') && !right.includes('*') && !right.includes('?')) {
    return left === right;
  }
  if (!pL || !pR) return true;
  if (pL === pR) return true;
  if (pL.startsWith(pR) || pR.startsWith(pL)) return true;
  return false;
}

function globsOverlap(filesA, filesB) {
  for (const a of filesA || []) {
    for (const b of filesB || []) {
      if (globEntryOverlaps(a, b)) return true;
    }
  }
  return false;
}

function globOrPathProtected(entry) {
  if (!entry || typeof entry !== 'string') return false;
  if (!entry.includes('*') && !entry.includes('?')) return protectedPath(entry);
  const prefix = literalPrefixBeforeWildcard(entry);
  if (!prefix) return true;
  return protectedLiteralPrefix(prefix);
}

function anyProtectedInPlanFiles(files) {
  return (files || []).some((entry) => globOrPathProtected(entry));
}

function globToRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (ch === '?') {
      pattern += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      pattern += `\\${ch}`;
    } else {
      pattern += ch;
    }
  }
  return new RegExp(`^${pattern}$`);
}

function pathMatchesClaim(changedPath, claimEntry) {
  if (!changedPath || !claimEntry) return false;
  if (claimEntry.includes('*') || claimEntry.includes('?')) {
    return globToRegExp(claimEntry).test(changedPath);
  }
  return changedPath === claimEntry;
}

function diffWithinClaim(changedFiles, claimFiles) {
  for (const file of changedFiles || []) {
    const name = file.filename || file;
    const prev = file.previous_filename || '';
    if (prev && !(claimFiles || []).some((entry) => pathMatchesClaim(prev, entry))) {
      return { ok: false, reason: `previous out of claim: ${prev}` };
    }
    const ok = (claimFiles || []).some((entry) => pathMatchesClaim(name, entry));
    if (!ok) return { ok: false, reason: `out of claim: ${name}` };
    if (globOrPathProtected(name) || (prev && globOrPathProtected(prev))) {
      return { ok: false, reason: `protected path: ${name}` };
    }
  }
  return { ok: true };
}

module.exports = {
  validatePlanPathEntry,
  normalizePlanPaths,
  globEntryOverlaps,
  globsOverlap,
  globOrPathProtected,
  anyProtectedInPlanFiles,
  globToRegExp,
  pathMatchesClaim,
  diffWithinClaim,
  literalPrefixBeforeWildcard,
};