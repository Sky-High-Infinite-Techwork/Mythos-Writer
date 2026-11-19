import { spawn } from 'node:child_process';
import path from 'node:path';

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

function suiteArgs(suite, extra) {
  const args = ['test', suite.spec, `--output=${suite.output}`];
  if (suite.retries !== null) args.push(`--retries=${suite.retries}`);
  args.push('--reporter=list,html');
  if (extra.length > 0) args.push('--pass-with-no-tests', ...extra);
  return args;
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
      shell: false,
      windowsHide: true,
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const playwright = process.env.MYTHOS_E2E_PLAYWRIGHT
  ?? path.join('node_modules', 'playwright', 'cli.js');
const { names, extra } = parseArgs(process.argv.slice(2));
let failed = false;
for (const name of names) {
  const suite = SUITES[name];
  if (!suite) {
    console.error(`unknown e2e suite ${name}`);
    process.exit(1);
  }
  const code = await run(
    process.execPath,
    [playwright, ...suiteArgs(suite, extra)],
    { PLAYWRIGHT_HTML_REPORT: suite.report },
  );
  if (code !== 0) failed = true;
}
if (failed) process.exit(1);
