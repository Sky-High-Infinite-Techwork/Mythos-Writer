'use strict';

const fs = require('node:fs');
const { REPO, sha40, CHECK_NAME, GATE_APP_ID } = require('./constants');
const { gh } = require('./spawn');
const { parseProvidersJson } = require('./gate-result');
const { parseAllowlist, authorMatches } = require('./flow-client');
const { readCompare } = require('./transport');
const { reviewPlan } = require('./risk-policy');

const DISCOVER_SLOT_SECONDS = 600;

function shapeOk(pr) {
  return Boolean(pr
    && pr.state === 'open'
    && pr.draft !== true
    && pr.fork !== true
    && pr.base === 'main'
    && sha40(pr.head)
    && sha40(pr.baseSha)
    && Number.isInteger(pr.number)
    && pr.number > 0);
}

function holdLabel(pr) {
  const labels = (pr.labels || []).map((name) => String(name).toLowerCase());
  if (labels.includes('hold') || labels.includes('do-not-merge')) return true;
  return labels.includes('carve-out') && pr.ownerPath === true;
}

function eligible(pr) {
  return shapeOk(pr)
    && pr.authorAllowed === true
    && pr.author !== 'dependabot[bot]'
    && pr.ownerPath !== true
    && pr.gatePosted !== true
    && !holdLabel(pr);
}

function selectHead(prs, only, nowSeconds) {
  if (only) return (prs || []).find((pr) => shapeOk(pr) && String(pr.number) === String(only)) || null;
  const rows = (prs || []).filter(eligible);
  rows.sort((left, right) => left.number - right.number);
  if (!rows.length) return null;
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  return rows[Math.floor(now / DISCOVER_SLOT_SECONDS) % rows.length];
}

function mapPull(row) {
  const headRepo = row && row.head && row.head.repo && row.head.repo.full_name;
  return {
    number: row && row.number,
    state: String((row && row.state) || '').toLowerCase(),
    draft: Boolean(row && row.draft),
    fork: headRepo !== REPO,
    base: row && row.base && row.base.ref,
    baseSha: row && row.base && row.base.sha,
    head: row && row.head && row.head.sha,
    author: row && row.user && row.user.login,
    labels: Array.isArray(row && row.labels)
      ? row.labels.map((label) => (label && label.name) || label).filter((name) => typeof name === 'string')
      : [],
  };
}

function gatePosted(head) {
  const route = `repos/${REPO}/commits/${head}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`;
  const result = gh(['api', route], process.env.READ_TOKEN);
  if (result.status !== 0) return null;
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!body || !Array.isArray(body.check_runs)) return null;
  if (body.total_count > body.check_runs.length) return null;
  return body.check_runs.some((run) => run && run.head_sha === head && run.app && run.app.id === GATE_APP_ID);
}

function compareClass(baseSha, headSha) {
  const compared = gh(['api', `repos/${REPO}/compare/${baseSha}...${headSha}`], process.env.READ_TOKEN);
  if (compared.status !== 0) return null;
  let body;
  try {
    body = JSON.parse(compared.stdout);
  } catch {
    return null;
  }
  const threshold = thresholdFromCompare(body, baseSha, headSha);
  if (threshold !== 'strict' && threshold !== 'standard' && threshold !== 'owner') return null;
  return { ownerPath: threshold === 'owner', threshold };
}

// The class is the compare's file list at the discovered SHAs, not the live pull request files.
function thresholdFromCompare(body, baseSha, headSha) {
  const read = readCompare(body, baseSha, headSha);
  if (!read.ok) return '';
  if (read.files.length >= 300) return '';
  return reviewPlan(read.files).threshold;
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
  const allowlist = parseAllowlist(process.env.MYTHOS_FLOW_AUTHOR_ALLOWLIST);
  const annotated = [];
  for (const pr of (flat || []).map(mapPull)) {
    const authorAllowed = authorMatches({ login: pr.author }, allowlist);
    const manual = only && String(pr.number) === String(only);
    let gate = false;
    let ownerPath = false;
    let threshold = '';
    const reviewable = authorAllowed && pr.author !== 'dependabot[bot]';
    if (reviewable || manual) {
      if (!manual) {
        const posted = sha40(pr.head) ? gatePosted(pr.head) : null;
        if (posted === null) {
          annotated.push({ ...pr, authorAllowed, gatePosted: true });
          continue;
        }
        gate = posted;
        if (posted) {
          annotated.push({ ...pr, authorAllowed, gatePosted: true });
          continue;
        }
      }
      if (sha40(pr.baseSha) && sha40(pr.head)) {
        const compared = compareClass(pr.baseSha, pr.head);
        if (!compared) {
          annotated.push({ ...pr, authorAllowed, ownerPath: !manual });
          continue;
        }
        ownerPath = compared.ownerPath;
        threshold = compared.threshold;
      }
    }
    annotated.push({ ...pr, authorAllowed, gatePosted: gate, ownerPath, threshold });
  }
  const chosen = selectHead(annotated, only, Math.floor(Date.now() / 1000));
  const providers = parseProvidersJson(process.env.MYTHOS_GATE_PROVIDERS_JSON);
  const threshold = chosen && (chosen.threshold === 'strict' || chosen.threshold === 'standard') ? chosen.threshold : '';
  setOutput('pr', chosen ? String(chosen.number) : '');
  setOutput('head', chosen ? chosen.head : '');
  setOutput('base', chosen ? chosen.baseSha : '');
  setOutput('threshold', threshold);
  setOutput('run_claude', providers.ok && providers.providers.includes('claude') ? 'true' : 'false');
  setOutput('run_codex', providers.ok && providers.providers.includes('codex') ? 'true' : 'false');
  process.stdout.write(chosen ? `discover #${chosen.number} ${chosen.head}\n` : 'discover: no head\n');
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { selectHead, mapPull, thresholdFromCompare, DISCOVER_SLOT_SECONDS };
