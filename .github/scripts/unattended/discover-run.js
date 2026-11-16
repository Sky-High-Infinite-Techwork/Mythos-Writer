'use strict';

const fs = require('node:fs');
const { REPO, sha40 } = require('./constants');
const { gh } = require('./spawn');

function selectHead(prs, only) {
  const rows = (prs || []).filter((pr) => pr
    && pr.state === 'open'
    && pr.draft !== true
    && pr.fork !== true
    && pr.base === 'main'
    && sha40(pr.head)
    && Number.isInteger(pr.number)
    && pr.number > 0);
  if (only) return rows.find((pr) => String(pr.number) === String(only)) || null;
  rows.sort((left, right) => left.number - right.number);
  return rows[0] || null;
}

function mapPull(row) {
  const headRepo = row && row.head && row.head.repo && row.head.repo.full_name;
  return {
    number: row && row.number,
    state: String((row && row.state) || '').toLowerCase(),
    draft: Boolean(row && row.draft),
    fork: headRepo !== REPO,
    base: row && row.base && row.base.ref,
    head: row && row.head && row.head.sha,
  };
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${name}=${value}\n`);
}

function main() {
  if ((process.env.REPO || REPO) !== REPO) {
    process.stderr.write('refuse: repository\n');
    return 1;
  }
  const only = process.env.PR_NUMBER || '';
  if (only && !/^[1-9][0-9]{0,9}$/.test(only)) {
    process.stderr.write('refuse: pr\n');
    return 1;
  }
  const listed = gh(['api', '--paginate', '--slurp', `repos/${REPO}/pulls?state=open&per_page=100`], process.env.READ_TOKEN);
  if (listed.status !== 0) {
    process.stderr.write('discover: pull request list unreadable\n');
    return 1;
  }
  let pages;
  try {
    pages = JSON.parse(listed.stdout);
  } catch {
    process.stderr.write('discover: pull request list unreadable\n');
    return 1;
  }
  const flat = Array.isArray(pages) && pages.length && Array.isArray(pages[0]) ? pages.flat() : pages;
  const chosen = selectHead((flat || []).map(mapPull), only);
  setOutput('pr', chosen ? String(chosen.number) : '');
  setOutput('head', chosen ? chosen.head : '');
  process.stdout.write(chosen ? `discover #${chosen.number} ${chosen.head}\n` : 'discover: no head\n');
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { selectHead, mapPull };
