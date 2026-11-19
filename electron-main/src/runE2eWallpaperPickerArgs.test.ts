import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');

interface RecordedRun {
  argv: string[];
  report: string;
}

function writeStub(file: string): void {
  fs.writeFileSync(
    file,
    [
      "import fs from 'node:fs';",
      'fs.appendFileSync(process.env.MYTHOS_E2E_ARGV_LOG, JSON.stringify({',
      '  argv: process.argv.slice(2),',
      "  report: process.env.PLAYWRIGHT_HTML_REPORT ?? '',",
      "}) + '\\n');",
      '',
    ].join('\n'),
  );
}

function runNpm(script: string, args: string[], logFile: string, stub: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', script, '--', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MYTHOS_E2E_PLAYWRIGHT: stub,
        MYTHOS_E2E_ARGV_LOG: logFile,
      },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('wrapper did not exit'));
    }, 8000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
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
  it('npm wallpaper-picker and key-actions both pass extra args through to Playwright', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-argv-'));
    const stub = path.join(dir, 'playwright-stub.mjs');
    const logFile = path.join(dir, 'argv.log');
    writeStub(stub);
    fs.writeFileSync(logFile, '');

    const wallpaperCode = await runNpm(
      'test:e2e:wallpaper-picker',
      ['--grep', 'argv-forward-sentinel', '--workers', '1'],
      logFile,
      stub,
    );
    const both = recorded(logFile);
    expect(wallpaperCode).toBe(0);
    expect(both.map((run) => run.argv[1])).toEqual([
      'e2e/perf/key-actions.spec.ts',
      'e2e/wallpaper-picker.spec.ts',
    ]);
    for (const run of both) {
      expect(run.argv).toEqual(expect.arrayContaining([
        '--grep',
        'argv-forward-sentinel',
        '--workers',
        '1',
      ]));
    }
    expect(both[0]?.report).toBe('playwright-report/key-actions');
    expect(both[1]?.report).toBe('playwright-report/wallpaper-picker');
    expect(both[0]?.argv).toContain('--retries=0');
    expect(both[1]?.argv).not.toContain('--retries=0');
    expect(both[0]?.argv).toContain('--pass-with-no-tests');
    expect(both[1]?.argv).toContain('--pass-with-no-tests');
    expect(both[0]?.argv).not.toContain('--only=key-actions');

    fs.writeFileSync(logFile, '');
    const ciCode = await runNpm('test:e2e:wallpaper-picker', [], logFile, stub);
    const ciRuns = recorded(logFile);
    expect(ciCode).toBe(0);
    expect(ciRuns.map((run) => run.argv[1])).toEqual([
      'e2e/perf/key-actions.spec.ts',
      'e2e/wallpaper-picker.spec.ts',
    ]);
    for (const run of ciRuns) {
      expect(run.argv).not.toContain('--pass-with-no-tests');
    }

    fs.writeFileSync(logFile, '');
    const keyActionsCode = await runNpm(
      'test:e2e:key-actions',
      ['--grep', 'argv-forward-sentinel'],
      logFile,
      stub,
    );
    const onlyKey = recorded(logFile);
    expect(keyActionsCode).toBe(0);
    expect(onlyKey).toHaveLength(1);
    expect(onlyKey[0]?.argv[1]).toBe('e2e/perf/key-actions.spec.ts');
    expect(onlyKey[0]?.argv).toEqual(expect.arrayContaining([
      '--grep',
      'argv-forward-sentinel',
    ]));
    expect(onlyKey[0]?.argv.join(' ')).not.toContain('wallpaper-picker.spec.ts');
    expect(onlyKey[0]?.report).toBe('playwright-report/key-actions');
  });
});
