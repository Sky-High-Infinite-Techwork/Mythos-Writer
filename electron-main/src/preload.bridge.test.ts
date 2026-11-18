// Test gap 07 — preload bridge channels, argument passthrough, and listener teardown.
//
// Loads preload.ts with mocked electron, captures window.api / window.mythosIPC, and
// asserts every frozen exposeInMainWorld entry from ipcSurface.contract.freeze.json.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import freeze from './ipcSurface.contract.freeze.json';
import { IPC_CHANNELS } from './ipc.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

type ExposedRow = { world: string; path: string; channel: string };

const IPC_CHANNEL_VALUES = new Set(Object.values(IPC_CHANNELS) as string[]);

function parseExposedLine(line: string): ExposedRow {
  const parts = line.split(' ');
  const world = parts[0]!;
  const channel = parts[parts.length - 1]!;
  const pathKey = parts.slice(1, -1).join(' ');
  return { world, path: pathKey, channel };
}

const FROZEN_EXPOSED = (freeze.exposed as string[]).map(parseExposedLine);
const FROZEN_IPC = FROZEN_EXPOSED.filter((row) => row.channel !== 'NON_IPC');

function isListenerPath(pathKey: string): boolean {
  const base = pathKey.split('.').pop() ?? pathKey;
  if (base === 'onEvent') return true;
  return /^on[A-Z]/.test(base);
}

const FROZEN_LISTENERS = FROZEN_IPC.filter((row) => isListenerPath(row.path));
const FROZEN_CALLS = FROZEN_IPC.filter((row) => !isListenerPath(row.path));

// ─── Mock electron (capture bridge + record IPC) ─────────────────────────────

const harness = vi.hoisted(() => {
  const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: true,
    data: null,
  }));
  const sendMock = vi.fn<(...args: unknown[]) => void>(() => undefined);
  const onMock = vi.fn<(...args: unknown[]) => void>(() => undefined);
  const removeListenerMock = vi.fn<(...args: unknown[]) => void>(() => undefined);
  const capturedWorlds: Record<string, unknown> = {};
  return { invokeMock, sendMock, onMock, removeListenerMock, capturedWorlds };
});

const { invokeMock, sendMock, onMock, removeListenerMock, capturedWorlds } = harness;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => {
      harness.capturedWorlds[name] = value;
    },
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => harness.invokeMock(...args),
    send: (...args: unknown[]) => harness.sendMock(...args),
    on: (...args: unknown[]) => harness.onMock(...args),
    removeListener: (...args: unknown[]) => harness.removeListenerMock(...args),
  },
  webUtils: {
    getPathForFile: (file: File) => `/mock/${file.name}`,
  },
}));

import './preload.js';
import { ipcRenderer } from 'electron';

function getAtPath(root: unknown, dotPath: string): unknown {
  let cur: unknown = root;
  for (const seg of dotPath.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function walkFunctionPaths(root: unknown, prefix = ''): string[] {
  if (!root || typeof root !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'function') {
      out.push(pathKey);
    } else if (value && typeof value === 'object') {
      out.push(...walkFunctionPaths(value, pathKey));
    }
  }
  return out.sort();
}

function allRuntimeFunctionPaths(): string[] {
  const paths: string[] = [];
  for (const [world, api] of Object.entries(capturedWorlds)) {
    for (const p of walkFunctionPaths(api)) {
      paths.push(`${world}.${p}`);
    }
  }
  return paths.sort();
}

const SAMPLE = {
  str: 'bridge-sample',
  str2: 'bridge-sample-2',
  path: '/tmp/bridge-sample',
  path2: '/tmp/bridge-sample-notes',
  id: 'bridge-id',
  /** Distinct positional ids — order-sensitive forwarding must not reuse the same value. */
  idA: 'bridge-id-a',
  idB: 'bridge-id-b',
  idC: 'bridge-id-c',
  idD: 'bridge-id-d',
  idE: 'bridge-id-e',
  idF: 'bridge-id-f',
  num: 7,
  bool: true,
  obj: { bridge: true },
  arr: ['bridge'],
  buf: new ArrayBuffer(4),
  u8: new Uint8Array([1, 2, 3]),
  file: new File(['bridge'], 'sample.txt'),
  token: 'bridge-token',
} as const;

/** Per-path call shape: argument list and exact invoke/send payload (2nd argument). */
type BridgeCallSpec = {
  args: unknown[];
  payload?: unknown;
  op?: 'invoke' | 'send';
  /** ipcRenderer.invoke was called with the channel string only (no payload argument). */
  singleArgInvoke?: boolean;
};

type BridgeArgOverride = Pick<BridgeCallSpec, 'args' | 'op' | 'payload' | 'singleArgInvoke'>;

/** Argument / op overrides where default arity sampling is not enough. */
const BRIDGE_ARG_OVERRIDES: Record<string, BridgeArgOverride> = {
  'api.agentBrainstorm': {
    args: [SAMPLE.str, [{ role: 'user' as const, content: 'hi' }]],
  },
  'api.agentArchive': {
    args: [SAMPLE.str, [{ role: 'user' as const, content: 'hi' }]],
  },
  'api.vaultSetPaths': {
    args: [SAMPLE.path, SAMPLE.path2, { seedMode: 'default' as const, storyVaultToken: SAMPLE.token }],
  },
  'api.importHub.previewDropped': { args: [SAMPLE.file] },
  'api.importHub.commit': { args: [SAMPLE.token, { story: true }] },
  'api.importDocxToStoryVault': { args: [[SAMPLE.path]] },
  'api.streamAck': { args: [SAMPLE.id, SAMPLE.num], op: 'send' },
  'api.sttStart': { args: [], op: 'send', singleArgInvoke: true },
  'api.sttStop': { args: [], op: 'send', singleArgInvoke: true },
  'api.notifyFlushBeforeQuitDone': { args: [], op: 'send', singleArgInvoke: true },
  'api.voiceAudioChunk': {
    args: [SAMPLE.id, SAMPLE.buf],
    op: 'send',
    payload: { sessionId: SAMPLE.id, chunk: SAMPLE.buf },
  },
  'api.voiceLocalTranscript': { args: [SAMPLE.id, SAMPLE.str, true], op: 'send' },
  'api.voiceSpeakCancel': { args: [SAMPLE.id], op: 'send' },
  'api.cancelWritingAssistant': { args: [SAMPLE.id], op: 'send' },
  'api.cancelBrainstorm': { args: [SAMPLE.id], op: 'send' },
  'api.cancelVaultCheck': { args: [SAMPLE.id], op: 'send' },
  'api.cancelAiActivity': { args: [SAMPLE.id], op: 'send' },
  'api.getRefinementSuggestions': {
    args: [{
      original_text: 'orig',
      refinement_action: 'shorten',
      active_preset_id: 'preset-1',
      additional_instruction: 'more',
    }],
  },
  'api.exportDocx': { args: [SAMPLE.id, undefined, { includeSynopsis: true }] },
  'api.installUpdate': { args: [false] },
  'api.vaultGraphNodes': { args: ['notes' as const] },
  'api.vaultGraphEdges': { args: ['both' as const] },
  'api.notesThumbPut': {
    args: [SAMPLE.path, 'v1', SAMPLE.u8],
    payload: { src: SAMPLE.path, version: 'v1', bytes: SAMPLE.u8 },
  },
  'api.voicePickBinary': {
    args: ['stt-binary' as const],
    payload: { kind: 'stt-binary' },
  },
  'api.goalsLogWords': { args: ['2026-01-01', 100] },
  'api.goalsSetGoal': { args: [500] },
  'api.agentSessions.appendTurns': {
    args: [SAMPLE.id, [{ role: 'user' as const, text: 'x', at: 't' }]],
  },
  'api.agentSessions.create': {
    args: [SAMPLE.str, SAMPLE.str2, 'hi', SAMPLE.id],
  },
  'api.notesBoardTrashItems': { args: [SAMPLE.path, []] },
  'api.tagsBulkApply': {
    args: [[SAMPLE.id], 'scene' as const, [SAMPLE.str], [SAMPLE.str2]],
  },
  'api.obsidianPickFolderByPath': { args: [SAMPLE.path] },
  'api.storyImportPickFile': { args: ['docx' as const] },
  'api.panelFloat': {
    args: [SAMPLE.id, { sourceSidebar: 'left' as const, x: 1, y: 2, width: 100, height: 200 }],
  },
  'api.settingsSet': {
    args: [SAMPLE.obj, { sttBinaryToken: SAMPLE.token }],
  },
  'api.smartFolderUpdate': {
    args: [SAMPLE.id, { name: SAMPLE.str, query: SAMPLE.str2 }],
  },
  'api.suggestionsList': {
    args: [SAMPLE.str, SAMPLE.str2, { limit: 10, offset: 0 }],
  },
  'api.notesThumbResolve': { args: [[SAMPLE.path, SAMPLE.str2]] },
};

const SINGLE_ARG_SEND = new Set(['api.sttStart', 'api.sttStop', 'api.notifyFlushBeforeQuitDone']);

const FIXTURES_DIR = path.join(SRC_DIR, '..', 'fixtures');

type BridgeRecordedFixture = { recorded: Record<string, unknown>; singles: string[] };
const bridgeRecorded = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, 'preload.bridge.recorded.json'), 'utf8'),
) as BridgeRecordedFixture;
const BRIDGE_RECORDED_PAYLOADS = bridgeRecorded.recorded;
const SINGLE_ARG_INVOKE = new Set<string>(bridgeRecorded.singles);

type ListenerKind =
  | 'noArg'
  | 'passthrough'
  | 'chunk'
  | 'requestId'
  | 'text'
  | 'panelId'
  | 'storySlug'
  | 'entries'
  | 'info';

type ListenerFixtureRow = {
  kind: ListenerKind;
  ipcPayload?: unknown;
};

const LISTENER_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, 'preload.bridge.listeners.json'), 'utf8'),
) as Record<string, ListenerFixtureRow>;

/** Minimal shared payload for generic `cb(data)` listeners without channel overrides. */
const LISTENER_SHARED_PASSTHROUGH = SAMPLE.obj;

const LISTENER_PASSTHROUGH_BY_CHANNEL: Record<string, unknown> = {
  'jobs:event': { jobId: SAMPLE.id, event: 'progress' },
  'navigator:scene-changed': { sceneId: SAMPLE.id },
  'navigator:scene-synced': { sceneId: SAMPLE.id },
  'project:switched': { vaultRoot: SAMPLE.path, notesVaultRoot: SAMPLE.path2 },
  'vault:notes-asset-changed': { path: SAMPLE.path },
  'vault:notes-updated': { count: 1, path: SAMPLE.path },
  'vault:file-changed': { path: SAMPLE.path },
  'vault:obsidian:import:progress': { current: 1, total: 2, lastAction: 'lc' },
  'stream:reasoning': { streamId: SAMPLE.id },
  'stream:token': { streamId: SAMPLE.id, token: 'lc-token' },
  'stream:end': { streamId: SAMPLE.id },
  'stream:error': { streamId: SAMPLE.id, category: 'lc-cat', message: 'lc-msg' },
  'brainstorm:proposalQueued': { proposals: [{ id: 'p' }] },
  'panel:float-closed': {
    panelId: SAMPLE.id,
    docked: true,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
  },
  'panel:float-bounds': { panelId: SAMPLE.id, x: 0, y: 0, width: 1, height: 1 },
  'panel:float-pin-changed': { panelId: SAMPLE.id, alwaysOnTop: false },
  'panel:popout-closed': { panelId: SAMPLE.id },
  'scene-crafter:external-edit': { storySlug: 'lc-slug' },
};

const FAKE_IPC_RENDERER_EVENT = Object.freeze({
  sender: { id: 4242, send: () => undefined },
  preventDefault: () => undefined,
});

const INVOKE_ENVELOPE_CALL_KEYS = new Set([
  'api.settingsGet',
  'api.settingsSet',
  'api.settingsTestConnection',
  'api.betaReadScan',
  'api.betaReportRun',
  'api.productionRoleRun',
]);

const ORDERED_IDS = [SAMPLE.idA, SAMPLE.idB, SAMPLE.idC, SAMPLE.idD, SAMPLE.idE, SAMPLE.idF] as const;

function defaultArgsFor(row: ExposedRow, fn: (...args: unknown[]) => unknown): unknown[] {
  const key = callKey(row);
  if (BRIDGE_ARG_OVERRIDES[key]?.args) return BRIDGE_ARG_OVERRIDES[key].args;
  const n = fn.length;
  if (n === 0) return [];
  if (row.channel.includes('voice:pickBinary')) return ['stt-binary'];
  if (n === 1) {
    const golden = BRIDGE_RECORDED_PAYLOADS[key];
    if (typeof golden === 'object' && golden !== null && !Array.isArray(golden)) return [SAMPLE.obj];
    if (golden === SAMPLE.path || (typeof golden === 'string' && golden.startsWith('/'))) return [SAMPLE.path];
    return [SAMPLE.str];
  }
  const pathFirst =
    row.path.includes('Vault') ||
    row.path.includes('Path') ||
    row.path.endsWith('Folder') ||
    row.channel.startsWith('vault:') ||
    row.channel.startsWith('notesVault:') ||
    row.channel.startsWith('notesThumb:');
  return Array.from({ length: n }, (_, i) => {
    if (pathFirst && i === 0) return SAMPLE.path;
    if (pathFirst && i === 1) return SAMPLE.path2;
    return ORDERED_IDS[i] ?? SAMPLE.str;
  });
}

function callKey(row: ExposedRow): string {
  return `${row.world}.${row.path}`;
}

function firstIpcMockCall(mock: { mock: { calls: readonly unknown[][] } }): unknown[] {
  const call = mock.mock.calls[0];
  expect(call).toBeDefined();
  return call as unknown[];
}

function resolveCallSpec(row: ExposedRow, fn: (...args: unknown[]) => unknown): BridgeCallSpec {
  const key = callKey(row);
  const override = BRIDGE_ARG_OVERRIDES[key];
  const args = override?.args ?? defaultArgsFor(row, fn);
  const op =
    override?.op ??
    (row.channel === 'stt:start' ||
    row.channel === 'stt:stop' ||
    row.channel === 'app:flushBeforeQuitDone'
      ? 'send'
      : 'invoke');
  const singleArgInvoke =
    override?.singleArgInvoke ?? (op === 'send' ? SINGLE_ARG_SEND.has(key) : SINGLE_ARG_INVOKE.has(key));
  const payload = override?.payload ?? (singleArgInvoke ? undefined : BRIDGE_RECORDED_PAYLOADS[key]);
  return { args, payload, op, singleArgInvoke };
}

function assertNoRawIpcSurface(value: unknown, pathKey: string, ipcRendererRef: unknown): void {
  if (value === ipcRendererRef) {
    throw new Error(`Exposed ipcRenderer at ${pathKey}`);
  }
  if (typeof value === 'function') {
    const src = Function.prototype.toString.call(value);
    if (/ipcRenderer\.(invoke|send|on)\(\s*[a-zA-Z_$]/.test(src)) {
      throw new Error(`Exposed bridge forwards a dynamic channel at ${pathKey}`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertNoRawIpcSurface(v, `${pathKey}.${k}`, ipcRendererRef);
  }
}

function detectListenerKind(bridgeFn: (...args: unknown[]) => unknown): ListenerKind {
  const src = Function.prototype.toString.call(bridgeFn);
  if (/const handler = \(\) => cb\(\)/.test(src)) return 'noArg';
  if (src.includes('cb(data.chunk)')) return 'chunk';
  if (src.includes('cb(data.requestId)')) return 'requestId';
  if (src.includes('cb(data.text)')) return 'text';
  if (src.includes('cb(data.panelId)')) return 'panelId';
  if (src.includes('cb(data.storySlug)')) return 'storySlug';
  if (src.includes('cb(entries)')) return 'entries';
  if (src.includes('cb(info)')) return 'info';
  return 'passthrough';
}

function defaultIpcPayloadForListener(row: ExposedRow, kind: ListenerKind): unknown | undefined {
  if (kind === 'noArg') return undefined;
  if (kind === 'chunk') return { chunk: 'lc-chunk' };
  if (kind === 'requestId') return { requestId: SAMPLE.id, category: 'lc-cat', message: 'lc-msg' };
  if (kind === 'text') return { text: 'lc-text' };
  if (kind === 'panelId') return { panelId: SAMPLE.id };
  if (kind === 'storySlug') return { storySlug: 'lc-slug' };
  if (kind === 'entries') return [SAMPLE.obj];
  if (kind === 'info') return { reason: 'lc', itemPath: SAMPLE.path };
  return LISTENER_PASSTHROUGH_BY_CHANNEL[row.channel] ?? LISTENER_SHARED_PASSTHROUGH;
}

function userCbArgsFromListenerRow(row: ListenerFixtureRow): unknown[] {
  const { kind, ipcPayload } = row;
  if (kind === 'noArg') return [];
  if (kind === 'chunk') return [(ipcPayload as { chunk: string }).chunk];
  if (kind === 'requestId') return [(ipcPayload as { requestId: string }).requestId];
  if (kind === 'text') return [(ipcPayload as { text: string }).text];
  if (kind === 'panelId') return [(ipcPayload as { panelId: string }).panelId];
  if (kind === 'storySlug') return [(ipcPayload as { storySlug: string }).storySlug];
  if (kind === 'entries') return [ipcPayload];
  if (kind === 'info') return [ipcPayload];
  return [ipcPayload];
}

function ipcInvokeArgsForListenerRow(row: ListenerFixtureRow): unknown[] {
  if (row.kind === 'noArg') return [FAKE_IPC_RENDERER_EVENT];
  return [FAKE_IPC_RENDERER_EVENT, row.ipcPayload];
}

function recordListenerFixtureRow(row: ExposedRow): ListenerFixtureRow {
  const bridgeFn = getAtPath(capturedWorlds[row.world], row.path) as (
    cb: (arg?: unknown) => void,
  ) => () => void;
  const kind = detectListenerKind(bridgeFn as (...args: unknown[]) => unknown);
  const ipcPayload = defaultIpcPayloadForListener(row, kind);
  const probeCb = vi.fn<(arg?: unknown) => void>();
  onMock.mockClear();
  bridgeFn(probeCb);
  const handler = onMock.mock.calls[0]![1] as (...args: unknown[]) => void;
  handler(...ipcInvokeArgsForListenerRow({ kind, ipcPayload }));
  const fixture: ListenerFixtureRow = ipcPayload === undefined ? { kind } : { kind, ipcPayload };
  expect(probeCb).toHaveBeenCalledWith(...userCbArgsFromListenerRow(fixture));
  return fixture;
}

function assertListenerForwardsFromTable(
  key: string,
  ipcHandler: (...args: unknown[]) => void,
  userCb: ReturnType<typeof vi.fn>,
): void {
  const spec = LISTENER_FIXTURE[key];
  expect(spec, `missing listener fixture for ${key}`).toBeDefined();
  userCb.mockClear();
  ipcHandler(...ipcInvokeArgsForListenerRow(spec!));
  expect(userCb).toHaveBeenCalledTimes(1);
  expect(userCb).toHaveBeenCalledWith(...userCbArgsFromListenerRow(spec!));
  for (const call of userCb.mock.calls) {
    expect(call[0]).not.toBe(FAKE_IPC_RENDERER_EVENT);
  }
}

describe('preload bridge', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    sendMock.mockClear();
    onMock.mockClear();
    removeListenerMock.mockClear();
  });

  it('covers every frozen listener with a fixture table row', () => {
    const missing = FROZEN_LISTENERS.map(callKey).filter((key) => !LISTENER_FIXTURE[key]);
    expect(missing).toEqual([]);
  });

  it.each(FROZEN_LISTENERS.map((row) => [callKey(row), row] as const))(
    '%s fixture kind matches preload listener wiring (red-on-revert)',
    (_key, row) => {
      const fn = getAtPath(capturedWorlds[row.world], row.path);
      expect(typeof fn).toBe('function');
      const runtimeKind = detectListenerKind(fn as (...args: unknown[]) => unknown);
      expect(LISTENER_FIXTURE[callKey(row)]?.kind).toBe(runtimeKind);
    },
  );

  it('covers every frozen exposeInMainWorld function (new key without a case fails)', () => {
    const runtime = allRuntimeFunctionPaths();
    const frozen = FROZEN_IPC.map(callKey).sort();
    expect(runtime).toEqual(frozen);
  });

  it('invoke/send channels are IPC_CHANNELS or frozen literal exceptions', () => {
    const literalNotInIpcTable = new Set([
      'stt:start',
      'stt:stop',
      'stream:ack',
      'stream:start',
      'stream:cancel',
      'voice:audio-chunk',
      'voice:local-transcript',
      'voice:speak:cancel',
      'agent:writing-assistant:stream-cancel',
      'agent:brainstorm:stream-cancel',
      'agent:vault-check:stream-cancel',
      'ai-activity:cancel',
      'ai-activity:get-snapshot',
      'preset:getAll',
      'preset:getRubric',
      'writing-assistant:set-active-scene',
    ]);
    const missing = FROZEN_CALLS.filter(
      (row) =>
        !literalNotInIpcTable.has(row.channel) &&
        !IPC_CHANNEL_VALUES.has(row.channel),
    ).map((row) => `${row.channel} (${callKey(row)})`);
    expect(missing).toEqual([]);
  });

  it('does not expose ipcRenderer or dynamic-channel bridges', () => {
    for (const [world, api] of Object.entries(capturedWorlds)) {
      assertNoRawIpcSurface(api, world, ipcRenderer);
    }
  });

  it.each(FROZEN_CALLS.map((row) => [callKey(row), row] as const))(
    '%s forwards the exact IPC channel and payload',
    async (_key, row) => {
      const api = capturedWorlds[row.world];
      const fn = getAtPath(api, row.path);
      expect(typeof fn).toBe('function');
      const spec = resolveCallSpec(row, fn as (...a: unknown[]) => unknown);
      const result = (fn as (...a: unknown[]) => unknown)(...spec.args);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        await result;
      }

      const op = spec.op ?? 'invoke';
      if (op === 'send') {
        expect(sendMock).toHaveBeenCalledTimes(1);
        if (spec.singleArgInvoke) {
          expect(sendMock).toHaveBeenCalledWith(row.channel);
        } else {
          expect(sendMock).toHaveBeenCalledWith(row.channel, spec.payload);
        }
        expect(invokeMock).not.toHaveBeenCalled();
        return;
      }

      expect(invokeMock).toHaveBeenCalledTimes(1);
      if (spec.singleArgInvoke) {
        expect(invokeMock).toHaveBeenCalledWith(row.channel);
      } else {
        expect(invokeMock).toHaveBeenCalledWith(row.channel, spec.payload);
      }
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it.each(FROZEN_LISTENERS.map((row) => [callKey(row), row] as const))(
    '%s subscribe returns an unsubscribe that removes the same listener',
    (_key, row) => {
      const api = capturedWorlds[row.world];
      const fn = getAtPath(api, row.path);
      expect(typeof fn).toBe('function');

      const cb = vi.fn<(arg?: unknown) => void>();
      const unsub = (fn as (listener: (arg?: unknown) => void) => () => void)(cb);
      expect(typeof unsub).toBe('function');
      expect(onMock).toHaveBeenCalledTimes(1);
      const onCall = firstIpcMockCall(onMock);
      expect(onCall[0]).toBe(row.channel);
      const handler = onCall[1] as (...args: unknown[]) => void;
      expect(typeof handler).toBe('function');

      assertListenerForwardsFromTable(callKey(row), handler, cb);

      unsub();
      expect(removeListenerMock).toHaveBeenCalledTimes(1);
      expect(removeListenerMock).toHaveBeenCalledWith(row.channel, handler);
    },
  );

  it.each(
    FROZEN_CALLS.filter((row) => INVOKE_ENVELOPE_CALL_KEYS.has(callKey(row))).map(
      (row) => [callKey(row), row] as const,
    ),
  )('%s unwraps invoke IPC envelopes (data and error)', async (_key, row) => {
    const api = capturedWorlds[row.world];
    const fn = getAtPath(api, row.path);
    expect(typeof fn).toBe('function');
    const spec = resolveCallSpec(row, fn as (...a: unknown[]) => unknown);

    invokeMock.mockResolvedValueOnce({ ok: true, data: { probe: 'envelope-ok' } });
    const ok = await (fn as (...a: unknown[]) => Promise<unknown>)(...spec.args);
    expect(ok).toEqual({ probe: 'envelope-ok' });

    invokeMock.mockResolvedValueOnce({ ok: false, code: 'ERR', message: 'envelope-fail' });
    const err = await (fn as (...a: unknown[]) => Promise<unknown>)(...spec.args);
    expect(err).toEqual({ error: 'envelope-fail' });
  });

  it('isPackaged is a boolean constant, not IPC', () => {
    expect((capturedWorlds.api as { isPackaged: boolean }).isPackaged).toBe(false);
  });

  it('vaultSetPaths golden encodes distinct story vs notes paths (red-on-revert)', () => {
    const golden = BRIDGE_RECORDED_PAYLOADS['api.vaultSetPaths'] as {
      storyVaultPath: string;
      notesVaultPath: string;
    };
    expect(golden.storyVaultPath).toBe(SAMPLE.path);
    expect(golden.notesVaultPath).toBe(SAMPLE.path2);
    expect(golden.storyVaultPath).not.toBe(golden.notesVaultPath);
  });

  it('no-arg listener table rejects raw ipcRenderer.on(channel, cb) wiring (red-on-revert)', () => {
    const key = 'api.onFlushBeforeQuit';
    const cb = vi.fn<(arg?: unknown) => void>();
    const rawUserCbOnChannel = cb as unknown as (...args: unknown[]) => void;
    expect(() => assertListenerForwardsFromTable(key, rawUserCbOnChannel, cb)).toThrow();
  });
});

describe.skipIf(!process.env.PRELOAD_BRIDGE_RECORD)('preload bridge recorder', () => {
  it('refresh listener fixture table', () => {
    const table: Record<string, ListenerFixtureRow> = {};
    for (const row of FROZEN_LISTENERS) {
      table[callKey(row)] = recordListenerFixtureRow(row);
    }
    const outPath = path.join(FIXTURES_DIR, 'preload.bridge.listeners.json');
    const body = JSON.stringify(table, null, 2);
    fs.writeFileSync(outPath, body);
    expect(fs.readFileSync(outPath, 'utf8')).toBe(body);
    expect(Object.keys(table).length).toBe(FROZEN_LISTENERS.length);
  });

  it('refresh BRIDGE_RECORDED_PAYLOADS', async () => {
    const recorded: Record<string, unknown> = {};
    const singles: string[] = [];
    for (const row of FROZEN_CALLS) {
      invokeMock.mockClear();
      sendMock.mockClear();
      const api = capturedWorlds[row.world];
      const fn = getAtPath(api, row.path) as (...a: unknown[]) => unknown;
      const spec = resolveCallSpec(row, fn);
      const result = fn(...spec.args);
      if (result && typeof (result as Promise<unknown>).then === 'function') await result;
      const key = callKey(row);
      if (sendMock.mock.calls.length) {
        recorded[key] = firstIpcMockCall(sendMock)[1];
      } else {
        const invokeCall = firstIpcMockCall(invokeMock);
        if (invokeCall.length === 1) {
          singles.push(key);
        } else {
          recorded[key] = invokeCall[1];
        }
      }
    }
    const outPath = path.join(FIXTURES_DIR, 'preload.bridge.recorded.json');
    const body = JSON.stringify({ recorded, singles }, null, 2);
    fs.writeFileSync(outPath, body);
    expect(fs.readFileSync(outPath, 'utf8')).toBe(body);
    expect(Object.keys(recorded).length).toBeGreaterThan(0);
  });
});

let mutatedPreloadDirForCleanup: string | undefined;

function writeMutatedPreloadToTemp(channelNeedle: string, channelReplacement: string): string {
  const original = fs.readFileSync(path.join(SRC_DIR, 'preload.ts'), 'utf8');
  const mutated = original
    .split(channelNeedle)
    .join(channelReplacement)
    .replace(/from '\.\/([^']+)'/g, (_match, rel: string) => {
      const abs = path.join(SRC_DIR, rel).split(path.sep).join('/');
      return `from '${abs}'`;
    });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-bridge-mut-'));
  const outPath = path.join(dir, 'preload.mutated.ts');
  fs.writeFileSync(outPath, mutated, { flag: 'wx' });
  mutatedPreloadDirForCleanup = dir;
  return outPath;
}

async function assertReadVaultChannelContractUnderPreload(moduleHref: string): Promise<void> {
  vi.resetModules();
  for (const key of Object.keys(harness.capturedWorlds)) {
    delete harness.capturedWorlds[key];
  }
  vi.doMock('electron', () => ({
    contextBridge: {
      exposeInMainWorld: (name: string, value: unknown) => {
        harness.capturedWorlds[name] = value;
      },
    },
    ipcRenderer: {
      invoke: (...args: unknown[]) => harness.invokeMock(...args),
      send: (...args: unknown[]) => harness.sendMock(...args),
      on: (...args: unknown[]) => harness.onMock(...args),
      removeListener: (...args: unknown[]) => harness.removeListenerMock(...args),
    },
    webUtils: {
      getPathForFile: (file: File) => `/mock/${file.name}`,
    },
  }));
  await import(`${moduleHref}?mut=${Date.now()}`);
  invokeMock.mockClear();
  invokeMock.mockResolvedValue({ ok: true, data: null });
  const api = harness.capturedWorlds.api as { readVault: (pathArg: string) => Promise<unknown> };
  await api.readVault(SAMPLE.path);
  expect(invokeMock).toHaveBeenCalledWith('vault:read', { path: SAMPLE.path });
}

describe('preload bridge mutation sentinel', () => {
  afterAll(() => {
    if (mutatedPreloadDirForCleanup) {
      fs.rmSync(mutatedPreloadDirForCleanup, { recursive: true, force: true });
    }
  });

  it('loads mutated preload and fails the vault:read channel contract', async () => {
    const mutatedHref = pathToFileURL(
      writeMutatedPreloadToTemp("'vault:read'", "'vault:read-MUTATION-1910'"),
    ).href;
    await expect(assertReadVaultChannelContractUnderPreload(mutatedHref)).rejects.toThrow(
      /vault:read-MUTATION-1910/,
    );
  });
});
