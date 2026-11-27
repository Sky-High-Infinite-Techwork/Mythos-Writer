/**
 * Unit coverage for e2e/helpers/fakeAiProvider.ts (1923 Probe S3).
 *
 * The partner e2e specs lean on this loopback server for Cancel / abort
 * assertions, but only through a single in-flight stream. These tests pin the
 * per-REQUEST abort rule: one client dropping its stream must stop only that
 * stream, never a second request in flight, and must be reported by
 * sawAbortClose().
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startFakeAiProvider, type FakeAiProvider } from '../../e2e/helpers/fakeAiProvider';

let provider: FakeAiProvider | null = null;

afterEach(async () => {
  await provider?.close();
  provider = null;
});

interface Stream {
  req: http.ClientRequest;
  text: () => string;
  ended: Promise<void>;
  started: Promise<void>;
}

function openStream(port: number): Stream {
  let buf = '';
  let markStarted: () => void = () => {};
  const started = new Promise<void>((r) => { markStarted = r; });
  let markEnded: () => void = () => {};
  const ended = new Promise<void>((r) => { markEnded = r; });
  const req = http.request(
    { host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent: false },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => { buf += d; markStarted(); });
      res.on('end', markEnded);
      res.on('close', markEnded);
      res.on('error', markEnded);
    },
  );
  req.on('error', () => { markEnded(); });
  req.end('{}');
  return { req, text: () => buf, ended, started };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('fakeAiProvider per-request abort', () => {
  it('aborting one stream leaves a concurrent stream running to [DONE]', async () => {
    provider = await startFakeAiProvider({
      kind: 'stream',
      chunks: ['a', 'b', 'c', 'd'],
      chunkDelayMs: 60,
    });
    const first = openStream(provider.port);
    const second = openStream(provider.port);
    await Promise.all([first.started, second.started]);

    first.req.destroy();
    await first.ended;
    await sleep(30);
    expect(provider.sawAbortClose()).toBe(true);

    await second.ended;
    const text = second.text();
    for (const token of ['a', 'b', 'c', 'd']) {
      expect(text).toContain(JSON.stringify({ choices: [{ delta: { content: token } }] }));
    }
    expect(text).toContain('data: [DONE]');
    expect(provider.sentDone()).toBe(true);
  });

  it('a stream that is never aborted does not report an abort close', async () => {
    provider = await startFakeAiProvider({ kind: 'stream', chunks: ['x', 'y'], chunkDelayMs: 5 });
    const only = openStream(provider.port);
    await only.ended;
    await sleep(30);
    expect(only.text()).toContain('data: [DONE]');
    expect(provider.sawAbortClose()).toBe(false);
  });

  it('a new stream started after an earlier abort is not stopped by it', async () => {
    provider = await startFakeAiProvider({
      kind: 'stream',
      chunks: ['one', 'two', 'three'],
      chunkDelayMs: 40,
    });
    const doomed = openStream(provider.port);
    await doomed.started;
    doomed.req.destroy();
    await doomed.ended;
    await sleep(20);
    expect(provider.sawAbortClose()).toBe(true);

    // The flag is process-wide by design (setMode resets it); the abort
    // itself must stay scoped to the request that was closed.
    const fresh = openStream(provider.port);
    await fresh.ended;
    expect(fresh.text()).toContain('data: [DONE]');
    expect(fresh.text()).toContain(JSON.stringify({ choices: [{ delta: { content: 'three' } }] }));
  });

  it('setMode clears the abort and done flags', async () => {
    provider = await startFakeAiProvider({ kind: 'stream', chunks: ['p', 'q'], chunkDelayMs: 40 });
    const s = openStream(provider.port);
    await s.started;
    s.req.destroy();
    await s.ended;
    await sleep(20);
    expect(provider.sawAbortClose()).toBe(true);
    provider.setMode({ kind: 'stream', chunks: ['z'] });
    expect(provider.sawAbortClose()).toBe(false);
    expect(provider.sentDone()).toBe(false);
  });

  // holdOpen replaces wall-clock chunk delays in the agent-hub retry e2e.
  it('holdOpen keeps a stream in flight until release(), then finishes it', async () => {
    provider = await startFakeAiProvider({ kind: 'stream', chunks: ['held'], holdOpen: true });
    const s = openStream(provider.port);
    await s.started;
    await sleep(150);
    expect(s.text()).toContain(JSON.stringify({ choices: [{ delta: { content: 'held' } }] }));
    expect(s.text()).not.toContain('[DONE]');
    expect(provider.sentDone()).toBe(false);

    provider.release();
    await s.ended;
    expect(s.text()).toContain('data: [DONE]');
    expect(provider.sentDone()).toBe(true);
  });

  it('a client abort while a stream is held is reported and does not send [DONE]', async () => {
    provider = await startFakeAiProvider({ kind: 'stream', chunks: ['held'], holdOpen: true });
    const s = openStream(provider.port);
    await s.started;
    s.req.destroy();
    await s.ended;
    await sleep(30);
    expect(provider.sawAbortClose()).toBe(true);
    provider.release();
    await sleep(30);
    expect(provider.sentDone()).toBe(false);
  });

  it('release() applies only to the current mode; setMode re-arms the hold', async () => {
    provider = await startFakeAiProvider({ kind: 'stream', chunks: ['a'], holdOpen: true });
    provider.release();
    const quick = openStream(provider.port);
    await quick.ended;
    expect(quick.text()).toContain('[DONE]');

    provider.setMode({ kind: 'stream', chunks: ['b'], holdOpen: true });
    const held = openStream(provider.port);
    await held.started;
    await sleep(100);
    expect(held.text()).not.toContain('[DONE]');
    provider.release();
    await held.ended;
    expect(held.text()).toContain('[DONE]');
  });
});
