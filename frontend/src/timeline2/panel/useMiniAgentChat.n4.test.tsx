/**
 * N4 Secure bar — Cancel + stall must abort the provider stream in MAIN
 * (cancelAiActivity), not just clear renderer UI.
 * Critic hard 2/3 — bind cancel to THIS job id; reset stall on chunks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { __resetAgentSessionStores } from '../../lib/useAgentSessions';
import {
  useMiniAgentChat,
  HARD_TIMEOUT_MS,
  STALL_WARNING_MS,
  MAX_EARLY_CHUNKS,
  MAX_EARLY_CHUNK_CHARS,
  RESPONSE_INCOMPLETE_SUFFIX,
  tryPushEarlyChunk,
  takeEarlyLane,
  turnsForModelHistory,
  feedEndsWithUserPrompt,
} from './useMiniAgentChat';
import { encodeCoachCard } from '../../coach/coachMessages';

function installApi() {
  const cancelAiActivity = vi.fn();
  const cancelBrainstorm = vi.fn();
  let streamStartCb: ((id: string) => void) | null = null;
  let chunkCb: ((chunk: string, requestId?: string) => void) | null = null;
  let activityCb: ((entries: { requestId: string }[]) => void) | null = null;
  const session: AgentSessionFile = {
    id: 's1',
    agent: 'brainstorm',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    turns: [],
  };
  const appendTurns = vi.fn().mockImplementation(async (id: string, turns: AgentSessionTurn[]) => {
    session.id = id;
    session.turns = [...session.turns, ...turns];
    return { session: { ...session, id } };
  });
  (window as unknown as { api: Record<string, unknown> }).api = {
    cancelAiActivity,
    cancelBrainstorm,
    onBrainstormStreamStart: (cb: (id: string) => void) => {
      streamStartCb = cb;
      return () => { streamStartCb = null; };
    },
    onBrainstormChunk: (cb: (chunk: string, requestId?: string) => void) => {
      chunkCb = cb;
      return () => { chunkCb = null; };
    },
    onAiActivityUpdate: (cb: (entries: { requestId: string }[]) => void) => {
      activityCb = cb;
      return () => { activityCb = null; };
    },
    agentSessions: {
      list: vi.fn().mockResolvedValue({ sessions: [] }),
      create: vi.fn().mockResolvedValue({ session, relPath: 'Sessions/x.md' }),
      read: vi.fn().mockResolvedValue({ session }),
      appendTurns,
      rename: vi.fn().mockResolvedValue({ ok: true }),
      duplicate: vi.fn().mockResolvedValue({ session, relPath: 'Sessions/x.md' }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
  return {
    cancelAiActivity,
    cancelBrainstorm,
    fireStreamStart: (id: string) => streamStartCb?.(id),
    fireChunk: (chunk: string, requestId?: string) => chunkCb?.(chunk, requestId),
    fireActivity: (entries: { requestId: string }[]) => activityCb?.(entries),
    session,
    appendTurns,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetAgentSessionStores();
});

afterEach(() => {
  vi.useRealTimers();
  __resetAgentSessionStores();
  delete (window as unknown as { api?: unknown }).api;
});

describe('useMiniAgentChat N4 cancel/stall main abort', () => {
  it('Cancel aborts the in-flight request in MAIN via cancelAiActivity', async () => {
    const api = installApi();
    let resolveInvoke: (v: string) => void = () => {};
    const invoke = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveInvoke = resolve;
        }),
    );

    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => {
      void result.current.send('Hello partner');
    });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.busy).toBe(true);

    act(() => {
      api.fireStreamStart('req-main-uuid-1');
    });

    act(() => {
      result.current.cancel();
    });

    expect(api.cancelAiActivity).toHaveBeenCalledWith('req-main-uuid-1');
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toMatch(/cancelled/i);

    await act(async () => {
      resolveInvoke('late reply');
      await Promise.resolve();
    });
    expect(result.current.messages.every((m) => m.text !== 'late reply')).toBe(true);
  });

  it('hard stall timeout aborts in MAIN via cancelAiActivity', async () => {
    const api = installApi();
    const invoke = vi.fn(() => new Promise<string>(() => { /* never resolves */ }));

    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => {
      void result.current.send('Hung prompt');
    });
    await act(async () => { await Promise.resolve(); });

    act(() => {
      api.fireStreamStart('req-stall-uuid');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_WARNING_MS);
    });
    expect(result.current.stalled).toBe(true);
    expect(api.cancelAiActivity).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS - STALL_WARNING_MS + 1);
    });

    expect(api.cancelAiActivity).toHaveBeenCalledWith('req-stall-uuid');
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toMatch(/timed out/i);
  });

  it('Critic hard 2: Cancel ignores a newer app-wide activity entry (binds stream-start id)', async () => {
    const api = installApi();
    const invoke = vi.fn(() => new Promise<string>(() => { /* hang */ }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('mine'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-mine'); });
    act(() => {
      api.fireActivity([
        { requestId: 'req-mine' },
        { requestId: 'req-other-window' },
      ]);
    });

    act(() => { result.current.cancel(); });
    expect(api.cancelAiActivity).toHaveBeenCalledWith('req-mine');
    expect(api.cancelAiActivity).not.toHaveBeenCalledWith('req-other-window');
  });

  it('Critic hard 3: streamed chunks re-arm the hard timeout (slow healthy reply survives)', async () => {
    const api = installApi();
    const invoke = vi.fn(() => new Promise<string>(() => { /* hang */ }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('slow'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-slow'); });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS - 5_000);
    });
    expect(api.cancelAiActivity).not.toHaveBeenCalled();
    act(() => { api.fireChunk('…still going', 'req-slow'); });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS - 5_000);
    });
    expect(api.cancelAiActivity).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.cancelAiActivity).toHaveBeenCalledWith('req-slow');
  });

  it('Retry resends the last failed prompt without retyping', async () => {
    installApi();
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('Network error — check your connection and try again.'))
      .mockResolvedValueOnce('Second try worked.');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.send('same prompt'); await Promise.resolve(); await Promise.resolve(); });

    expect(String(result.current.error)).toMatch(/network error/i);
    expect(result.current.canRetry).toBe(true);

    await act(async () => { result.current.retryLast(); await Promise.resolve(); await Promise.resolve(); });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]?.[0]).toBe('same prompt');
    expect(invoke.mock.calls[1]?.[0]).toBe('same prompt');
    const retryHistory = invoke.mock.calls[1]?.[1] as { role: string; content: string }[];
    expect(retryHistory.filter((h) => h.role === 'user' && h.content === 'same prompt')).toHaveLength(0);
    expect(result.current.messages.filter((m) => m.role === 'user' && m.text === 'same prompt')).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('retry after partial stream keeps one user bubble and omits failed tail from invoke history', async () => {
    const api = installApi();
    let failFirst: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((_, reject) => {
            failFirst = () => reject(new Error('stream ended early'));
          }),
      )
      .mockResolvedValueOnce('Done on retry.');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('partial probe'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-partial'); });
    act(() => { api.fireChunk('Part one', 'req-partial'); });
    await act(async () => {
      failFirst();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.canRetry).toBe(true);
    expect(result.current.messages.filter((m) => m.role === 'user' && m.text === 'partial probe')).toHaveLength(1);
    expect(result.current.messages.some((m) => m.text === `Part one ${RESPONSE_INCOMPLETE_SUFFIX}`)).toBe(true);

    await act(async () => { result.current.retryLast(); await Promise.resolve(); await Promise.resolve(); });

    const retryHistory = invoke.mock.calls.at(-1)?.[1] as { role: string; content: string }[];
    expect(retryHistory.filter((h) => h.content.includes('partial probe'))).toHaveLength(0);
    expect(retryHistory.some((h) => h.content.includes('response incomplete'))).toBe(false);
    expect(result.current.messages.filter((m) => m.role === 'user' && m.text === 'partial probe')).toHaveLength(1);
  });

  it('Cancel then retry keeps canRetry and resends without duplicating the user turn', async () => {
    const api = installApi();
    let resolveInvoke: (v: string) => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => { resolveInvoke = resolve; }),
      )
      .mockResolvedValueOnce('After cancel retry.');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('cancel me'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-cancel'); });
    act(() => { result.current.cancel(); });

    expect(result.current.canRetry).toBe(true);
    expect(result.current.messages.filter((m) => m.role === 'user' && m.text === 'cancel me')).toHaveLength(0);

    await act(async () => { result.current.retryLast(); await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.messages.filter((m) => m.role === 'user' && m.text === 'cancel me')).toHaveLength(1);
    expect(result.current.error).toBeNull();
    void resolveInvoke;
  });

  it('after partial failure, a failed retry keeps a single user bubble', async () => {
    const api = installApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('drop')); }))
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('drop again')); }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('dup probe'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-dup-1'); });
    act(() => { api.fireChunk('Part one', 'req-dup-1'); });
    await act(async () => {
      fail();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { result.current.retryLast(); await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-dup-2'); });
    act(() => { api.fireChunk('Part two', 'req-dup-2'); });
    await act(async () => {
      fail();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.messages.filter((m) => m.role === 'user' && m.text === 'dup probe')).toHaveLength(1);
  });

  it('partial reply then Cancel then retry succeeds without duplicating user turns', async () => {
    const api = installApi();
    let rejectFirst: () => void = () => {};
    let resolveRetry: (v: string) => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { rejectFirst = () => reject(new Error('partial')); }))
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveRetry = resolve; }))
      .mockResolvedValueOnce('final reply');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('cancel chain'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-chain'); });
    act(() => { api.fireChunk('Partial', 'req-chain'); });
    await act(async () => {
      rejectFirst();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { result.current.retryLast(); await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-retry'); });
    act(() => { result.current.cancel(); });
    await act(async () => { result.current.retryLast(); await Promise.resolve(); });
    await act(async () => {
      resolveRetry('final reply');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.messages.filter((m) => m.role === 'user' && m.text === 'cancel chain')).toHaveLength(1);
    void resolveRetry;
  });

  it('when persist fails on error, retry still saves the user turn on success', async () => {
    const api = installApi();
    let failUserPersistOnce = true;
    api.appendTurns.mockImplementation(async (id: string, turns: AgentSessionTurn[]) => {
      if (failUserPersistOnce && turns.some((t) => t.role === 'user' && t.text === 'save me')) {
        failUserPersistOnce = false;
        throw new Error('disk full');
      }
      api.session.id = id;
      api.session.turns = [...api.session.turns, ...turns];
      return { session: { ...api.session, id } };
    });
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce('recovered');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.send('save me'); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.messages.filter((m) => m.role === 'user' && m.text === 'save me')).toHaveLength(0);
    await act(async () => { await result.current.send('save me'); await Promise.resolve(); await Promise.resolve(); });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.messages.filter((m) => m.role === 'user' && m.text === 'save me')).toHaveLength(1);
    expect(result.current.messages.some((m) => m.text === 'recovered')).toBe(true);
  });

  it('turnsForModelHistory drops incomplete turns and orphan consecutive users', () => {
    const turns: AgentSessionTurn[] = [
      { role: 'user', text: 'a', at: '1' },
      { role: 'user', text: 'b', at: '2' },
      { role: 'agent', text: `partial ${RESPONSE_INCOMPLETE_SUFFIX}`, at: '3', incomplete: true },
      { role: 'agent', text: 'final', at: '4' },
    ];
    const history = turnsForModelHistory(turns, null);
    expect(history.map((t) => t.text)).toEqual(['b', 'final']);
  });

  // Probe FOLD (c): detection keys on the structural flag, not on prose.
  it('turnsForModelHistory keeps a finished reply that ends with the incomplete wording (no false positive)', () => {
    const turns: AgentSessionTurn[] = [
      { role: 'user', text: 'q', at: '1' },
      { role: 'agent', text: `Here is the summary you asked for ${RESPONSE_INCOMPLETE_SUFFIX}`, at: '2' },
      { role: 'user', text: 'thanks', at: '3' },
    ];
    expect(turnsForModelHistory(turns, null).map((t) => t.text)).toEqual([
      'q',
      `Here is the summary you asked for ${RESPONSE_INCOMPLETE_SUFFIX}`,
    ]);
  });

  it('turnsForModelHistory drops a flagged partial whose text no longer ends with the suffix (no false negative)', () => {
    const turns: AgentSessionTurn[] = [
      { role: 'user', text: 'q', at: '1' },
      { role: 'agent', text: `cut off ${RESPONSE_INCOMPLETE_SUFFIX}\n`, at: '2', incomplete: true },
      { role: 'agent', text: 'reflowed partial', at: '3', incomplete: true },
      { role: 'agent', text: 'final', at: '4' },
      { role: 'user', text: 'next', at: '5' },
    ];
    expect(turnsForModelHistory(turns, null).map((t) => t.text)).toEqual(['q', 'final']);
  });

  it('feedEndsWithUserPrompt skips a flagged partial but not a look-alike finished reply', () => {
    const flagged: AgentSessionTurn[] = [
      { role: 'user', text: 'ask', at: '1' },
      { role: 'agent', text: `bit ${RESPONSE_INCOMPLETE_SUFFIX}\n`, at: '2', incomplete: true },
    ];
    expect(feedEndsWithUserPrompt(flagged, 'ask')).toBe(true);
    const lookAlike: AgentSessionTurn[] = [
      { role: 'user', text: 'ask', at: '1' },
      { role: 'agent', text: `done ${RESPONSE_INCOMPLETE_SUFFIX}`, at: '2' },
    ];
    expect(feedEndsWithUserPrompt(lookAlike, 'ask')).toBe(false);
  });

  it('the failure path writes the partial with the incomplete flag, and Retry history drops it', async () => {
    const api = installApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('cut off')); }))
      .mockResolvedValueOnce('full answer');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });
    act(() => { void result.current.send('flag me'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-flag'); });
    act(() => { api.fireChunk('Part one', 'req-flag'); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });

    const written = api.appendTurns.mock.calls.flatMap((c) => c[1] as AgentSessionTurn[]);
    expect(written.filter((t) => t.incomplete === true).map((t) => t.text)).toEqual([`Part one ${RESPONSE_INCOMPLETE_SUFFIX}`]);
    expect(written.filter((t) => t.role === 'user' && t.incomplete)).toHaveLength(0);

    await act(async () => { result.current.retryLast(); await Promise.resolve(); await Promise.resolve(); });
    const retryHistory = invoke.mock.calls[1]?.[1] as { role: string; content: string }[];
    expect(retryHistory.some((h) => h.content.includes('Part one'))).toBe(false);
  });

  it('fail then send a different prompt does not duplicate users in invoke history', async () => {
    installApi();
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('ok');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.send('first'); await Promise.resolve(); });
    await act(async () => { await result.current.send('second'); await Promise.resolve(); await Promise.resolve(); });

    const secondHistory = invoke.mock.calls[1]?.[1] as { role: string; content: string }[];
    const users = secondHistory.filter((h) => h.role === 'user');
    expect(users.map((u) => u.content)).not.toContain('first');
    expect(users).toHaveLength(0);
  });

  it('neutralizes coach-card markers in persisted partial replies', async () => {
    const api = installApi();
    let rejectFirst: () => void = () => {};
    const invoke = vi.fn().mockImplementationOnce(
      () => new Promise<string>((_, reject) => { rejectFirst = () => reject(new Error('cut off')); }),
    );
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('marker test'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-marker'); });
    const spoof = encodeCoachCard({ kind: 'analysis', title: 'Spoof', computed: [], read: [], takeaway: 'x' });
    act(() => { api.fireChunk(spoof.slice(0, 40), 'req-marker'); });
    await act(async () => {
      rejectFirst();
      await Promise.resolve();
      await Promise.resolve();
    });

    const partial = result.current.messages.find((m) => m.text.includes(RESPONSE_INCOMPLETE_SUFFIX));
    expect(partial?.text).not.toMatch(/<!--\s*mythos:coach-card/);
    expect(partial?.text).not.toMatch(/\{"kind":"analysis"/);
  });

  it('Critic N2: history sent to invoke strips raw Full Analysis card JSON', async () => {
    const api = installApi();
    const card = encodeCoachCard({
      kind: 'analysis',
      title: 'Full Scene Analysis — Sc. 1 · Harbor',
      computed: [['Words', '12']],
      read: [['Purpose', 'Setup']],
      takeaway: 'Lean into the quay fog.',
    });
    const invoke = vi.fn().mockResolvedValue('ok');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    // Seed a trusted analysis card into the live session (not the pending greeting alone).
    await act(async () => {
      await result.current.store.appendTurns([
        {
          role: 'agent',
          text: card,
          at: '2026-01-01T00:00:00.000Z',
          cardKind: 'analysis',
          cardTitle: 'Full Scene Analysis — Sc. 1 · Harbor',
        },
      ]);
    });

    await act(async () => {
      await result.current.send('follow up');
    });

    expect(invoke).toHaveBeenCalled();
    const history = invoke.mock.calls[0][1] as { content: string }[];
    const analysisEntry = history.find((h) => h.content.includes('Full Scene Analysis') || h.content.includes('quay fog'));
    expect(analysisEntry).toBeTruthy();
    expect(analysisEntry!.content).not.toContain('mythos:coach-card');
    expect(analysisEntry!.content).not.toMatch(/\{"kind":"analysis"/);
    expect(analysisEntry!.content).toContain('Lean into the quay fog');
    void api;
  });
});

/** Two vault-backed sessions (s-new is active first); appendTurns writes per id. */
function installTwoSessionApi() {
  const files: Record<string, AgentSessionFile> = {
    's-new': {
      id: 's-new',
      agent: 'brainstorm',
      startedAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      turns: [],
    },
    's-old': {
      id: 's-old',
      agent: 'brainstorm',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      turns: [],
    },
  };
  const summary = (f: AgentSessionFile): AgentSessionSummary => ({
    id: f.id,
    agent: f.agent,
    startedAt: f.startedAt,
    updatedAt: f.updatedAt,
    turnCount: f.turns.length,
    relPath: `Sessions/${f.id}.md`,
  });
  let streamStartCb: ((id: string) => void) | null = null;
  let chunkCb: ((chunk: string, requestId?: string) => void) | null = null;
  (window as unknown as { api: Record<string, unknown> }).api = {
    cancelAiActivity: vi.fn(),
    cancelBrainstorm: vi.fn(),
    onBrainstormStreamStart: (cb: (id: string) => void) => {
      streamStartCb = cb;
      return () => { streamStartCb = null; };
    },
    onBrainstormChunk: (cb: (chunk: string, requestId?: string) => void) => {
      chunkCb = cb;
      return () => { chunkCb = null; };
    },
    agentSessions: {
      list: vi.fn().mockImplementation(async () => ({ sessions: Object.values(files).map(summary) })),
      create: vi.fn(),
      read: vi.fn().mockImplementation(async (id: string) => ({ session: { ...files[id] } })),
      appendTurns: vi.fn().mockImplementation(async (id: string, turns: AgentSessionTurn[]) => {
        files[id] = { ...files[id], turns: [...files[id].turns, ...turns] };
        return { session: { ...files[id] } };
      }),
      rename: vi.fn(),
      duplicate: vi.fn(),
      delete: vi.fn(),
    },
  };
  return {
    files,
    fireStreamStart: (id: string) => streamStartCb?.(id),
    fireChunk: (c: string, requestId?: string) => chunkCb?.(c, requestId),
  };
}


/** Real session store over a fake vault. Optional rekey: create() returns a new id. */
function installRealVaultApi(opts?: { rekeyOnCreate?: boolean }) {
  const files: Record<string, AgentSessionFile> = {};
  let created = 0;
  let streamStartCb: ((id: string) => void) | null = null;
  let chunkCb: ((chunk: string, requestId?: string) => void) | null = null;
  const summary = (f: AgentSessionFile): AgentSessionSummary => ({
    id: f.id,
    agent: f.agent,
    startedAt: f.startedAt,
    updatedAt: f.updatedAt,
    turnCount: f.turns.length,
    relPath: `Sessions/${f.id}.md`,
  });
  (window as unknown as { api: Record<string, unknown> }).api = {
    cancelAiActivity: vi.fn(),
    cancelBrainstorm: vi.fn(),
    onBrainstormStreamStart: (cb: (id: string) => void) => {
      streamStartCb = cb;
      return () => { streamStartCb = null; };
    },
    onBrainstormChunk: (cb: (chunk: string, requestId?: string) => void) => {
      chunkCb = cb;
      return () => { chunkCb = null; };
    },
    agentSessions: {
      list: vi.fn().mockImplementation(async () => ({ sessions: Object.values(files).map(summary) })),
      create: vi.fn().mockImplementation(async (agent: string, title?: string, greeting?: string, id?: string) => {
        created += 1;
        const sessionId = opts?.rekeyOnCreate ? `rekeyed-${created}` : (id ?? `created-${created}`);
        const now = '2026-01-01T00:00:00.000Z';
        const session: AgentSessionFile = {
          id: sessionId,
          agent: agent as AgentSessionFile['agent'],
          title,
          startedAt: now,
          updatedAt: now,
          turns: greeting ? [{ role: 'agent', text: greeting, at: now }] : [],
        };
        files[sessionId] = session;
        return { session: { ...session }, relPath: `Sessions/${sessionId}.md` };
      }),
      read: vi.fn().mockImplementation(async (id: string) => ({ session: { ...files[id] } })),
      appendTurns: vi.fn().mockImplementation(async (id: string, turns: AgentSessionTurn[]) => {
        const prev = files[id] ?? {
          id,
          agent: 'brainstorm' as const,
          startedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          turns: [],
        };
        files[id] = { ...prev, turns: [...prev.turns, ...turns] };
        return { session: { ...files[id] } };
      }),
      rename: vi.fn(),
      duplicate: vi.fn(),
      delete: vi.fn(),
    },
  };
  return {
    files,
    fireStreamStart: (id: string) => streamStartCb?.(id),
    fireChunk: (c: string, requestId?: string) => chunkCb?.(c, requestId),
  };
}

describe('useMiniAgentChat — failed-exchange tracking (SKY-1923 gate)', () => {
  it('a repeated prompt after a completed exchange still saves its own user turn', async () => {
    installApi();
    const invoke = vi.fn().mockResolvedValueOnce('first answer').mockResolvedValueOnce('second answer');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.send('yes'); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await result.current.send('yes'); await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:yes',
      'agent:first answer',
      'user:yes',
      'agent:second answer',
    ]);
  });

  it('hard timeout arms Retry, and Retry resends once without duplicating the user turn', async () => {
    const api = installApi();
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(() => { /* stalls forever */ }))
      .mockResolvedValueOnce('after timeout');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('stall prompt'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-stall'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS + 1); });

    expect(String(result.current.error)).toMatch(/timed out/i);
    expect(result.current.busy).toBe(false);
    expect(result.current.canRetry).toBe(true);

    await act(async () => { result.current.retryLast(); await Promise.resolve(); await Promise.resolve(); });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0]).toBe('stall prompt');
    expect(result.current.error).toBeNull();
    expect(result.current.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:stall prompt',
      'agent:after timeout',
    ]);
  });

  it('a Retry of a persisted failed send does not render a second optimistic user bubble', async () => {
    const api = installApi();
    let finishRetry: (v: string) => void = () => {};
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishRetry = resolve; }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    // Fresh send: user turn is NOT in the feed yet → optimistic bubble shows.
    await act(async () => { await result.current.send('bubble probe'); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.canRetry).toBe(true);
    expect(result.current.messages.filter((m) => m.role === 'user')).toHaveLength(1);

    act(() => { result.current.retryLast(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.busy).toBe(true);
    // Already in the feed → UI must not draw it again while the retry runs.
    expect(result.current.pendingPromptInFeed).toBe(true);

    await act(async () => { finishRetry('ok'); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.pendingPromptInFeed).toBe(false);
    void api;
  });

  it('a first send shows its optimistic bubble (pendingPromptInFeed stays false)', async () => {
    installApi();
    const invoke = vi.fn(() => new Promise<string>(() => { /* in flight */ }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('fresh'); });
    await act(async () => { await Promise.resolve(); });

    expect(result.current.pendingPrompt).toBe('fresh');
    expect(result.current.pendingPromptInFeed).toBe(false);
  });

  it('a failed send in a saved session does not leave Retry armed after the user switches session', async () => {
    const vault = installTwoSessionApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('cut off')); }))
      .mockResolvedValueOnce('answer in the other session');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.store.activeSessionId).toBe('s-new');

    act(() => { void result.current.send('carry over?'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { vault.fireStreamStart('req-carry'); });
    act(() => { vault.fireChunk('Part one', 'req-carry'); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.canRetry).toBe(true);
    expect(vault.files['s-new'].turns.map((t) => t.role)).toEqual(['user', 'agent']);

    await act(async () => { await result.current.store.switchSession('s-old'); });
    await act(async () => { await Promise.resolve(); });

    // Retry + error strip belong to the thread the prompt was asked in.
    expect(result.current.store.activeSessionId).toBe('s-old');
    expect(result.current.canRetry).toBe(false);
    expect(result.current.error).toBeNull();
    act(() => { result.current.retryLast(); });
    expect(invoke).toHaveBeenCalledTimes(1);

    // Same text typed by hand in the other session is a NEW exchange: its user turn is saved.
    await act(async () => { await result.current.send('carry over?'); await Promise.resolve(); await Promise.resolve(); });
    expect(vault.files['s-old'].turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      'user:carry over?',
      'agent:answer in the other session',
    ]);
  });
  it('a failure recorded after a mid-flight session switch never arms Retry in the new session', async () => {
    const vault = installTwoSessionApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('cut off')); }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.store.activeSessionId).toBe('s-new');

    act(() => { void result.current.send('asked in s-new'); });
    await act(async () => { await Promise.resolve(); });
    // Switch while the request is still running, THEN it fails.
    await act(async () => { await result.current.store.switchSession('s-old'); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.store.activeSessionId).toBe('s-old');
    expect(result.current.canRetry).toBe(false);
    expect(result.current.error).toBeNull();
    act(() => { result.current.retryLast(); });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(vault.files['s-old'].turns).toEqual([]);
  });

  it('Cancel in an unsaved chat then New chat clears Retry and does not resend into the new chat', async () => {
    const vault = installRealVaultApi();
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(() => { /* hang until cancel */ }))
      .mockResolvedValueOnce('should not land in the new chat');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const originId = result.current.store.activeSessionId;
    expect(originId).toBeTruthy();

    act(() => { void result.current.send('Probe old prompt'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { vault.fireStreamStart('req-old'); });
    act(() => { result.current.cancel(); });
    expect(result.current.canRetry).toBe(true);

    await act(async () => { await result.current.store.newSession(); });
    await act(async () => { await Promise.resolve(); });

    expect(result.current.store.activeSessionId).not.toBe(originId);
    expect(result.current.canRetry).toBe(false);
    expect(result.current.error).toBeNull();
    act(() => { result.current.retryLast(); });
    expect(invoke).toHaveBeenCalledTimes(1);
    const newId = result.current.store.activeSessionId!;
    expect(vault.files[newId]?.turns.some((t) => t.text === 'Probe old prompt')).not.toBe(true);
  });

  it('a pending session rekey on first write keeps Retry armed and working', async () => {
    const vault = installRealVaultApi({ rekeyOnCreate: true });
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('first write failed'))
      .mockResolvedValueOnce('recovered after rekey');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const pendingId = result.current.store.activeSessionId;
    expect(pendingId).toBeTruthy();

    await act(async () => { await result.current.send('rekey prompt'); await Promise.resolve(); await Promise.resolve(); });

    const materializedId = result.current.store.activeSessionId;
    expect(materializedId).toBeTruthy();
    expect(materializedId).not.toBe(pendingId);
    expect(result.current.store.resolveSessionId(pendingId!)).toBe(materializedId);
    expect(result.current.canRetry).toBe(true);

    await act(async () => { result.current.retryLast(); await Promise.resolve(); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0]).toBe('rekey prompt');
    expect(vault.files[materializedId!].turns.filter((t) => t.role === 'user' && t.text === 'rekey prompt')).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('Cancel during the failure-path persist does not duplicate the user turn on Retry', async () => {
    const api = installApi();
    let releasePersist: () => void = () => {};
    let persistStarted = false;
    api.appendTurns.mockImplementation(async (id: string, turns: AgentSessionTurn[]) => {
      if (!persistStarted) {
        persistStarted = true;
        await new Promise<void>((resolve) => { releasePersist = resolve; });
      }
      api.session.id = id;
      api.session.turns = [...api.session.turns, ...turns];
      return { session: { ...api.session, id } };
    });
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce('after persist race');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('persist race'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Catch is waiting on appendTurns. Cancel in that window.
    act(() => { result.current.cancel(); });
    expect(result.current.canRetry).toBe(true);

    await act(async () => { releasePersist(); await Promise.resolve(); await Promise.resolve(); });

    await act(async () => { result.current.retryLast(); await Promise.resolve(); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.messages.filter((m) => m.role === 'user' && m.text === 'persist race')).toHaveLength(1);
  });

  it('foreign and late chunks are never persisted on the failure path', async () => {
    const api = installApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('cut off')); }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('chunk pin'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-mine'); });
    act(() => { api.fireChunk('mine text', 'req-mine'); });
    act(() => { api.fireChunk('FOREIGN', 'req-other'); });
    act(() => { api.fireChunk('also late', 'req-previous'); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });

    const agentTurns = result.current.messages.filter((m) => m.role === 'agent');
    expect(agentTurns).toHaveLength(1);
    expect(agentTurns[0]?.text).toBe(`mine text ${RESPONSE_INCOMPLETE_SUFFIX}`);
    expect(agentTurns[0]?.text).not.toContain('FOREIGN');
    expect(agentTurns[0]?.text).not.toContain('also late');
  });

  it('early chunks that arrive before stream-start are kept when they match the request id', async () => {
    const api = installApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('cut off')); }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('early pin'); });
    await act(async () => { await Promise.resolve(); });
    // Chunks can land before stream-start: they share no IPC channel.
    // Two matching early chunks pin flush order (Critic S6 / C2).
    act(() => { api.fireChunk('Prefix', 'req-early'); });
    act(() => { api.fireChunk('FOREIGN', 'req-other'); });
    act(() => { api.fireChunk(' mid', 'req-early'); });
    act(() => { api.fireStreamStart('req-early'); });
    act(() => { api.fireChunk(' and rest', 'req-early'); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });

    const agentTurns = result.current.messages.filter((m) => m.role === 'agent');
    expect(agentTurns).toHaveLength(1);
    expect(agentTurns[0]?.text).toBe(`Prefix mid and rest ${RESPONSE_INCOMPLETE_SUFFIX}`);
    expect(agentTurns[0]?.text).not.toContain('FOREIGN');
  });

  it('early chunks are dropped when stream-start never arrives for that request id', async () => {
    const api = installApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('cut off')); }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('no start'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireChunk('orphan early', 'req-never'); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.messages.filter((m) => m.role === 'agent')).toHaveLength(0);
    expect(api.appendTurns.mock.calls.flatMap((c) => c[1] as AgentSessionTurn[])
      .some((t) => t.text.includes('orphan early'))).toBe(false);
  });

  it('flushing early chunks clears a stall warning and re-arms the stall timers', async () => {
    const api = installApi();
    const invoke = vi.fn(() => new Promise<string>(() => { /* hang */ }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('early stall'); });
    await act(async () => { await Promise.resolve(); });

    // Tokens can all land before stream-start. The stall clock still runs
    // from send() until the flush, so the hint may fire first.
    await act(async () => { await vi.advanceTimersByTimeAsync(STALL_WARNING_MS); });
    expect(result.current.stalled).toBe(true);

    act(() => { api.fireChunk('early-only', 'req-flush-stall'); });
    act(() => { api.fireStreamStart('req-flush-stall'); });
    expect(result.current.stalled).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(STALL_WARNING_MS - 1); });
    expect(result.current.stalled).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(result.current.stalled).toBe(true);
    expect(api.cancelAiActivity).not.toHaveBeenCalled();
  });

  it('early-chunk buffer drops overflow past the size and char caps', async () => {
    const api = installApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('cut off')); }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('cap pin'); });
    await act(async () => { await Promise.resolve(); });

    const oversized = 'A'.repeat(MAX_EARLY_CHUNK_CHARS);
    act(() => { api.fireChunk(oversized, 'req-cap'); });
    act(() => { api.fireChunk('TAIL', 'req-cap'); });
    act(() => { api.fireStreamStart('req-cap'); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });

    const agentTurns = result.current.messages.filter((m) => m.role === 'agent');
    expect(agentTurns).toHaveLength(1);
    expect(agentTurns[0]?.text).toBe(`${oversized} ${RESPONSE_INCOMPLETE_SUFFIX}`);
    expect(agentTurns[0]?.text).not.toContain('TAIL');
    expect(agentTurns[0]?.incomplete).toBe(true);
  });

  it('early-chunk buffer keeps only the first MAX_EARLY_CHUNKS matching tokens', async () => {
    const api = installApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('cut off')); }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('count cap'); });
    await act(async () => { await Promise.resolve(); });

    act(() => {
      for (let i = 0; i < MAX_EARLY_CHUNKS; i++) api.fireChunk('x', 'req-count');
      api.fireChunk('Y', 'req-count');
    });
    act(() => { api.fireStreamStart('req-count'); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });

    const agentTurns = result.current.messages.filter((m) => m.role === 'agent');
    expect(agentTurns).toHaveLength(1);
    expect(agentTurns[0]?.text).toBe(`${'x'.repeat(MAX_EARLY_CHUNKS)} ${RESPONSE_INCOMPLETE_SUFFIX}`);
    expect(agentTurns[0]?.text).not.toContain('Y');
    expect(agentTurns[0]?.incomplete).toBe(true);
  });

  it('first cap overflow latches: later smaller early chunks are refused (no mid-reply hole)', async () => {
    const api = installApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('cut off')); }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('latch pin'); });
    await act(async () => { await Promise.resolve(); });

    // Fill the char budget almost to the cap, then overflow with a large
    // chunk. A following smaller chunk would fit the leftover budget if
    // the cap only skipped the oversized one — that is a silent hole.
    const prefix = 'A'.repeat(MAX_EARLY_CHUNK_CHARS - 10);
    act(() => { api.fireChunk(prefix, 'req-latch'); });
    act(() => { api.fireChunk('B'.repeat(50), 'req-latch'); });
    act(() => { api.fireChunk('small', 'req-latch'); });
    act(() => { api.fireStreamStart('req-latch'); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });

    const agentTurns = result.current.messages.filter((m) => m.role === 'agent');
    expect(agentTurns).toHaveLength(1);
    expect(agentTurns[0]?.text).toBe(`${prefix} ${RESPONSE_INCOMPLETE_SUFFIX}`);
    expect(agentTurns[0]?.text).not.toContain('small');
    expect(agentTurns[0]?.incomplete).toBe(true);
  });

  it('early-chunk caps are per requestId: foreign tokens cannot crowd out a matching chunk', async () => {
    const api = installApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('cut off')); }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('cross cap'); });
    await act(async () => { await Promise.resolve(); });

    act(() => { api.fireChunk('F'.repeat(MAX_EARLY_CHUNK_CHARS), 'req-foreign'); });
    act(() => {
      for (let i = 0; i < MAX_EARLY_CHUNKS; i++) api.fireChunk('f', 'req-foreign-count');
    });
    act(() => { api.fireChunk('MINE', 'req-mine'); });
    act(() => { api.fireStreamStart('req-mine'); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });

    const agentTurns = result.current.messages.filter((m) => m.role === 'agent');
    expect(agentTurns).toHaveLength(1);
    expect(agentTurns[0]?.text).toBe(`MINE ${RESPONSE_INCOMPLETE_SUFFIX}`);
    expect(agentTurns[0]?.text).not.toContain('F');
    expect(agentTurns[0]?.incomplete).toBe(true);
  });

  it('tryPushEarlyChunk keeps a running char total and takeEarlyLane drops other requestIds', () => {
    const lanes = new Map();
    expect(tryPushEarlyChunk(lanes, 'a', 'abc')).toBe('accepted');
    expect(lanes.get('a')?.chars).toBe(3);
    expect(tryPushEarlyChunk(lanes, 'a', 'de')).toBe('accepted');
    expect(lanes.get('a')?.chars).toBe(5);
    expect(lanes.get('a')?.chars).toBe((lanes.get('a')?.chunks ?? []).join('').length);
    expect(tryPushEarlyChunk(lanes, 'b', 'x')).toBe('accepted');
    const taken = takeEarlyLane(lanes, 'a');
    expect(taken?.chunks.join('')).toBe('abcde');
    expect(taken?.chars).toBe(5);
    expect(lanes.size).toBe(0);
  });

  it('Cancel after a mid-flight session switch does not show a cancel error in the new chat', async () => {
    const vault = installTwoSessionApi();
    const invoke = vi.fn().mockImplementationOnce(() => new Promise<string>(() => { /* hang */ }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('asked in s-new'); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await result.current.store.switchSession('s-old'); });
    act(() => { result.current.cancel(); });

    expect(result.current.store.activeSessionId).toBe('s-old');
    expect(result.current.canRetry).toBe(false);
    expect(result.current.error).toBeNull();
    void vault;
  });

  it('canRetry is cleared while a Retry send is running', async () => {
    installApi();
    let finishRetry: (v: string) => void = () => {};
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishRetry = resolve; }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.send('running flag'); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.canRetry).toBe(true);
    act(() => { result.current.retryLast(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.busy).toBe(true);
    expect(result.current.canRetry).toBe(false);

    await act(async () => { finishRetry('ok'); await Promise.resolve(); await Promise.resolve(); });
  });

  it('a failed send with a kept partial tells the user the partial reply was kept', async () => {
    const api = installApi();
    let fail: () => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = () => reject(new Error('stream ended early')); }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('kept partial'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { api.fireStreamStart('req-kept'); });
    act(() => { api.fireChunk('Part one', 'req-kept'); });
    await act(async () => { fail(); await Promise.resolve(); await Promise.resolve(); });

    expect(String(result.current.error)).toMatch(/partial reply kept above/i);
  });
  // Shield F2 / Critic M4: an exchange whose origin could not be verified
  // (no active chat when it was sent) must never be treated as belonging to
  // the chat that is open now.
  it('M4: a failure with an undefined origin never arms Retry and retryLast never resends it', async () => {
    // No agentSessions API → the store never gets an active session id.
    const api = installApi();
    delete (window.api as unknown as Record<string, unknown>).agentSessions;
    const invoke = vi.fn().mockRejectedValue(new Error('provider down'));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.store.activeSessionId).toBeNull();

    await act(async () => { await result.current.send('who owns me'); await Promise.resolve(); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.current.canRetry).toBe(false);
    expect(result.current.error).toBeNull();

    // Even called directly (not via the hidden button) it must not resend.
    await act(async () => { result.current.retryLast(); await Promise.resolve(); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(api.appendTurns).not.toHaveBeenCalled();
  });

  it('M4: Cancel with an undefined origin does not arm Retry or show a cancel error', async () => {
    installApi();
    delete (window.api as unknown as Record<string, unknown>).agentSessions;
    const invoke = vi.fn(() => new Promise<string>(() => { /* hang */ }));
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); });

    act(() => { void result.current.send('hang unverified'); });
    await act(async () => { await Promise.resolve(); });
    act(() => { result.current.cancel(); });
    expect(result.current.canRetry).toBe(false);
    expect(result.current.error).toBeNull();
    await act(async () => { result.current.retryLast(); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // Critic M8: Cancel's fallback exchange (no in-flight record) must carry the
  // active session id, not undefined, so Retry arms for this chat.
  it('M8: Cancel with an empty inFlightRef records the active session id as origin', async () => {
    const api = installApi();
    const invoke = vi.fn()
      .mockResolvedValueOnce('first reply')
      .mockResolvedValueOnce('second reply');
    const { result } = renderHook(() => useMiniAgentChat('brainstorm', invoke));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const activeId = result.current.store.activeSessionId;
    expect(activeId).toBeTruthy();

    // Capture Cancel from a render where a prompt is pending, then let the
    // exchange finish: inFlightRef is now empty but this Cancel still runs.
    let finish: (v: string) => void = () => {};
    invoke.mockReset();
    invoke.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    invoke.mockResolvedValueOnce('retried reply');
    act(() => { void result.current.send('late cancel'); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.busy).toBe(true);
    const staleCancel = result.current.cancel;
    await act(async () => { finish('done'); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.busy).toBe(false);

    act(() => { staleCancel(); });
    expect(result.current.canRetry).toBe(true);
    expect(result.current.error).toMatch(/cancelled/i);

    api.appendTurns.mockClear();
    await act(async () => { result.current.retryLast(); await Promise.resolve(); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0]).toBe('late cancel');
    // Retry's write is pinned to the session the exchange belongs to.
    const ownerId = result.current.store.resolveSessionId(activeId!);
    expect(api.appendTurns.mock.calls.length).toBeGreaterThan(0);
    expect(api.appendTurns.mock.calls.every((c) => c[0] === ownerId)).toBe(true);
  });
});
