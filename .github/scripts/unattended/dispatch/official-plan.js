'use strict';

const {
  OFFICIAL_PLAN_AUTHORS,
  OFFICIAL_FILES_HEADING,
  sha256Hex,
} = require('./constants');
const { normalizePlanPaths } = require('./path-policy');

function canonicalAuthorLogin(author) {
  const login = author && typeof author.login === 'string' ? author.login.trim().toLowerCase() : '';
  if (!login) return '';
  const isBot = author && (author.__typename === 'Bot' || author.type === 'Bot');
  if (isBot && !login.endsWith('[bot]')) return `${login}[bot]`;
  return login;
}

function isTrustedPlanAuthor(author) {
  const login = canonicalAuthorLogin(author);
  return OFFICIAL_PLAN_AUTHORS.has(login);
}

function stripFencedRegions(body) {
  const lines = String(body || '').split(/\r?\n/);
  const out = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

function parseFilesSection(body) {
  const text = stripFencedRegions(body);
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === OFFICIAL_FILES_HEADING);
  // Indented "## Files" is not the official heading (must be trim-equal).
  if (headingIndex < 0) return { kind: 'no_heading' };
  const rawEntries = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#')) break;
    if (!/^[-*]\s+/.test(line) && !/^[`\w@./\-*?[\]+]+$/.test(line.replace(/^`+|`+$/g, ''))) {
      return { kind: 'invalid_entry', line };
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      rawEntries.push(line.replace(/^[-*]\s+/, '').trim());
      continue;
    }
    rawEntries.push(line);
  }
  const cleaned = rawEntries.map((entry) => entry.replace(/^`+|`+$/g, '').trim());
  if (cleaned.length === 0) return { kind: 'empty' };
  const normalized = normalizePlanPaths(cleaned);
  if (!normalized.ok) return { kind: 'invalid_path', reason: normalized.reason, entry: normalized.entry };
  return { kind: 'ok', files: normalized.files };
}

function findOfficialPlan(comments) {
  const sorted = (comments || [])
    .filter((c) => c && isTrustedPlanAuthor(c.author))
    .slice()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  for (const comment of sorted) {
    const section = parseFilesSection(comment.body);
    if (section.kind === 'no_heading') continue;
    if (section.kind === 'empty') {
      return { hold: true, reason: 'empty_files', commentId: comment.id, author: canonicalAuthorLogin(comment.author) };
    }
    if (section.kind === 'invalid_entry' || section.kind === 'invalid_path') {
      return { hold: true, reason: section.kind, detail: section.reason || section.line, commentId: comment.id };
    }
    const bodySha256 = sha256Hex(comment.body);
    return {
      commentId: comment.id,
      databaseId: comment.databaseId,
      author: canonicalAuthorLogin(comment.author),
      editor: comment.editor ? canonicalAuthorLogin(comment.editor) : canonicalAuthorLogin(comment.author),
      body: comment.body,
      bodySha256,
      files: section.files,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      lastEditedAt: comment.lastEditedAt || comment.updatedAt,
    };
  }
  return null;
}

function planCommentEditedByUntrusted(official) {
  if (!official) return { hold: false };
  const created = official.createdAt || '';
  const edited = official.lastEditedAt || official.updatedAt || created;
  if (edited && created && edited !== created) {
    const editor = official.editor || official.author;
    const login = canonicalAuthorLogin(editor);
    if (!OFFICIAL_PLAN_AUTHORS.has(login)) return { hold: true, editor: login };
  }
  return { hold: false };
}

/** @deprecated use planCommentEditedByUntrusted */
function issueEditedByUntrusted(events) {
  for (const ev of events || []) {
    if (ev.event !== 'edited') continue;
    const login = canonicalAuthorLogin(ev.actor || { login: ev.actor && ev.actor.login });
    if (!OFFICIAL_PLAN_AUTHORS.has(login)) return { hold: true, editor: login };
  }
  return { hold: false };
}

module.exports = {
  canonicalAuthorLogin,
  isTrustedPlanAuthor,
  stripFencedRegions,
  parseFilesSection,
  findOfficialPlan,
  planCommentEditedByUntrusted,
  issueEditedByUntrusted,
};