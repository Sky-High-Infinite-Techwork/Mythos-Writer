import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installedPlaywright = path.join(repoRoot, 'node_modules', 'playwright', 'cli.js');

const SUITES = {
  'key-actions': {
    spec: 'e2e/perf/key-actions.spec.ts',
    output: 'test-results/key-actions',
    report: 'playwright-report/key-actions',
    retries: '0',
  },
  'wallpaper-picker': {
    spec: 'e2e/wallpaper-picker.spec.ts',
    output: 'test-results/wallpaper-picker',
    report: 'playwright-report/wallpaper-picker',
    retries: null,
  },
};

function parseArgs(argv) {
  const extra = [];
  let only = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') {
      only = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--only=')) {
      only = arg.slice('--only='.length);
      continue;
    }
    extra.push(arg);
  }
  const names = only === null ? ['key-actions', 'wallpaper-picker'] : [only];
  return { names, extra };
}

function hasGrep(extra) {
  return extra.some((arg) => arg === '--grep' || arg.startsWith('--grep='));
}

function suiteArgs(suite, extra, grepFiltered) {
  const args = ['test', suite.spec, `--output=${suite.output}`];
  if (suite.retries !== null) args.push(`--retries=${suite.retries}`);
  args.push(grepFiltered ? '--reporter=list,html,json' : '--reporter=list,html');
  if (grepFiltered) args.push('--pass-with-no-tests');
  args.push(...extra);
  return args;
}

function executedCount(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const stats = report.stats ?? {};
  return (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.flaky ?? 0);
}

/**
 * Spawn npm as `node npm-cli.js` with no shell. Windows rejects `.cmd` / `.bat`
 * spawns unless a shell is used (CVE-2024-27980), and a shell would re-quote argv.
 * `npm_execpath` is the JS entry when npm itself started this process. Otherwise
 * the CLI sits next to the node binary.
 */
export function npmLaunch(npmArgs, options = {}) {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path;
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const fromEnv = env.npm_execpath;
  const beside = pathApi.join(pathApi.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cli = typeof fromEnv === 'string' && fromEnv.length > 0 && !/\.(cmd|bat)$/i.test(fromEnv)
    ? fromEnv
    : beside;
  return { command: execPath, args: [cli, ...npmArgs], shell: false };
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
      shell: false,
      windowsHide: true,
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function runSuites(argv, options = {}) {
  const playwright = options.playwrightCli ?? installedPlaywright;
  const { names, extra } = parseArgs(argv);
  const grepFiltered = hasGrep(extra);
  let failed = false;
  let executed = 0;
  for (const name of names) {
    if (!Object.hasOwn(SUITES, name)) {
      console.error(`unknown e2e suite ${name}`);
      return 1;
    }
    const suite = SUITES[name];
    const jsonFile = grepFiltered
      ? path.join(os.tmpdir(), `mythos-e2e-${name}-${process.pid}-${Math.random().toString(16).slice(2)}.json`)
      : null;
    const code = await run(
      process.execPath,
      [playwright, ...suiteArgs(suite, extra, grepFiltered)],
      {
        PLAYWRIGHT_HTML_REPORT: suite.report,
        ...(jsonFile ? { PLAYWRIGHT_JSON_OUTPUT_FILE: jsonFile } : {}),
      },
    );
    if (code !== 0) failed = true;
    if (jsonFile) {
      if (fs.existsSync(jsonFile)) {
        try {
          executed += executedCount(jsonFile);
        } finally {
          fs.rmSync(jsonFile, { force: true });
        }
      }
    }
  }
  if (grepFiltered && executed === 0) {
    console.error('grep matched no tests');
    failed = true;
  }
  return failed ? 1 : 0;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const code = await runSuites(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
