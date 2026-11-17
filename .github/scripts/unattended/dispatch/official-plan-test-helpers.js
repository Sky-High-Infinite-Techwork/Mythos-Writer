'use strict';

const { OFFICIAL_PLAN_AUTHORS } = require('./constants');
const { canonicalAuthorLogin } = require('./official-plan');

function planCommentEditedByUntrusted(official) {
  if (!official) return { hold: false };
  const created = official.createdAt || '';
  const edited = official.lastEditedAt || official.updatedAt || created;
  if (edited && created && edited !== created) {
    const editor = official.editor || official.author;
    const login = typeof editor === 'string' ? editor.trim().toLowerCase() : canonicalAuthorLogin(editor);
    if (!OFFICIAL_PLAN_AUTHORS.has(login)) return { hold: true, editor: login };
  }
  return { hold: false };
}

function issueEditedByUntrusted(events) {
  for (const ev of events || []) {
    if (ev.event !== 'edited') continue;
    const login = canonicalAuthorLogin(ev.actor || { login: ev.actor && ev.actor.login });
    if (!OFFICIAL_PLAN_AUTHORS.has(login)) return { hold: true, editor: login };
  }
  return { hold: false };
}

module.exports = {
  planCommentEditedByUntrusted,
  issueEditedByUntrusted,
};