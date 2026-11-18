// Beta 4 M25 — mini-chat logic for the timeline side-tabs (§8.6, §14.5).
//
// Built on the SHARED agent-session stores (useAgentSessions), so the
// Brainstorm mini chat and the Brainstorm page/hub render one conversation —
// same for Archive. Mirrors useCoachConversation: optimistic pending bubble,
// origin-session pinning, and turns persisted to the vault session file.

import { useCallback, useRef, useState } from 'react';
import { useAgentSessions, type UseAgentSessionsResult } from '../../lib/useAgentSessions';
import { cancelAiActivity } from '../../agents/aiActivity';
import { historyContentForModel, neutralizeLeadingCoachCardMarker } from '../../coach/coachMessages';

export type MiniChatInvoke = (
  prompt: string,
  history: { role: 'user' | 'assistant'; content: string }[],
) => Promise<string | { text: string; cardTitle?: string; cardFoot?: string; cardKind?: AgentSessionTurn['cardKind'] }>;

export interface MiniAgentChat {
  /** Shared session store — feed the session pill with this. */
  store: UseAgentSessionsResult;
  messages: AgentSessionTurn[];
  /** In-flight user prompt (optimistic bubble + typing dots). */
  pendingPrompt: string | null;
  busy: boolean;
  error: string | null;
  /** Last failed user prompt can be resent via Retry (error strip). */
  canRetry: boolean;
  /** Soft stall (still waiting — show Retry/Cancel). */
  stalled: boolean;
  send: (prompt: string) => Promise<void>;
  /** Resend the last failed prompt without retyping. */
  retryLast: () => void;
  /** Abort the in-flight provider stream in MAIN, then clear UI. */
  cancel: () => void;
  /**
   * F3 — drop a completed action (Update Timeline / Beta Read / Writer Scan)
   * into the shared thread without going through the chat invoke path.
   */
  postActionResult: (
    userLabel: string,
    agentText: string,
    extras?: { cardTitle?: string; cardFoot?: string; cardKind?: AgentSessionTurn['cardKind'] },
  ) => Promise<void>;
}

/**
 * Renderer-side history window sent with each chat invoke.
 * Main accepts up to 50 (`MAX_AGENT_HISTORY_TURNS` in electron-main); we send
 * a tighter 20-turn window so prompts stay bounded (security bar c).
 */
export const MAX_HISTORY_TURNS = 20;

/** Soft stall warning — generation still running; user can cancel. */
export const STALL_WARNING_MS = 20_000;
/** Hard timeout — abort the provider stream in MAIN. */
export const HARD_TIMEOUT_MS = 90_000;

const RESPONSE_INCOMPLETE_SUFFIX = '(response incomplete)';

type FailedExchange = {
  prompt: string;
  /** User turn from the failed attempt is already in the session feed. */
  userInFeed: boolean;
};

/** Drop the failed exchange tail so retry invoke(history, prompt) does not duplicate the user turn. */
function turnsForModelHistory(turns: AgentSessionTurn[], retryPrompt: string | null): AgentSessionTurn[] {
  let work = turns;
  if (!retryPrompt) {
    return work.slice(-MAX_HISTORY_TURNS);
  }
  const trimmed = [...work];
  const last = trimmed.at(-1);
  if (last?.role === 'agent' && last.text.includes(RESPONSE_INCOMPLETE_SUFFIX)) {
    trimmed.pop();
  }
  const lastUser = trimmed.at(-1);
  if (lastUser?.role === 'user' && lastUser.text === retryPrompt) {
    trimmed.pop();
  }
  return trimmed.slice(-MAX_HISTORY_TURNS);
}

function getEffectiveTimerMs(fallback: number, key: 'stallWarningMs' | 'hardTimeoutMs'): number {
  const override = (window as unknown as { __MYTHOS_E2E_TIMERS__?: Partial<Record<string, number>> })
    .__MYTHOS_E2E_TIMERS__?.[key];
  return typeof override === 'number' && override > 0 ? override : fallback;
}

function abortInMain(requestId: string | null): void {
  if (!requestId) return;
  // Unified cancel path — aborts AbortController in main (provider stream stops).
  cancelAiActivity(requestId);
  window.api?.cancelBrainstorm?.(requestId);
  window.api?.cancelWritingAssistant?.(requestId);
}

export function useMiniAgentChat(agent: 'brainstorm' | 'archive', invoke: MiniChatInvoke): MiniAgentChat {
  const store = useAgentSessions(agent);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [stalled, setStalled] = useState(false);
  const mainRequestIdRef = useRef<string | null>(null);
  const streamAccumRef = useRef('');
  const lastFailedPromptRef = useRef<string | null>(null);
  const lastFailedExchangeRef = useRef<FailedExchange | null>(null);
  const generationGenRef = useRef(0);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamStartUnsubRef = useRef<(() => void) | null>(null);
  const chunkUnsubRef = useRef<(() => void) | null>(null);

  const clearTimers = useCallback(() => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
    if (hardTimerRef.current) {
      clearTimeout(hardTimerRef.current);
      hardTimerRef.current = null;
    }
  }, []);

  const clearStreamStartSub = useCallback(() => {
    streamStartUnsubRef.current?.();
    streamStartUnsubRef.current = null;
  }, []);

  const clearChunkSub = useCallback(() => {
    chunkUnsubRef.current?.();
    chunkUnsubRef.current = null;
  }, []);

  const resetInFlight = useCallback(() => {
    clearTimers();
    clearStreamStartSub();
    clearChunkSub();
    mainRequestIdRef.current = null;
    setPendingPrompt(null);
    setStalled(false);
  }, [clearTimers, clearStreamStartSub, clearChunkSub]);

  const scheduleStallTimers = useCallback((gen: number) => {
    clearTimers();
    stallTimerRef.current = setTimeout(() => {
      if (generationGenRef.current !== gen) return;
      setStalled(true);
    }, getEffectiveTimerMs(STALL_WARNING_MS, 'stallWarningMs'));

    hardTimerRef.current = setTimeout(() => {
      if (generationGenRef.current !== gen) return;
      // N4: stall timeout aborts in MAIN (provider stream stops), not UI-only.
      // Critic hard 2: abort ONLY this chat's stream-start request id.
      abortInMain(mainRequestIdRef.current);
      generationGenRef.current += 1;
      resetInFlight();
      setError('Generation timed out. The network or provider may be slow — please retry.');
    }, getEffectiveTimerMs(HARD_TIMEOUT_MS, 'hardTimeoutMs'));
  }, [clearTimers, resetInFlight]);

  const cancel = useCallback(() => {
    if (pendingPrompt === null) return;
    const cancelledPrompt = pendingPrompt;
    // N4: Cancel must abort the request in MAIN — bound to THIS chat's id.
    abortInMain(mainRequestIdRef.current);
    generationGenRef.current += 1;
    resetInFlight();
    lastFailedPromptRef.current = cancelledPrompt;
    lastFailedExchangeRef.current = { prompt: cancelledPrompt, userInFeed: false };
    setCanRetry(true);
    setError('Generation cancelled. You can retry now.');
  }, [pendingPrompt, resetInFlight]);

  const send = useCallback(async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed || pendingPrompt !== null) return;
    const failedExchange = lastFailedExchangeRef.current;
    const isRetryOfFailed = failedExchange?.prompt === trimmed;
    setError(null);
    setCanRetry(false);
    setStalled(false);
    setPendingPrompt(trimmed);
    streamAccumRef.current = '';

    generationGenRef.current += 1;
    const gen = generationGenRef.current;
    mainRequestIdRef.current = null;

    // Capture main-issued requestId from stream-start so Cancel/stall can abort
    // ONLY this job (Critic hard 2 — do not take newest app-wide activity).
    clearStreamStartSub();
    clearChunkSub();
    const onStart =
      agent === 'brainstorm'
        ? window.api?.onBrainstormStreamStart
        : window.api?.onWritingAssistantStreamStart;
    if (typeof onStart === 'function') {
      streamStartUnsubRef.current = onStart((requestId: string) => {
        if (generationGenRef.current === gen) {
          mainRequestIdRef.current = requestId;
        }
      });
    }

    // Critic hard 3: re-arm stall/hard timers on every streamed chunk.
    const onChunk =
      agent === 'brainstorm'
        ? window.api?.onBrainstormChunk
        : window.api?.onWritingAssistantChunk;
    if (typeof onChunk === 'function') {
      chunkUnsubRef.current = onChunk((chunk: string) => {
        if (generationGenRef.current !== gen) return;
        if (chunk) streamAccumRef.current += chunk;
        setStalled(false);
        scheduleStallTimers(gen);
      });
    }

    scheduleStallTimers(gen);

    // Pin this exchange to whichever session is active RIGHT NOW (SKY-7076):
    // if the user switches sessions before the reply lands, the turns still
    // belong to the session they were asked from.
    const originSessionId = store.activeSessionId ?? undefined;
    // Critic N2: never send raw card JSON / markers as model history.
    const historySource = turnsForModelHistory(
      store.activeSession?.turns ?? [],
      isRetryOfFailed ? trimmed : null,
    );
    const history = historySource.map((t) => ({
      role: t.role === 'agent' ? ('assistant' as const) : ('user' as const),
      content: historyContentForModel(t, { sessionAgent: store.activeSession?.agent }),
    }));

    try {
      const result = await invoke(trimmed, history);
      if (generationGenRef.current !== gen) return;
      const now = new Date().toISOString();
      // Defensive: invoke must return string | { text }. A bare undefined used to
      // throw "Cannot read properties of undefined (reading 'text')" and skip
      // appendTurns — so the user bubble never landed in the feed.
      const agentTextRaw = typeof result === 'string' ? result : result?.text;
      if (typeof agentTextRaw !== 'string') {
        throw new Error('Agent returned no text.');
      }
      const agentTurn: AgentSessionTurn = {
        role: 'agent',
        text: agentTextRaw,
        at: new Date().toISOString(),
      };
      if (typeof result !== 'string') {
        if (result.cardKind) agentTurn.cardKind = result.cardKind;
        if (result.cardTitle) {
          agentTurn.cardTitle = result.cardTitle;
          if (result.cardFoot) agentTurn.cardFoot = result.cardFoot;
        }
      }
      // HARD 1(c)(i): neutralize leading coach-card marker before persist when
      // there is no structural cardKind (trusted writers set cardKind).
      if (!agentTurn.cardKind) {
        agentTurn.text = neutralizeLeadingCoachCardMarker(agentTurn.text);
      }
      const lastTurn = store.activeSession?.turns.at(-1);
      const userAlreadyInFeed =
        (isRetryOfFailed && failedExchange?.userInFeed)
        || (lastTurn?.role === 'user' && lastTurn.text === trimmed);
      await store.appendTurns(
        userAlreadyInFeed
          ? [agentTurn]
          : [
            { role: 'user', text: trimmed, at: now },
            agentTurn,
          ],
        originSessionId,
      );
      lastFailedPromptRef.current = null;
      lastFailedExchangeRef.current = null;
      streamAccumRef.current = '';
    } catch (err) {
      if (generationGenRef.current !== gen) return;
      const msg = err instanceof Error ? err.message : String(err);
      const now = new Date().toISOString();
      const partial = streamAccumRef.current.trim();
      const lastExisting = store.activeSession?.turns.at(-1);
      const failedTurns: AgentSessionTurn[] = lastExisting?.role === 'user' && lastExisting.text === trimmed
        ? []
        : [{ role: 'user', text: trimmed, at: now }];
      if (partial) {
        failedTurns.push({
          role: 'agent',
          text: `${partial} (response incomplete)`,
          at: new Date().toISOString(),
        });
      }
      if (failedTurns.length > 0) {
        try {
          await store.appendTurns(failedTurns, originSessionId);
        } catch {
          // Feed stays usable even if vault persist fails.
        }
      }
      const userInFeed =
        (lastExisting?.role === 'user' && lastExisting.text === trimmed)
        || failedTurns.some((t) => t.role === 'user' && t.text === trimmed);
      streamAccumRef.current = '';
      lastFailedPromptRef.current = trimmed;
      lastFailedExchangeRef.current = { prompt: trimmed, userInFeed };
      setCanRetry(true);
      const base = msg || 'Agent unavailable — check your provider settings.';
      setError(partial ? `${base} (partial reply kept above)` : base);
    } finally {
      if (generationGenRef.current === gen) {
        resetInFlight();
      } else {
        clearStreamStartSub();
        clearChunkSub();
        clearTimers();
      }
    }
  }, [pendingPrompt, store, invoke, agent, scheduleStallTimers, resetInFlight, clearStreamStartSub, clearChunkSub, clearTimers]);

  // retryLast closes over send — declare after send is defined (eslint hoisting safe via function body order fix)
  const retryLastBound = useCallback(() => {
    const replay = lastFailedPromptRef.current;
    if (!replay || pendingPrompt !== null) return;
    void send(replay);
  }, [pendingPrompt, send]);

  const postActionResult = useCallback(async (
    userLabel: string,
    agentText: string,
    extras?: { cardTitle?: string; cardFoot?: string; cardKind?: AgentSessionTurn['cardKind'] },
  ) => {
    const now = new Date().toISOString();
    const agentTurn: AgentSessionTurn = {
      role: 'agent',
      text: extras?.cardKind ? agentText : neutralizeLeadingCoachCardMarker(agentText),
      at: now,
    };
    if (extras?.cardKind) agentTurn.cardKind = extras.cardKind;
    if (extras?.cardTitle) {
      agentTurn.cardTitle = extras.cardTitle;
      if (extras.cardFoot) agentTurn.cardFoot = extras.cardFoot;
    }
    await store.appendTurns([
      { role: 'user', text: userLabel, at: now },
      agentTurn,
    ]);
  }, [store]);

  return {
    store,
    messages: store.activeSession?.turns ?? [],
    pendingPrompt,
    busy: pendingPrompt !== null,
    error,
    canRetry,
    stalled,
    send,
    retryLast: retryLastBound,
    cancel,
    postActionResult,
  };
}
