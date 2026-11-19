'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CANARY_LEG_COUNT = 6;
const CANARY_INDEXES = new Set([0, 1, 2, 3, 4, 5]);

function readCanaryOutcomesFromDir(dir) {
  const outcomes = [];
  if (!dir || !fs.existsSync(dir)) return outcomes;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    try {
      outcomes.push(JSON.parse(fs.readFileSync(full, 'utf8')));
    } catch {
      return null;
    }
  }
  return outcomes;
}

function evaluateCanaryOutcomes(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length !== CANARY_LEG_COUNT) {
    return {
      ok: false,
      reason: 'outcome_count',
      wins: 0,
      loses: 0,
      fatals: 0,
      total: outcomes?.length ?? 0,
    };
  }
  const indexes = new Set();
  let wins = 0;
  let loses = 0;
  let fatals = 0;
  for (const row of outcomes) {
    const idx = row && row.index;
    if (idx === undefined || idx === null || !CANARY_INDEXES.has(Number(idx))) {
      return {
        ok: false,
        reason: 'index_invalid',
        wins,
        loses,
        fatals,
        total: outcomes.length,
      };
    }
    if (indexes.has(Number(idx))) {
      return {
        ok: false,
        reason: 'index_duplicate',
        wins,
        loses,
        fatals,
        total: outcomes.length,
      };
    }
    indexes.add(Number(idx));
    if (row.kind === 'canary_win') wins += 1;
    else if (row.kind === 'canary_lose') loses += 1;
    else if (row.kind === 'canary_fatal') fatals += 1;
  }
  if (indexes.size !== CANARY_LEG_COUNT) {
    return {
      ok: false,
      reason: 'index_missing',
      wins,
      loses,
      fatals,
      total: outcomes.length,
    };
  }
  if (wins !== 1 || loses !== 5 || fatals !== 0) {
    return {
      ok: false,
      reason: 'counts',
      wins,
      loses,
      fatals,
      total: outcomes.length,
    };
  }
  return { ok: true, wins, loses, fatals, total: outcomes.length };
}

module.exports = {
  CANARY_LEG_COUNT,
  readCanaryOutcomesFromDir,
  evaluateCanaryOutcomes,
};