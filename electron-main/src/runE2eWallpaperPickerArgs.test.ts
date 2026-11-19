import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { runSuites } from '../../scripts/run-e2e-wallpaper-picker.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const wrapper = path.join(repoRoot, 'scripts', 'run-e2e-wallpaper-picker.mjs');

interface RecordedRun {
  argv: string[];
  report: string;
}

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function writeStub(file: string): void {
  fs.writeFileSync(
    file,
    [
      "import fs from 'node:fs';",
      'const argv = process.argv.slice(2);',
      'fs.appendFileSync(process.env.MYTHOS_E2E_ARGV_LOG, JSON.stringify({',
      '  argv,',
      "  report: process.env.PLAYWRIGHT_HTML_REPORT ?? '',",
      "}) + '\\n');",
      'const jsonFile = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;',
      'if (jsonFile) {',
      "  const grepAt = argv.indexOf('--grep');",
      "  const grep = grepAt >= 0 ? argv[grepAt + 1] : '';",
      '  const spec = argv[1] ?? "";',
      '  let expected = 0;',
      "  if (grep === 'one-suite' && spec.includes('wallpaper-picker.spec.ts')) expected = 1;",
      "  if (grep === 'key-only' && spec.includes('key-actions.spec.ts')) expected = 1;",
      '  fs.writeFileSync(jsonFile, JSON.stringify({ stats: { expected, unexpected: 0, flaky: 0, skipped: 0 } }));',
      '}',
      '',
    ].join('\n'),
  );
}

function recorded(logFile: string): RecordedRun[] {
  return fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedRun);
}

describe('e2e wrapper forwards Playwright args', () => {
  it('non-grep args do not relax an empty suite, and a grep of nothing fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-argv-'));
    const stub = path.join(dir, 'playwright-stub.mjs');
    const logFile = path.join(dir, 'argv.log');
    writeStub(stub);
    fs.writeFileSync(logFile, '');
    const previousLog = process.env.MYTHOS_E2E_ARGV_LOG;
    process.env.MYTHOS_E2E_ARGV_LOG = logFile;
    try {
      const workersCode = await runSuites(['--workers', '1'], { playwrightCli: stub });
      const workers = recorded(logFile);
      expect(workersCode).toBe(0);
      expect(workers.map((run) => run.argv[1])).toEqual([
        'e2e/perf/key-actions.spec.ts',
        'e2e/wallpaper-picker.spec.ts',
      ]);
      for (const run of workers) {
        expect(run.argv).toEqual(expect.arrayContaining(['--workers', '1']));
        expect(run.argv).not.toContain('--pass-with-no-tests');
      }
      expect(workers[0]?.argv).toContain('--retries=0');
      expect(workers[1]?.argv).not.toContain('--retries=0');

      fs.writeFileSync(logFile, '');
      const noneCode = await runSuites(['--grep', 'matches-nothing'], { playwrightCli: stub });
      const none = recorded(logFile);
      expect(noneCode).not.toBe(0);
      expect(none).toHaveLength(2);
      for (const run of none) expect(run.argv).toContain('--grep');

      fs.writeFileSync(logFile, '');
      const oneCode = await runSuites(['--grep', 'one-suite'], { playwrightCli: stub });
      const one = recorded(logFile);
      expect(oneCode).toBe(0);
      expect(one.map((run) => run.argv[1])).toEqual([
        'e2e/perf/key-actions.spec.ts',
        'e2e/wallpaper-picker.spec.ts',
      ]);

      fs.writeFileSync(logFile, '');
      const keyCode = await runSuites(
        ['--only=key-actions', '--grep', 'key-only'],
        { playwrightCli: stub },
      );
      const onlyKey = recorded(logFile);
      expect(keyCode).toBe(0);
      expect(onlyKey).toHaveLength(1);
      expect(onlyKey[0]?.argv[1]).toBe('e2e/perf/key-actions.spec.ts');
      expect(onlyKey[0]?.argv).toEqual(expect.arrayContaining(['--grep', 'key-only']));
      expect(onlyKey[0]?.report).toBe('playwright-report/key-actions');

      expect(await runSuites(['--only=__proto__'], { playwrightCli: stub })).not.toBe(0);
      expect(fs.readFileSync(wrapper, 'utf8')).not.toContain('MYTHOS_E2E_PLAYWRIGHT');
    } finally {
      if (previousLog === undefined) delete process.env.MYTHOS_E2E_ARGV_LOG;
      else process.env.MYTHOS_E2E_ARGV_LOG = previousLog;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('spawns npm with the platform executable', async () => {
    const child = spawn(npmExecutable(), ['pkg', 'get', 'scripts.test:e2e:key-actions'], {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
    });
    const stdout = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('npm did not exit'));
      }, 8000);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`npm exited ${code}: ${out}`));
        else resolve(out);
      });
    });
    expect(stdout).toContain('node scripts/run-e2e-wallpaper-picker.mjs --only=key-actions');
    expect(stdout).not.toContain('PLAYWRIGHT_HTML_REPORT=');
  }, 30_000);
});
