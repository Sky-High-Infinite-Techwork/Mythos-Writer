/**
 * Pins each agent stream handler in main.ts to its own IPC channel family.
 *
 * The High fold (requestId on chunks) typo'd writing-assistant onto
 * `agent:brainstorm:chunk`. The replicated-loop smoke tests could not catch
 * that, because they never read main.ts. This file reads the real handlers.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MAIN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts');

const HANDLERS = [
  {
    fn: 'registerBrainstormHandler',
    prefix: 'agent:brainstorm',
    requireChunkRequestId: true,
  },
  {
    fn: 'registerWritingAssistantHandler',
    prefix: 'agent:writing-assistant',
    requireChunkRequestId: true,
  },
  {
    fn: 'registerArchiveChatHandler',
    prefix: 'agent:archive',
    // Pre-existing: archive chunks are not tagged with requestId.
    requireChunkRequestId: false,
  },
  {
    fn: 'registerVaultAgentHandlers',
    prefix: 'agent:vault-check',
    // Pre-existing: vault-check chunks are not tagged with requestId.
    requireChunkRequestId: false,
  },
] as const;

const AGENT_SEND_RE = /event\.sender\.send\(\s*'(agent:[^']+)'/g;

const SEND_RE = /event\.sender\.send\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g;

function sliceFunction(src: string, fnName: string): string {
  const startMark = `function ${fnName}(`;
  const start = src.indexOf(startMark);
  if (start < 0) return '';
  const brace = src.indexOf('{', start);
  if (brace < 0) return '';
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

function parseSends(body: string): { channel: string; payload: string }[] {
  return [...body.matchAll(SEND_RE)].map((m) => ({
    channel: m[1]!,
    payload: m[2]!,
  }));
}

function channelMismatches(src: string): string[] {
  const failures: string[] = [];
  for (const { fn, prefix, requireChunkRequestId } of HANDLERS) {
    const body = sliceFunction(src, fn);
    if (!body) {
      failures.push(`${fn}: not found in main.ts`);
      continue;
    }
    const sends = parseSends(body);
    const starts = sends.filter((s) => s.channel.endsWith(':stream-start'));
    const chunks = sends.filter((s) => s.channel.endsWith(':chunk'));
    if (starts.length !== 1 || starts[0]!.channel !== `${prefix}:stream-start`) {
      failures.push(
        `${fn}: expected one ${prefix}:stream-start send, got ${starts.map((s) => s.channel).join(', ') || 'none'}`,
      );
    } else if (!/\brequestId\b/.test(starts[0]!.payload)) {
      failures.push(`${fn}: stream-start payload is missing requestId`);
    }
    if (chunks.length !== 1 || chunks[0]!.channel !== `${prefix}:chunk`) {
      failures.push(
        `${fn}: expected one ${prefix}:chunk send, got ${chunks.map((s) => s.channel).join(', ') || 'none'}`,
      );
    } else if (requireChunkRequestId && !/\brequestId\b/.test(chunks[0]!.payload)) {
      failures.push(`${fn}: chunk payload is missing requestId`);
    }
    // Any event this handler sends (chunk, stream-start, error) must stay in
    // its own channel family.
    const foreign = sends.filter((s) => !s.channel.startsWith(`${prefix}:`));
    for (const s of foreign) {
      failures.push(`${fn}: sent ${s.channel} (must stay on ${prefix}:*)`);
    }
  }
  return failures;
}

function swapChunkChannel(src: string, fnName: string, from: string, to: string): string {
  const body = sliceFunction(src, fnName);
  if (!body) throw new Error(`cannot mutate missing ${fnName}`);
  const mutated = body.split(`event.sender.send('${from}'`).join(`event.sender.send('${to}'`);
  if (mutated === body) throw new Error(`no ${from} send in ${fnName} to swap`);
  return src.slice(0, src.indexOf(body)) + mutated + src.slice(src.indexOf(body) + body.length);
}

describe('main.ts agent chunk channels (1923 Shield F1)', () => {
  const src = fs.readFileSync(MAIN_PATH, 'utf8');

  it('all four agent handlers send stream-start, chunk, and error on their own channel', () => {
    expect(channelMismatches(src)).toEqual([]);
  });

  it('those four handlers account for every agent:* send in main.ts (12 events)', () => {
    const listed = new Set<string>();
    for (const { fn, prefix } of HANDLERS) {
      const body = sliceFunction(src, fn);
      expect(body, `${fn} missing`).not.toBe('');
      for (const m of body.matchAll(AGENT_SEND_RE)) listed.add(m[1]!);
      // Each family has stream-start, chunk, and error.
      for (const suffix of ['stream-start', 'chunk', 'error']) {
        expect(listed.has(`${prefix}:${suffix}`), `${prefix}:${suffix}`).toBe(true);
      }
    }
    expect(listed.size).toBe(12);
    const all = new Set([...src.matchAll(AGENT_SEND_RE)].map((m) => m[1]!));
    expect([...all].sort()).toEqual([...listed].sort());
  });

  it('swapping writing-assistant chunks onto the brainstorm channel is rejected (mutant)', () => {
    const mutant = swapChunkChannel(
      src,
      'registerWritingAssistantHandler',
      'agent:writing-assistant:chunk',
      'agent:brainstorm:chunk',
    );
    const failures = channelMismatches(mutant);
    expect(failures.some((f) => f.includes('registerWritingAssistantHandler') && f.includes('agent:brainstorm:chunk'))).toBe(true);
    // Clean source must still pass — the mutant is in-memory only.
    expect(channelMismatches(src)).toEqual([]);
  });

  it('swapping brainstorm chunks onto the writing-assistant channel is rejected (mutant)', () => {
    const mutant = swapChunkChannel(
      src,
      'registerBrainstormHandler',
      'agent:brainstorm:chunk',
      'agent:writing-assistant:chunk',
    );
    const failures = channelMismatches(mutant);
    expect(failures.some((f) => f.includes('registerBrainstormHandler') && f.includes('agent:writing-assistant:chunk'))).toBe(true);
    expect(channelMismatches(src)).toEqual([]);
  });

  it('swapping archive chunks onto the brainstorm channel is rejected (mutant)', () => {
    const mutant = swapChunkChannel(
      src,
      'registerArchiveChatHandler',
      'agent:archive:chunk',
      'agent:brainstorm:chunk',
    );
    const failures = channelMismatches(mutant);
    expect(failures.some((f) => f.includes('registerArchiveChatHandler') && f.includes('agent:brainstorm:chunk'))).toBe(true);
    expect(channelMismatches(src)).toEqual([]);
  });

  it('swapping vault-check chunks onto the writing-assistant channel is rejected (mutant)', () => {
    const mutant = swapChunkChannel(
      src,
      'registerVaultAgentHandlers',
      'agent:vault-check:chunk',
      'agent:writing-assistant:chunk',
    );
    const failures = channelMismatches(mutant);
    expect(failures.some((f) => f.includes('registerVaultAgentHandlers') && f.includes('agent:writing-assistant:chunk'))).toBe(true);
    expect(channelMismatches(src)).toEqual([]);
  });
});
