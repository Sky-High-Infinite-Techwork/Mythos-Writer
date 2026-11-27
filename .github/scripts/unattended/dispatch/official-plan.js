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

function fenceMarker(line) {
  const m = String(line).match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  return {
    indent: m[1].length,
    marker: m[2][0],
    length: m[2].length,
    // CommonMark: a closing fence may have only trailing whitespace, not an info string.
    isClosing: /^\s*$/.test(m[3]),
  };
}

function stripFencedRegions(body) {
  const lines = String(body || '').split(/\r?\n/);
  const out = [];
  let open = null;
  for (const line of lines) {
    const fence = fenceMarker(line);
    if (fence) {
      if (fence.indent >= 4) {
        if (!open) out.push(line);
        continue;
      }
      if (!open) {
        open = fence;
        continue;
      }
      if (fence.isClosing && fence.marker === open.marker && fence.length >= open.length) {
        open = null;
      }
      continue;
    }
    if (!open) out.push(line);
  }
  return out.join('\n');
}

function parseFilesSection(body) {
  const text = stripFencedRegions(body);
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^\s{0,3}## Files\s*$/.test(line));
  // More than three leading spaces before "## Files" is not the official heading.
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
      nodeId: comment.nodeId || comment.node_id || null,
      author: canonicalAuthorLogin(comment.author),
      body: comment.body,
      bodySha256,
      files: section.files,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
  }
  return null;
}

async function verifyPlanCommentEditors(client, issueNumber, official) {
  if (!official || official.hold) return { hold: false };
  // Always fetch edit history. Matching or missing timestamps can still hide a
  // same-second edit, so acceptance requires complete evidence for the body.
  if (!client || typeof client.issueCommentContentEdits !== 'function') {
    return { hold: true, reason: 'editor_verify_unavailable' };
  }
  const edits = await client.issueCommentContentEdits({
    issue: issueNumber,
    commentNodeId: official.nodeId,
    commentDatabaseId: official.databaseId || official.commentId,
  });
  if (!edits.ok) {
    const err = edits.error || '';
    if (err === 'editor_redacted') return { hold: true, reason: 'editor_redacted' };
    if (err === 'editor_history_incomplete' || err === 'comment_not_found') {
      return { hold: true, reason: err === 'comment_not_found' ? 'editor_fetch_failed' : 'editor_history_incomplete' };
    }
    return { hold: true, reason: 'editor_fetch_failed' };
  }
  if (edits.complete !== true) {
    return { hold: true, reason: 'editor_history_incomplete' };
  }
  const editors = Array.isArray(edits.editors) ? edits.editors : [];
  const created = official.createdAt || '';
  const updated = official.updatedAt || '';
  const timestampsDiffer = Boolean(created && updated && updated !== created);
  // A known edit (timestamps differ) with no attributable editors is incomplete.
  // Same-second or unedited comments may have an empty complete history.
  if (timestampsDiffer && editors.length === 0) {
    return { hold: true, reason: 'editor_history_incomplete' };
  }
  for (const editor of editors) {
    const login = canonicalAuthorLogin(editor);
    if (!OFFICIAL_PLAN_AUTHORS.has(login)) {
      return { hold: true, reason: 'untrusted_editor', editor: login };
    }
  }
  return { hold: false };
}

module.exports = {
  canonicalAuthorLogin,
  isTrustedPlanAuthor,
  stripFencedRegions,
  parseFilesSection,
  findOfficialPlan,
  verifyPlanCommentEditors,
  OFFICIAL_FILES_HEADING,
};