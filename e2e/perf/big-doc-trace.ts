/**
 * Big-scene perf variants. keystrokePaint.ts is imported read-only.
 * CDP tracing is opt-in (BIG_DOC_TRACE=1) so the budget numbers are not
 * inflated by the trace itself.
 */
import type { CDPSession, Page } from '@playwright/test';
import { measureKeystrokeToPaint, type KeystrokeToPaintResult } from './ui-runtime/keystrokePaint';

const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
];

interface TraceEvent {
  name?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  args?: {
    data?: {
      functionName?: string;
      url?: string;
      scriptName?: string;
      lineNumber?: number;
      stackTrace?: Array<{ functionName?: string; url?: string; lineNumber?: number }>;
    };
  };
}

export interface LongTask {
  name: string;
  ms: number;
  detail: string;
}

export async function focusEditorAtEnd(page: Page): Promise<void> {
  const editor = page.locator('.ProseMirror').first();
  await editor.click();
  await editor.evaluate((el) => {
    const node = el as HTMLElement;
    node.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

/** Focus the open scene editor at the end of the document, then sample keystrokes. */
export async function measureKeystrokeAtEnd(page: Page, reps = 20): Promise<KeystrokeToPaintResult> {
  await focusEditorAtEnd(page);
  return measureKeystrokeToPaint(page, reps);
}

function taskDetail(event: TraceEvent): string {
  const data = event.args?.data;
  if (!data) return '';
  const frame = data.stackTrace?.find((f) => f.functionName) ?? data.stackTrace?.[0];
  const fn = data.functionName || frame?.functionName || '';
  const url = data.url || data.scriptName || frame?.url || '';
  const line = data.lineNumber ?? frame?.lineNumber;
  const file = url ? url.split('/').slice(-2).join('/') : '';
  return [fn, file && line != null ? `${file}:${line}` : file].filter(Boolean).join(' ');
}

interface ProfileNode {
  id: number;
  callFrame: { functionName?: string; url?: string; lineNumber?: number };
  children?: number[];
}

interface CpuProfile {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

function topSelfTime(profile: CpuProfile, limit: number): LongTask[] {
  const self = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0));
  }
  const byName = new Map<string, { ms: number; detail: string }>();
  for (const node of profile.nodes) {
    const us = self.get(node.id) ?? 0;
    if (us < 5_000) continue;
    const name = node.callFrame.functionName || '(anonymous)';
    const url = node.callFrame.url?.split('/').slice(-2).join('/') ?? '';
    const line = node.callFrame.lineNumber != null ? `:${node.callFrame.lineNumber + 1}` : '';
    const key = `${name} ${url}${line}`;
    const prev = byName.get(key);
    const ms = us / 1000;
    if (prev) prev.ms += ms;
    else byName.set(key, { ms, detail: `${url}${line}` });
  }
  return [...byName.entries()]
    .map(([key, v]) => ({ name: key.split(' ')[0] || key, ms: Math.round(v.ms), detail: key }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
}

/** Longest complete trace events during `fn`. Overhead is real — budget runs leave this off. */
export async function traceLongTasks<T>(
  page: Page,
  fn: () => Promise<T>,
): Promise<{ result: T; top: LongTask[] }> {
  const client: CDPSession = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  client.on('Tracing.dataCollected', (params) => {
    events.push(...((params as { value?: TraceEvent[] }).value ?? []));
  });
  const tracingComplete = new Promise<void>((resolve) => {
    client.once('Tracing.tracingComplete', () => resolve());
  });
  await client.send('Profiler.enable');
  await client.send('Profiler.start');
  await client.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: TRACE_CATEGORIES,
    },
  } as never);

  let result: T;
  let profile: CpuProfile | null = null;
  try {
    result = await fn();
  } finally {
    const stopped = await client.send('Profiler.stop').catch(() => null) as { profile?: CpuProfile } | null;
    profile = stopped?.profile ?? null;
    await client.send('Profiler.disable').catch(() => undefined);
    await client.send('Tracing.end').catch(() => undefined);
    await tracingComplete.catch(() => undefined);
    await client.detach().catch(() => undefined);
  }
  if (profile) {
    for (const hit of topSelfTime(profile, 8)) {
      // eslint-disable-next-line no-console
      console.log(`[perf] self label=${hit.detail} ms=${hit.ms}`);
    }
  }

  const ranked = events
    .filter((e) => e.ph !== 'I' && typeof e.dur === 'number' && e.dur >= 50_000 && e.name)
    .map((e) => ({
      name: e.name as string,
      ms: Math.round((e.dur as number) / 1000),
      detail: taskDetail(e),
    }))
    .sort((a, b) => b.ms - a.ms);

  // RunTask is the scheduler wrapper around the named events below it.
  // Prefer the named work when we have it; fall back to RunTask.
  const named = ranked.filter((e) => e.name !== 'RunTask');
  const top = (named.length > 0 ? named : ranked).slice(0, 3);
  return { result: result as T, top };
}

export function logLongTasks(label: string, top: LongTask[]): void {
  top.forEach((task, i) => {
    // eslint-disable-next-line no-console
    console.log(`[perf] longtask label=${label} rank=${i + 1} name=${task.name} ms=${task.ms} detail=${task.detail}`);
  });
}
