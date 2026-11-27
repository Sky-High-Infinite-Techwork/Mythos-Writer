// Beta 4 M25 — mini-chat logic for the timeline side-tabs (§8.6, §14.5).
//
// Built on the SHARED agent-session stores (useAgentSessions), so the
// Brainstorm mini chat and the Brainstorm page/hub render one conversation —
// same for Archive. Mirrors useCoachConversation: optimistic pending bubble,
// origin-session pinning, and turns persisted to the vault session file.

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /**
   * The in-flight prompt's user turn is already saved in the session feed
   * (a Retry of a failed send), so the optimistic bubble must not render a
   * second copy while the retry is running.
   */
  pendingPromptInFeed?: boolean;
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
/**
 * Bound the early-chunk buffer when stream-start is late or never arrives.
 * Main sends stream-start before the token loop, so this only covers IPC
 * reordering plus a missing start — not a full reply on the happy path.
 */
export const MAX_EARLY_CHUNKS = 1024;
export const MAX_EARLY_CHUNK_CHARS = 262_144;
/**
 * Global bounds on the early buffer, across all requestId lanes:
 * - MAX_EARLY_LANES: at most this many lanes (bounds Map entries and, with the
 *   per-lane count cap, total chunks to MAX_EARLY_LANES x MAX_EARLY_CHUNKS).
 * - MAX_EARLY_TOTAL_CHARS: one running char budget shared by all lanes
 *   (linear, like the per-lane running total). Set to 2x the per-lane cap so a
 *   single full foreign lane can never starve the matching request (S10).
 *
 * Policy: refuse, never evict. Before stream-start we cannot tell which id is
 * ours, so eviction would let a flood of foreign ids push out our own lane.
 * A NEW id is refused once the lane table is full; a chunk that would pass the
 * global char budget latches its lane, exactly like a per-lane overflow (S8).
 * Residual starvation (accepted): our lane can still be starved before
 * stream-start by 8 foreign ids (lane cap) OR by just 2 full foreign lanes
 * (2 x MAX_EARLY_CHUNK_CHARS uses the whole char budget). One full foreign lane
 * cannot. Main sends our stream-start before our token loop, so our id is
 * normally among the first lanes. If our tokens were dropped anyway, the hook latches
 * our request at stream-start (`earlyLaneLost`): no later token is appended,
 * so a failure partial never has a hole or a missing head.
 */
export const MAX_EARLY_LANES = 8;
export const MAX_EARLY_TOTAL_CHARS = 2 * MAX_EARLY_CHUNK_CHARS;

/** Per-requestId early-chunk lane (caps and the running char total are scoped here). */
export type EarlyChunkLane = { chunks: string[]; chars: number; overflowed: boolean };

/**
 * Per-request early lanes, plus a running char total across all lanes and a
 * sticky flag set when a new requestId was refused because the table was full.
 */
export type EarlyChunkLanes = Map<string, EarlyChunkLane> & {
  totalChars?: number;
  refusedNewId?: boolean;
};

export type EarlyChunkLimits = {
  maxChunks: number;
  maxChars: number;
  maxLanes: number;
  maxTotalChars: number;
};

const DEFAULT_EARLY_LIMITS: EarlyChunkLimits = {
  maxChunks: MAX_EARLY_CHUNKS,
  maxChars: MAX_EARLY_CHUNK_CHARS,
  maxLanes: MAX_EARLY_LANES,
  maxTotalChars: MAX_EARLY_TOTAL_CHARS,
};

/**
 * Push one early chunk into a per-requestId lane.
 * Uses a running `lane.chars` total (linear). On the first overflow for that
 * requestId the lane latches and later chunks are refused, so a dropped
 * mid-reply token cannot be followed by a smaller accepted one.
 * Global bounds: a new requestId is refused once `maxLanes` lanes exist, and a
 * chunk that would pass `maxTotalChars` across all lanes latches its lane.
 */
export function tryPushEarlyChunk(
  lanes: EarlyChunkLanes,
  requestId: string,
  chunk: string,
  limits: EarlyChunkLimits = DEFAULT_EARLY_LIMITS,
): 'accepted' | 'overflowed' | 'latched' | 'refused' {
  let lane = lanes.get(requestId);
  if (!lane) {
    if (lanes.size >= limits.maxLanes) {
      lanes.refusedNewId = true;
      return 'refused';
    }
    lane = { chunks: [], chars: 0, overflowed: false };
    lanes.set(requestId, lane);
  }
  if (lane.overflowed) return 'latched';
  const total = lanes.totalChars ?? 0;
  if (
    lane.chunks.length >= limits.maxChunks
    || lane.chars + chunk.length > limits.maxChars
    || total + chunk.length > limits.maxTotalChars
  ) {
    lane.overflowed = true;
    return 'overflowed';
  }
  lane.chunks.push(chunk);
  lane.chars += chunk.length;
  lanes.totalChars = total + chunk.length;
  return 'accepted';
}

/** Clear every lane, the global running total and the refused-id flag. */
export function clearEarlyLanes(lanes: EarlyChunkLanes): void {
  lanes.clear();
  lanes.totalChars = 0;
  lanes.refusedNewId = false;
}

/** Take one requestId's lane and drop the rest (stream-start flushes the buffer). */
export function takeEarlyLane(
  lanes: EarlyChunkLanes,
  requestId: string,
): EarlyChunkLane | undefined {
  const lane = lanes.get(requestId);
  clearEarlyLanes(lanes);
  return lane;
}

/**
 * True when some of this request's early tokens were dropped: its lane
 * overflowed (S8 latch), or it has no lane while a new id was refused because
 * the table was full (it may have been ours). Call before takeEarlyLane.
 */
export function earlyLaneLost(lanes: EarlyChunkLanes, requestId: string): boolean {
  const lane = lanes.get(requestId);
  if (lane) return lane.overflowed;
  return lanes.refusedNewId === true;
}

export const RESPONSE_INCOMPLETE_SUFFIX = '(response incomplete)';

type FailedExchange = {
  prompt: string;
  originSessionId: string | undefined;
  /** User turn is already in the vault feed for originSessionId. */
  userPersisted: boolean;
};

/**
 * A kept partial reply (failure path) — never sent back to the model. Keyed on
 * the structural `incomplete` flag, not on the user-visible suffix: a finished
 * reply that happens to end with the same words is kept, and a partial whose
 * text was reflowed (trailing newline, edited tail) is still dropped.
 */
function isIncompleteAgentTurn(turn: AgentSessionTurn): boolean {
  return turn.role === 'agent' && turn.incomplete === true;
}

/**
 * True when the feed already ends with this user prompt, ignoring a kept
 * "(response incomplete)" partial after it. Checks the TAIL only: an older
 * user turn with the same text ("yes", "continue") is a different exchange.
 */
export function feedEndsWithUserPrompt(turns: AgentSessionTurn[], prompt: string): boolean {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (isIncompleteAgentTurn(turn)) continue;
    return turn.role === 'user' && turn.text === prompt;
  }
  return false;
}

/** Model history: drop incomplete agent turns and collapse orphan consecutive user turns. */
export function turnsForModelHistory(turns: AgentSessionTurn[], retryPrompt: string | null): AgentSessionTurn[] {
  const withoutIncomplete = turns.filter((t) => !isIncompleteAgentTurn(t));
  const collapsed: AgentSessionTurn[] = [];
  for (const turn of withoutIncomplete) {
    const prev = collapsed.at(-1);
    if (turn.role === 'user' && prev?.role === 'user') {
      collapsed.pop();
    }
    collapsed.push(turn);
  }
  if (retryPrompt) {
    const last = collapsed.at(-1);
    if (last?.role === 'user' && last.text === retryPrompt) {
      collapsed.pop();
    }
  }
  // Orphan user at end (failed send / partial stripped) is re-sent as `prompt`.
  const trailingUser = collapsed.at(-1);
  if (trailingUser?.role === 'user') {
    collapsed.pop();
  }
  return collapsed.slice(-MAX_HISTORY_TURNS);
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
  const resolveSessionId = store.resolveSessionId;
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [pendingPromptInFeed, setPendingPromptInFeed] = useState(false);
  const mainRequestIdRef = useRef<string | null>(null);
  const streamAccumRef = useRef('');
  const lastFailedExchangeRef = useRef<FailedExchange | null>(null);
  /** The exchange currently being sent (null when idle) — Cancel / timeout arm Retry from it. */
  const inFlightRef = useRef<FailedExchange | null>(null);
  const generationGenRef = useRef(0);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamStartUnsubRef = useRef<(() => void) | null>(null);
  const chunkUnsubRef = useRef<(() => void) | null>(null);
  /** Early chunks, budgeted per requestId, that arrived before stream-start. */
  const earlyLanesRef = useRef<EarlyChunkLanes>(new Map());
  /**
   * Set at stream-start when this request lost early tokens. Later chunks are
   * not kept, so a failure partial never has a hole (they still re-arm timers).
   * Reset once per request in send(); sticky within the request, so a repeated
   * stream-start (lanes already empty) cannot un-latch it.
   */
  const mineLatchedRef = useRef(false);
  const prevActiveSessionIdRef = useRef<string | null | undefined>(undefined);

  const canonicalSessionId = useCallback((id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    return resolveSessionId(id);
  }, [resolveSessionId]);

  const pinUndefinedOrigins = useCallback((sessionId: string) => {
    if (inFlightRef.current && inFlightRef.current.originSessionId === undefined) {
      inFlightRef.current.originSessionId = sessionId;
    }
    const failed = lastFailedExchangeRef.current;
    if (failed && failed.originSessionId === undefined) {
      failed.originSessionId = sessionId;
      if (canonicalSessionId(sessionId) === canonicalSessionId(store.activeSessionId ?? undefined)) {
        setCanRetry(true);
      }
    }
  }, [canonicalSessionId, store.activeSessionId]);

  // A failed exchange belongs to the session it was sent from. A genuine
  // session switch drops Retry + the error strip (Retry would otherwise
  // resend the old prompt into the newly opened thread). The one id change
  // that is NOT a switch is a first-write rekey reported by the session
  // store (resolveSessionId). "+ New chat" and deleting an unsaved chat
  // are switches — the old heuristic treated them as materialization.
  useEffect(() => {
    const prev = prevActiveSessionIdRef.current;
    const cur = store.activeSessionId ?? null;
    prevActiveSessionIdRef.current = cur;
    if (prev === undefined) return;
    if (cur === prev) return;
    // Init (or the first session appearing): pin exchanges that had no
    // origin yet. Do not treat this as "belongs to every session".
    if (prev === null && cur !== null) {
      pinUndefinedOrigins(cur);
      return;
    }
    if (prev !== null && cur !== null && resolveSessionId(prev) === cur) {
      return;
    }
    lastFailedExchangeRef.current = null;
    setCanRetry(false);
    setError(null);
  }, [store.activeSessionId, resolveSessionId, pinUndefinedOrigins]);

  // The chat on screen right now (read inside timers / awaited catches, where
  // the render-time value would be stale).
  const activeSessionIdRef = useRef<string | undefined>(store.activeSessionId ?? undefined);
  activeSessionIdRef.current = store.activeSessionId ?? undefined;

  /** True when a failed exchange was sent from the chat that is open now. */
  const belongsToActiveSession = useCallback((exchange: FailedExchange | null): boolean => {
    if (exchange === null) return false;
    // An unverified origin must not be treated as belonging to every session.
    if (exchange.originSessionId === undefined) return false;
    return canonicalSessionId(exchange.originSessionId) === canonicalSessionId(activeSessionIdRef.current);
  }, [canonicalSessionId]);

  // Arms Retry only for a failure from the chat that is open now. A failure,
  // timeout or cancel recorded after a mid-flight session switch belongs to
  // the old chat: Retry stays off so its prompt is never resent into the new
  // one. Returns whether Retry was armed.
  const recordFailedExchange = useCallback((exchange: FailedExchange): boolean => {
    if (exchange.originSessionId === undefined) {
      // Keep the exchange so the first session that appears can pin it.
      // Do not arm Retry until the origin is verified.
      lastFailedExchangeRef.current = exchange;
      return false;
    }
    if (!belongsToActiveSession(exchange)) return false;
    lastFailedExchangeRef.current = exchange;
    setCanRetry(true);
    return true;
  }, [belongsToActiveSession]);

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
    clearEarlyLanes(earlyLanesRef.current);
    inFlightRef.current = null;
    setPendingPrompt(null);
    setPendingPromptInFeed(false);
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
      const timedOut = inFlightRef.current;
      generationGenRef.current += 1;
      resetInFlight();
      // The error tells the user to retry — arm Retry (same as Cancel) so the
      // prompt is not lost once the generation bump disarms send()'s catch.
      if (!timedOut || recordFailedExchange(timedOut)) {
        setError('Generation timed out. The network or provider may be slow — please retry.');
      }
    }, getEffectiveTimerMs(HARD_TIMEOUT_MS, 'hardTimeoutMs'));
  }, [clearTimers, resetInFlight, recordFailedExchange]);

  const cancel = useCallback(() => {
    if (pendingPrompt === null) return;
    const cancelled = inFlightRef.current;
    // N4: Cancel must abort the request in MAIN — bound to THIS chat's id.
    abortInMain(mainRequestIdRef.current);
    generationGenRef.current += 1;
    resetInFlight();
    const armed = recordFailedExchange(cancelled ?? {
      prompt: pendingPrompt,
      originSessionId: activeSessionIdRef.current,
      userPersisted: false,
    });
    if (armed) setError('Generation cancelled. You can retry now.');
  }, [pendingPrompt, resetInFlight, recordFailedExchange]);

  const send = useCallback(async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed || pendingPrompt !== null) return;
    setError(null);
    setCanRetry(false);
    setStalled(false);
    streamAccumRef.current = '';
    mineLatchedRef.current = false;
    // Early lanes are not cleared here: every path that ends a
    // request (finally, Cancel, hard timeout) runs resetInFlight, which clears
    // them and drops the chunk subscription, so nothing refills them between
    // requests. A test pins "early buffer empty after a request ends" (S12).

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
        if (generationGenRef.current !== gen) return;
        mainRequestIdRef.current = requestId;
        // Stream-start and chunk travel on different IPC channels, so a
        // chunk can land first. Keep this requestId's early tokens; drop the rest.
        if (earlyLaneLost(earlyLanesRef.current, requestId)) mineLatchedRef.current = true;
        const lane = takeEarlyLane(earlyLanesRef.current, requestId);
        let flushed = false;
        for (const c of lane?.chunks ?? []) {
          if (c) streamAccumRef.current += c;
          flushed = true;
        }
        if (flushed) {
          setStalled(false);
          scheduleStallTimers(gen);
        }
      });
    }

    // Critic hard 3: re-arm stall/hard timers on every streamed chunk.
    const onChunk =
      agent === 'brainstorm'
        ? window.api?.onBrainstormChunk
        : window.api?.onWritingAssistantChunk;
    if (typeof onChunk === 'function') {
      chunkUnsubRef.current = onChunk((chunk: string, requestId?: string) => {
        if (generationGenRef.current !== gen) return;
        // Only buffer chunks that name THIS request. A late or overlapping
        // stream on the shared channel must not land in this chat's vault.
        if (!requestId) return;
        const mine = mainRequestIdRef.current;
        if (!mine) {
          tryPushEarlyChunk(earlyLanesRef.current, requestId, chunk);
          return;
        }
        if (requestId !== mine) return;
        if (chunk && !mineLatchedRef.current) streamAccumRef.current += chunk;
        setStalled(false);
        scheduleStallTimers(gen);
      });
    }

    scheduleStallTimers(gen);

    // Pin this exchange to whichever session is active RIGHT NOW (SKY-7076):
    // if the user switches sessions before the reply lands, the turns still
    // belong to the session they were asked from.
    const originSessionId = store.activeSessionId ?? undefined;
    const liveTurns = store.activeSession?.turns ?? [];
    // Retry of the failed exchange from THIS session whose user turn is
    // already saved (checked against the feed tail, not just a flag): don't
    // append it again, don't render a second optimistic bubble, and drop it
    // from the model history (it is re-sent as `prompt`).
    const failedExchange = lastFailedExchangeRef.current;
    const isRetryOfFailed = failedExchange !== null
      && failedExchange.prompt === trimmed
      && canonicalSessionId(failedExchange.originSessionId) === canonicalSessionId(originSessionId);
    const userAlreadyInFeed = isRetryOfFailed
      && feedEndsWithUserPrompt(liveTurns, trimmed);
    inFlightRef.current = { prompt: trimmed, originSessionId, userPersisted: userAlreadyInFeed };
    setPendingPrompt(trimmed);
    setPendingPromptInFeed(userAlreadyInFeed);
    // Critic N2: never send raw card JSON / markers as model history.
    const historySource = turnsForModelHistory(liveTurns, isRetryOfFailed ? trimmed : null);
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
      await store.appendTurns(
        userAlreadyInFeed
          ? [agentTurn]
          : [
            { role: 'user', text: trimmed, at: now },
            agentTurn,
          ],
        originSessionId,
      );
      lastFailedExchangeRef.current = null;
      streamAccumRef.current = '';
    } catch (err) {
      if (generationGenRef.current !== gen) return;
      const msg = err instanceof Error ? err.message : String(err);
      const now = new Date().toISOString();
      const partialRaw = streamAccumRef.current.trim();
      const partialSafe = partialRaw
        ? neutralizeLeadingCoachCardMarker(partialRaw)
        : '';
      const failedTurns: AgentSessionTurn[] = userAlreadyInFeed
        ? []
        : [{ role: 'user', text: trimmed, at: now }];
      if (partialSafe) {
        failedTurns.push({
          role: 'agent',
          text: `${partialSafe} ${RESPONSE_INCOMPLETE_SUFFIX}`,
          at: new Date().toISOString(),
          incomplete: true,
        });
      }
      // Vault rollback note: nothing is rolled back on failure. The user turn
      // and the kept partial (flagged `incomplete`) stay in the feed; only
      // model history drops the partial (turnsForModelHistory).
      // Mark the user turn saved only once the write actually resolved — a
      // rejected save leaves it unsaved so Retry/resend appends it again.
      let userPersisted = userAlreadyInFeed;
      if (failedTurns.length > 0) {
        try {
          await store.appendTurns(failedTurns, originSessionId);
          userPersisted = true;
          // Cancel / timeout may have already armed Retry from inFlightRef
          // (userPersisted: false) while this write was in flight. Update
          // the shared object so the next Retry does not append again.
          const already = lastFailedExchangeRef.current;
          if (
            already
            && already.prompt === trimmed
            && (
              already.originSessionId === undefined
              || canonicalSessionId(already.originSessionId) === canonicalSessionId(originSessionId)
            )
          ) {
            already.userPersisted = true;
          }
        } catch {
          /* vault write failed — keep userPersisted as it was */
        }
      }
      streamAccumRef.current = '';
      // Cancel / timeout while the failed turn was being saved already armed
      // Retry and set their own message; do not overwrite them.
      if (generationGenRef.current !== gen) return;
      if (recordFailedExchange({ prompt: trimmed, originSessionId, userPersisted })) {
        const base = msg || 'Agent unavailable — check your provider settings.';
        setError(partialSafe ? `${base} (partial reply kept above)` : base);
      }
    } finally {
      if (generationGenRef.current === gen) {
        resetInFlight();
      } else {
        clearStreamStartSub();
        clearChunkSub();
        clearTimers();
      }
    }
  }, [pendingPrompt, store, invoke, agent, scheduleStallTimers, resetInFlight, clearStreamStartSub, clearChunkSub, clearTimers, canonicalSessionId, recordFailedExchange]);

  // Declared after send, which it calls.
  const retryLastBound = useCallback(() => {
    const failed = lastFailedExchangeRef.current;
    if (!failed?.prompt || pendingPrompt !== null) return;
    if (!belongsToActiveSession(failed)) {  // never resend another chat's prompt here
      lastFailedExchangeRef.current = null;
      setCanRetry(false);
      return;
    }
    void send(failed.prompt);
  }, [pendingPrompt, send, belongsToActiveSession]);

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
    pendingPromptInFeed,
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
