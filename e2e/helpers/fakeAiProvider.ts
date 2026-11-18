/**
 * Loopback OpenAI-compatible HTTP server for partner / agent E2E.
 * Exercises the real electron-main provider path (streamFromProvider) with no
 * ipcMain handler mocks and no outbound network beyond 127.0.0.1.
 */
import http from 'http';
import type { AddressInfo } from 'net';

export type FakeAiStreamMode = {
  kind: 'stream';
  chunks: string[];
  /** Delay between SSE chunks (ms). */
  chunkDelayMs?: number;
};

export type FakeAiHttpMode = {
  kind: 'http';
  status: number;
  body?: string;
};

/** Emit some tokens, then destroy the socket (mid-stream failure). */
export type FakeAiDropMode = {
  kind: 'drop';
  chunks: string[];
  dropAfterChunks: number;
};

export type FakeAiMode = FakeAiStreamMode | FakeAiHttpMode | FakeAiDropMode;

export interface FakeAiProvider {
  port: number;
  baseUrl: string;
  hits: () => number;
  requestHosts: () => string[];
  sawClientClose: () => boolean;
  setMode: (mode: FakeAiMode) => void;
  close: () => Promise<void>;
}

export function customProviderSeed(port: number): {
  kind: 'custom';
  baseUrl: string;
  model: string;
  apiKey: string;
} {
  return {
    kind: 'custom',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'e2e-fake-model',
    apiKey: 'e2e-fake-key',
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function writeSse(res: http.ServerResponse, content: string): void {
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
}

export function startFakeAiProvider(initialMode: FakeAiMode = {
  kind: 'stream',
  chunks: ['OK'],
}): Promise<FakeAiProvider> {
  let mode: FakeAiMode = initialMode;
  let hits = 0;
  const hosts: string[] = [];
  let clientClosed = false;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const host = req.headers.host ?? '';
      if (host && !hosts.includes(host)) hosts.push(host);

      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404);
        res.end();
        return;
      }

      req.on('close', () => {
        clientClosed = true;
      });

      hits += 1;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        void (async () => {
          if (mode.kind === 'http') {
            res.writeHead(mode.status, { 'Content-Type': 'application/json' });
            res.end(mode.body ?? JSON.stringify({ error: { message: `HTTP ${mode.status}` } }));
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          if (mode.kind === 'stream') {
            for (const chunk of mode.chunks) {
              if (clientClosed) return;
              writeSse(res, chunk);
              if (mode.chunkDelayMs && mode.chunkDelayMs > 0) {
                await delay(mode.chunkDelayMs);
              }
            }
            if (!res.writableEnded) {
              res.write('data: [DONE]\n\n');
              res.end();
            }
            return;
          }

          // drop mode
          let sent = 0;
          for (const chunk of mode.chunks) {
            if (clientClosed) return;
            writeSse(res, chunk);
            sent += 1;
            if (sent >= mode.dropAfterChunks) {
              res.destroy();
              return;
            }
          }
          res.destroy();
        })().catch(() => {
          if (!res.writableEnded) res.destroy();
        });
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        hits: () => hits,
        requestHosts: () => [...hosts],
        sawClientClose: () => clientClosed,
        setMode: (next) => { mode = next; clientClosed = false; },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}