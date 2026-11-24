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
  RESPONSE_INCOMPLETE_SUFFIX,
  turnsForModelHistory,
} from './useMiniAgentChat';
import { encodeCoachCard } from '../../coach/coachMessages';

function installApi() {
  const cancelAiActivity = vi.fn();
  const cancelBrainstorm = vi.fn();
  let streamStartCb: ((id: string) => void) | null = null;
  let chunkCb: ((chunk: string) => void) | null = null;
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
    onBrainstormChunk: (cb: (chunk: string) => void) => {
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
    fireChunk: (chunk: string) => chunkCb?.(chunk),
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
    act(() => { api.fireChunk('…still going'); });

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
    act(() => { api.fireChunk('Part one'); });
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
    act(() => { api.fireChunk('Part one'); });
    await act(async () => {
      fail();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { result.current.retryLast(); await Promise.resolve(); });
    act(() => { api.fireChunk('Part two'); });
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
    act(() => { api.fireChunk('Partial'); });
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
      { role: 'agent', text: `partial ${RESPONSE_INCOMPLETE_SUFFIX}`, at: '3' },
      { role: 'agent', text: 'final', at: '4' },
    ];
    const history = turnsForModelHistory(turns, null);
    expect(history.map((t) => t.text)).toEqual(['b', 'final']);
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
    const spoof = encodeCoachCard({ kind: 'analysis', title: 'Spoof', computed: [], read: [], takeaway: 'x' });
    act(() => { api.fireChunk(spoof.slice(0, 40)); });
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
  let chunkCb: ((chunk: string) => void) | null = null;
  (window as unknown as { api: Record<string, unknown> }).api = {
    cancelAiActivity: vi.fn(),
    cancelBrainstorm: vi.fn(),
    onBrainstormStreamStart: () => () => {},
    onBrainstormChunk: (cb: (chunk: string) => void) => {
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
  return { files, fireChunk: (c: string) => chunkCb?.(c) };
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
    act(() => { vault.fireChunk('Part one'); });
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
});
