import { spawn } from 'node:child_process';
import path from 'node:path';

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

const playwright = path.join('node_modules', 'playwright', 'cli.js');
const keyActions = await run(process.execPath, [
  playwright,
  'test',
  'e2e/perf/key-actions.spec.ts',
  '--output=test-results/key-actions',
  '--retries=0',
  // Sample pass only: 20 content-visible switch timings in one CI job. Removed once budgets are set.
  '--repeat-each=20',
  '--reporter=list,html',
], { PLAYWRIGHT_HTML_REPORT: 'playwright-report/key-actions' });
const wallpaper = await run(process.execPath, [
  playwright,
  'test',
  'e2e/wallpaper-picker.spec.ts',
  '--output=test-results/wallpaper-picker',
  '--reporter=list,html',
], { PLAYWRIGHT_HTML_REPORT: 'playwright-report/wallpaper-picker' });

if (keyActions !== 0 || wallpaper !== 0) process.exit(1);
