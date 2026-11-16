'use strict';

const {
  OFFICIAL_PLAN_AUTHORS,
  OFFICIAL_FILES_HEADING,
  sha256Hex,
} = require('./constants');

function canonicalAuthorLogin(author) {
  const login = author && typeof author.login === 'string' ? author.login.trim().toLowerCase() : '';
  if (!login) return '';
  if (author && author.__typename === 'Bot' && !login.endsWith('[bot]')) return `${login}[bot]`;
  return login;
}

function isTrustedPlanAuthor(author) {
  const login = canonicalAuthorLogin(author);
  return OFFICIAL_PLAN_AUTHORS.has(login);
}

function parseFilesSection(body) {
  const lines = String(body || '').split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === OFFICIAL_FILES_HEADING);
  if (headingIndex < 0) return null;
  const files = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#')) break;
    if (line.startsWith('- ') || line.startsWith('* ')) {
      files.push(line.replace(/^[-*]\s+/, '').trim());
      continue;
    }
    files.push(line);
  }
  const normalized = files
    .map((entry) => entry.replace(/^`+|`+$/g, '').trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : null;
}

function findOfficialPlan(comments) {
  const sorted = (comments || [])
    .filter((c) => c && isTrustedPlanAuthor(c.author))
    .slice()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  for (const comment of sorted) {
    const files = parseFilesSection(comment.body);
    if (!files) continue;
    const bodySha256 = sha256Hex(comment.body);
    return {
      commentId: comment.id,
      databaseId: comment.databaseId,
      author: canonicalAuthorLogin(comment.author),
      body: comment.body,
      bodySha256,
      files,
      createdAt: comment.createdAt,
    };
  }
  return null;
}

module.exports = {
  canonicalAuthorLogin,
  isTrustedPlanAuthor,
  parseFilesSection,
  findOfficialPlan,
};