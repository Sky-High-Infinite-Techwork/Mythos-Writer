// Test gap 07 — preload bridge channels, argument passthrough, and listener teardown.
//
// Loads preload.ts with mocked electron, captures window.api / window.mythosIPC, and
// asserts every frozen exposeInMainWorld entry from ipcSurface.contract.freeze.json.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const invokeMock = vi.fn<(...args: unknown[]) => Promise<{ ok: true; data: null }>>(
    async () => ({ ok: true, data: null }),
  );
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
    args: [SAMPLE.path, SAMPLE.path, { seedMode: 'default' as const, storyVaultToken: SAMPLE.token }],
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
};

const SINGLE_ARG_SEND = new Set(['api.sttStart', 'api.sttStop', 'api.notifyFlushBeforeQuitDone']);

const BRIDGE_RECORDED_PAYLOADS: Record<string, unknown> = {
  "api.agentArchive": {
    "prompt": "bridge-sample",
    "history": [
      {
        "role": "user",
        "content": "hi"
      }
    ]
  },
  "api.agentBrainstorm": {
    "prompt": "bridge-sample",
    "history": [
      {
        "role": "user",
        "content": "hi"
      }
    ]
  },
  "api.agentPersonaRead": {
    "agentName": "bridge-id-a",
    "key": "bridge-id-b"
  },
  "api.agentPersonaReset": {
    "agentName": "bridge-id-a",
    "key": "bridge-id-b"
  },
  "api.agentPersonaWrite": {
    "agentName": "bridge-id-a",
    "key": "bridge-id-b",
    "content": "bridge-id-c"
  },
  "api.agentSessions.appendTurns": {
    "sessionId": "bridge-id",
    "turns": [
      {
        "role": "user",
        "text": "x",
        "at": "t"
      }
    ]
  },
  "api.agentSessions.create": {
    "agent": "bridge-sample",
    "title": "bridge-sample-2",
    "greeting": "hi",
    "id": "bridge-id"
  },
  "api.agentSessions.delete": {
    "sessionId": {
      "bridge": true
    }
  },
  "api.agentSessions.duplicate": {
    "sessionId": {
      "bridge": true
    }
  },
  "api.agentSessions.list": {
    "agent": {
      "bridge": true
    }
  },
  "api.agentSessions.read": {
    "sessionId": {
      "bridge": true
    }
  },
  "api.agentSessions.rename": {
    "sessionId": "bridge-id-a",
    "title": "bridge-id-b"
  },
  "api.agentVaultCheck": {
    "sceneContent": {
      "bridge": true
    }
  },
  "api.agentVaultIndex": {},
  "api.agentWritingAssistant": {
    "prompt": "bridge-id-a",
    "context": "bridge-id-b"
  },
  "api.agentsVaultSyncPartner": "/tmp/bridge-sample",
  "api.archive": {
    "manuscript": "bridge-id-a",
    "vaultPath": "bridge-id-b"
  },
  "api.archiveConfirm": {
    "suggestionId": "bridge-id-a",
    "action": "bridge-id-b"
  },
  "api.archiveListContinuity": "bridge-sample",
  "api.archiveResolveContinuity": {
    "itemId": "bridge-id-a",
    "action": "bridge-id-b",
    "note": "bridge-id-c"
  },
  "api.archiveScan": {
    "sceneText": "bridge-id-a",
    "scenePath": "bridge-id-b"
  },
  "api.archiveScanContinuity": {
    "sceneId": "bridge-id-a",
    "text": "bridge-id-b",
    "scope": "bridge-id-c",
    "checkType": "bridge-id-d"
  },
  "api.auditList": {
    "suggestionId": {
      "bridge": true
    }
  },
  "api.autoLinkerSetSettings": "bridge-sample",
  "api.backupAppData": {},
  "api.betaReadCreate": {
    "sceneId": "bridge-id-a",
    "anchorText": "bridge-id-b",
    "commentText": "bridge-id-c"
  },
  "api.betaReadDismiss": {
    "id": {
      "bridge": true
    }
  },
  "api.betaReadList": {
    "sceneId": {
      "bridge": true
    }
  },
  "api.betaReadScan": {
    "sceneId": "bridge-id-a",
    "prose": "bridge-id-b",
    "scenePath": "bridge-id-c"
  },
  "api.betaReportGet": {
    "id": {
      "bridge": true
    }
  },
  "api.betaReportList": {
    "storyId": {
      "bridge": true
    }
  },
  "api.betaReportRun": "bridge-sample",
  "api.brainstormBoard.write": {
    "content": {
      "bridge": true
    }
  },
  "api.brainstormEnrichEntry": "bridge-sample",
  "api.brainstormExtractProposals": "bridge-sample",
  "api.brainstormProposalConfirm": "bridge-sample",
  "api.brainstormProposalReject": "bridge-sample",
  "api.brainstormResetCategoryRouting": {
    "category": {
      "bridge": true
    }
  },
  "api.brainstormResolveRouting": "bridge-sample",
  "api.brainstormSelectContext": "bridge-sample",
  "api.brainstormWriteNote": "bridge-sample",
  "api.brainstormer": {
    "topic": "bridge-id-a",
    "context": "bridge-id-b"
  },
  "api.cancelAiActivity": {
    "requestId": "bridge-id"
  },
  "api.cancelBrainstorm": {
    "requestId": "bridge-id"
  },
  "api.cancelVaultCheck": {
    "requestId": "bridge-id"
  },
  "api.cancelWritingAssistant": {
    "requestId": "bridge-id"
  },
  "api.chapterCreate": "bridge-sample",
  "api.chooseVaultFolder": {
    "title": "/tmp/bridge-sample",
    "defaultPath": "bridge-id-b"
  },
  "api.continuityMatchSelection": {
    "selectedText": "bridge-id-a",
    "notesVaultRoot": "bridge-id-b"
  },
  "api.continuityReadEntity": {
    "path": {
      "bridge": true
    }
  },
  "api.continuitySearch": {
    "query": "bridge-id-a",
    "notesVaultRoot": "bridge-id-b"
  },
  "api.createBlankVault": {
    "targetPath": "/tmp/bridge-sample",
    "registrationToken": "bridge-id-b"
  },
  "api.createVaultFromOptions": "/tmp/bridge-sample",
  "api.customFieldsSet": {
    "fields": {
      "bridge": true
    }
  },
  "api.deleteNotesVault": {
    "path": {
      "bridge": true
    }
  },
  "api.deleteVault": {
    "path": {
      "bridge": true
    }
  },
  "api.draftsCreate": {
    "sceneId": "bridge-id-a",
    "content": "bridge-id-b",
    "label": "bridge-id-c"
  },
  "api.draftsDelete": {
    "snapshotId": {
      "bridge": true
    }
  },
  "api.draftsLabel": {
    "snapshotId": "bridge-id-a",
    "label": "bridge-id-b"
  },
  "api.draftsList": {
    "sceneId": {
      "bridge": true
    }
  },
  "api.draftsPreview": {
    "snapshotId": {
      "bridge": true
    }
  },
  "api.draftsRestore": {
    "snapshotId": "bridge-id-a",
    "sceneId": "bridge-id-b",
    "currentContent": "bridge-id-c"
  },
  "api.dryRunObsidianImport": {
    "srcPath": "bridge-id-a",
    "targetVaultKind": "bridge-id-b"
  },
  "api.entityBacklinks": {
    "entityId": {
      "bridge": true
    }
  },
  "api.entityCreate": "bridge-sample",
  "api.entityDelete": {
    "id": {
      "bridge": true
    }
  },
  "api.entityLinkedScenes": {
    "entityId": {
      "bridge": true
    }
  },
  "api.entityList": {
    "type": {
      "bridge": true
    }
  },
  "api.entityRead": {
    "id": {
      "bridge": true
    }
  },
  "api.entityRelationshipsCreate": {
    "fromEntityId": "bridge-id-a",
    "toEntityId": "bridge-id-b",
    "label": "bridge-id-c"
  },
  "api.entityRelationshipsDelete": {
    "relationshipId": {
      "bridge": true
    }
  },
  "api.entityRelationshipsList": {
    "entityId": {
      "bridge": true
    }
  },
  "api.entityUpdate": "bridge-sample",
  "api.exportDocx": {
    "storyId": "bridge-id",
    "options": {
      "includeSynopsis": true
    }
  },
  "api.exportEpub": {
    "storyId": "bridge-id-a",
    "metadata": "bridge-id-b",
    "targetPath": "bridge-id-c",
    "options": "bridge-id-d"
  },
  "api.exportMarkdown": {
    "scope": {
      "bridge": true
    }
  },
  "api.exportPdf": {
    "scope": "bridge-id-a",
    "options": "bridge-id-b"
  },
  "api.exportPlaintext": {
    "scope": {
      "bridge": true
    }
  },
  "api.generationLogGet": {
    "id": {
      "bridge": true
    }
  },
  "api.generationLogList": {
    "page": "bridge-id-a",
    "pageSize": "bridge-id-b",
    "agent": "bridge-id-c"
  },
  "api.generationLogRecent": "bridge-sample",
  "api.getRefinementSuggestions": {
    "messages": [
      {
        "role": "user",
        "content": "Action: shorten\nAdditional instruction: more\nActive preset: preset-1\nOriginal suggestion:\norig"
      }
    ],
    "system": "You are a creative writing refinement assistant. Apply the requested refinement to the suggestion below, maintaining prose quality. Return only the refined suggestion text — no preamble."
  },
  "api.goalsLogWords": {
    "date": "2026-01-01",
    "wordsAdded": 100
  },
  "api.goalsSetGoal": {
    "dailyGoal": 500
  },
  "api.iconReadSvg": {
    "packName": "bridge-id-a",
    "iconName": "bridge-id-b"
  },
  "api.importDocxToStoryVault": {
    "filePaths": [
      "/tmp/bridge-sample"
    ]
  },
  "api.importHub.commit": {
    "token": "bridge-token",
    "options": {
      "story": true
    }
  },
  "api.importHub.pick": {
    "mode": {
      "bridge": true
    }
  },
  "api.importHub.previewDropped": {
    "path": "/mock/sample.txt"
  },
  "api.importObsidianVault": "/tmp/bridge-sample",
  "api.importVault": {
    "sourcePath": "/tmp/bridge-sample",
    "registrationToken": "bridge-id-b"
  },
  "api.importVaultCommit": {
    "sourcePath": {
      "bridge": true
    }
  },
  "api.importVaultDryRun": {
    "sourcePath": {
      "bridge": true
    }
  },
  "api.installUpdate": {
    "quit": false
  },
  "api.jobs.cancel": {
    "jobId": {
      "bridge": true
    }
  },
  "api.jobs.enqueue": {
    "type": "bridge-id-a"
  },
  "api.jobs.list": "bridge-sample",
  "api.jobs.progress": {
    "jobId": {
      "bridge": true
    }
  },
  "api.listNotesVault": {
    "root": {
      "bridge": true
    }
  },
  "api.listVault": {
    "root": {
      "bridge": true
    }
  },
  "api.loadBgImage": {
    "filePath": {
      "bridge": true
    }
  },
  "api.loadSampleProject": {},
  "api.loadSampleTwoVault": {
    "parentPath": {
      "bridge": true
    }
  },
  "api.migrationApply": {
    "planId": "bridge-id-a",
    "storyPath": "bridge-id-b"
  },
  "api.migrationDryRun": {
    "storyPath": {
      "bridge": true
    }
  },
  "api.mkdirNotesVault": {
    "path": {
      "bridge": true
    }
  },
  "api.moveNotesVault": {
    "fromPath": "/tmp/bridge-sample",
    "toPath": "bridge-id-b"
  },
  "api.moveVault": {
    "fromPath": "/tmp/bridge-sample",
    "toPath": "bridge-id-b"
  },
  "api.navigatorReportScene": {
    "sceneId": {
      "bridge": true
    }
  },
  "api.navigatorSelectScene": {
    "sceneId": {
      "bridge": true
    }
  },
  "api.noteBacklinks": {
    "notePath": {
      "bridge": true
    }
  },
  "api.noteTemplateList": {
    "kind": {
      "bridge": true
    }
  },
  "api.notesBoardCreateItem": {
    "folderPath": "bridge-id-a",
    "kind": "bridge-id-b",
    "position": "bridge-id-c"
  },
  "api.notesBoardEmptyTrash": {},
  "api.notesBoardFurnitureCreate": {
    "folderPath": "bridge-id-a",
    "item": "bridge-id-b"
  },
  "api.notesBoardFurnitureDelete": {
    "folderPath": "bridge-id-a",
    "furnitureId": "bridge-id-b"
  },
  "api.notesBoardFurnitureUpdate": {
    "folderPath": "bridge-id-a",
    "furnitureId": "bridge-id-b",
    "patch": "bridge-id-c"
  },
  "api.notesBoardGet": {
    "folderPath": {
      "bridge": true
    }
  },
  "api.notesBoardItemDelete": {
    "folderPath": "bridge-id-a",
    "itemPath": "bridge-id-b"
  },
  "api.notesBoardItemRename": {
    "folderPath": "bridge-id-a",
    "fromPath": "bridge-id-b",
    "toPath": "bridge-id-c"
  },
  "api.notesBoardPatchColors": {
    "folderPath": "bridge-id-a",
    "itemPath": "bridge-id-b",
    "color": "bridge-id-c"
  },
  "api.notesBoardPatchLayout": {
    "folderPath": "bridge-id-a",
    "itemPath": "bridge-id-b",
    "patch": "bridge-id-c"
  },
  "api.notesBoardRecentlyDeletedList": {},
  "api.notesBoardRenameItem": {
    "folderPath": "bridge-id-a",
    "itemPath": "bridge-id-b",
    "newName": "bridge-id-c"
  },
  "api.notesBoardRestore": {
    "id": {
      "bridge": true
    }
  },
  "api.notesBoardTrashItems": {
    "folderPath": "/tmp/bridge-sample",
    "targets": []
  },
  "api.notesGet": {
    "sceneId": {
      "bridge": true
    }
  },
  "api.notesSet": {
    "sceneId": "bridge-id-a",
    "content": "bridge-id-b"
  },
  "api.notesTagMerge": {
    "sourceTag": "/tmp/bridge-sample",
    "targetTag": "bridge-id-b"
  },
  "api.notesTagRename": {
    "oldTag": "/tmp/bridge-sample",
    "newTag": "bridge-id-b"
  },
  "api.notesThumbGet": {
    "src": {
      "bridge": true
    }
  },
  "api.notesThumbImport": {
    "sourcePath": {
      "bridge": true
    }
  },
  "api.notesThumbPut": {
    "src": "/tmp/bridge-sample",
    "version": "v1",
    "bytes": {
      "0": 1,
      "1": 2,
      "2": 3
    }
  },
  "api.notesThumbResolve": {
    "paths": {
      "bridge": true
    }
  },
  "api.notesTierContext": {
    "sceneId": {
      "bridge": true
    }
  },
  "api.notesVaultRegistryCreate": "/tmp/bridge-sample",
  "api.notesVaultRegistryRename": {
    "id": "/tmp/bridge-sample",
    "displayName": "bridge-id-b"
  },
  "api.notesVaultRegistrySetActive": {
    "id": {
      "bridge": true
    }
  },
  "api.notesVaultRegistrySetActivePreview": {
    "id": {
      "bridge": true
    }
  },
  "api.notesVaultSetIcon": {
    "path": "/tmp/bridge-sample",
    "icon": "bridge-id-b",
    "color": "bridge-id-c"
  },
  "api.obsidianDryRun": {
    "sourcePath": "/tmp/bridge-sample",
    "registrationToken": "bridge-id-b"
  },
  "api.obsidianPickFolderByPath": {
    "sourcePath": "/tmp/bridge-sample"
  },
  "api.obsidianRegister": {
    "sourcePath": "/tmp/bridge-sample",
    "registrationToken": "bridge-id-b"
  },
  "api.onboardingComplete": "bridge-sample",
  "api.onboardingDetectMythosVault": {
    "path": {
      "bridge": true
    }
  },
  "api.onboardingOpenExistingVault": {
    "path": {
      "bridge": true
    }
  },
  "api.onboardingReset": "bridge-sample",
  "api.onboardingValidatePath": {
    "path": {
      "bridge": true
    }
  },
  "api.outline.load": {
    "storyVaultPath": {
      "bridge": true
    }
  },
  "api.outline.save": {
    "storyVaultPath": "bridge-id-a",
    "data": "bridge-id-b"
  },
  "api.panelFloat": {
    "0": "b",
    "1": "r",
    "2": "i",
    "3": "d",
    "4": "g",
    "5": "e",
    "6": "-",
    "7": "i",
    "8": "d",
    "9": "-",
    "10": "b",
    "panelId": "bridge-id-a"
  },
  "api.panelFloatDockBack": {
    "panelId": {
      "bridge": true
    }
  },
  "api.panelFloatSetPin": {
    "panelId": "bridge-id-a",
    "alwaysOnTop": "bridge-id-b"
  },
  "api.panelPopout": {
    "panelId": "bridge-id-a",
    "sceneId": "bridge-id-b"
  },
  "api.pickFolder": "/tmp/bridge-sample",
  "api.productionRoleRun": "bridge-sample",
  "api.projectIconSet": "bridge-sample",
  "api.projectNameSet": "bridge-sample",
  "api.projectSwitch": {
    "vaultRoot": "bridge-id-a",
    "notesVaultRoot": "bridge-id-b"
  },
  "api.provenanceUpsert": {
    "entityId": "bridge-id-a",
    "entityKind": "bridge-id-b",
    "agentId": "bridge-id-c",
    "agentType": "bridge-id-d",
    "runId": "bridge-id-e"
  },
  "api.providerListModels": "bridge-sample",
  "api.readNotesVault": {
    "path": {
      "bridge": true
    }
  },
  "api.readVault": {
    "path": {
      "bridge": true
    }
  },
  "api.reorderNotesVault": {
    "parentPath": "/tmp/bridge-sample",
    "orderedPaths": "bridge-id-b"
  },
  "api.restoreAppData": {
    "confirmed": {
      "bridge": true
    }
  },
  "api.sceneAppendBrainstormNote": {
    "sceneId": "bridge-id-a",
    "content": "bridge-id-b"
  },
  "api.sceneCrafterAddCard": "bridge-sample",
  "api.sceneCrafterAddLane": {
    "storySlug": "bridge-id-a",
    "name": "bridge-id-b"
  },
  "api.sceneCrafterClose": {
    "storySlug": {
      "bridge": true
    }
  },
  "api.sceneCrafterCreateBoard": {
    "storyId": "bridge-id-a",
    "storySlug": "bridge-id-b"
  },
  "api.sceneCrafterDeleteCard": "bridge-sample",
  "api.sceneCrafterDeleteLane": "bridge-sample",
  "api.sceneCrafterGetBoard": {
    "storyId": "bridge-id-a",
    "storySlug": "bridge-id-b"
  },
  "api.sceneCrafterMoveCard": "bridge-sample",
  "api.sceneCrafterRenameLane": "bridge-sample",
  "api.sceneCrafterReorderLanes": "bridge-sample",
  "api.sceneCrafterSaveBoard": "bridge-sample",
  "api.sceneCrafterSuggestionAccept": {
    "suggestionId": "bridge-id-a",
    "actor": "bridge-id-b"
  },
  "api.sceneCrafterSuggestionReject": {
    "suggestionId": "bridge-id-a",
    "actor": "bridge-id-b"
  },
  "api.sceneCrafterToggleCardDone": "bridge-sample",
  "api.sceneCreate": "bridge-sample",
  "api.scenePropsGet": {
    "sceneId": {
      "bridge": true
    }
  },
  "api.scenePropsSet": {
    "sceneId": "bridge-id-a",
    "customFields": "bridge-id-b"
  },
  "api.sceneRename": "bridge-sample",
  "api.sceneSave": "bridge-sample",
  "api.sceneSetTags": "bridge-sample",
  "api.searchVault": {
    "query": "/tmp/bridge-sample",
    "scope": "bridge-id-b",
    "limit": "bridge-id-c",
    "filterTags": "bridge-id-d"
  },
  "api.sessionSaveScene": "bridge-sample",
  "api.setAgentConfig": {
    "agent": "bridge-id-a",
    "config": "bridge-id-b"
  },
  "api.settingsSet": {
    "0": "b",
    "1": "r",
    "2": "i",
    "3": "d",
    "4": "g",
    "5": "e",
    "6": "-",
    "7": "i",
    "8": "d",
    "9": "-",
    "10": "b",
    "settings": "bridge-id-a"
  },
  "api.settingsTestConnection": {
    "provider": {
      "bridge": true
    }
  },
  "api.smartFolderCreate": {
    "name": "bridge-id-a",
    "query": "bridge-id-b"
  },
  "api.smartFolderDelete": {
    "id": {
      "bridge": true
    }
  },
  "api.smartFolderQuery": {
    "query": {
      "bridge": true
    }
  },
  "api.smartFolderUpdate": {
    "0": "b",
    "1": "r",
    "2": "i",
    "3": "d",
    "4": "g",
    "5": "e",
    "6": "-",
    "7": "i",
    "8": "d",
    "9": "-",
    "10": "b",
    "id": "bridge-id-a"
  },
  "api.snapshotDelete": {
    "sceneId": "bridge-id-a",
    "snapshotId": "bridge-id-b"
  },
  "api.snapshotDeleteAll": {
    "sceneId": {
      "bridge": true
    }
  },
  "api.snapshotGet": {
    "sceneId": "bridge-id-a",
    "snapshotId": "bridge-id-b"
  },
  "api.snapshotList": {
    "sceneId": {
      "bridge": true
    }
  },
  "api.snapshotRestore": {
    "sceneId": "bridge-id-a",
    "snapshotId": "bridge-id-b",
    "scenePath": "bridge-id-c"
  },
  "api.snapshotSave": {
    "sceneId": "bridge-id-a",
    "content": "bridge-id-b",
    "label": "bridge-id-c"
  },
  "api.storyImportPickFile": {
    "format": "docx"
  },
  "api.storyImportRun": {
    "format": "bridge-id-a",
    "filePath": "bridge-id-b"
  },
  "api.storyStashRestore": "bridge-sample",
  "api.storyStashSave": "bridge-sample",
  "api.storyVaultRegistryCreate": "/tmp/bridge-sample",
  "api.storyVaultRegistryPair": {
    "storyVaultId": "/tmp/bridge-sample",
    "notesVaultId": "bridge-id-b"
  },
  "api.storyVaultRegistryRename": {
    "id": "/tmp/bridge-sample",
    "displayName": "bridge-id-b"
  },
  "api.storyVaultRegistrySetActive": {
    "id": {
      "bridge": true
    }
  },
  "api.streamAck": {
    "streamId": "bridge-id",
    "count": 7
  },
  "api.streamCancel": {
    "streamId": {
      "bridge": true
    }
  },
  "api.streamStart": "bridge-sample",
  "api.suggestionsAccept": {
    "id": "bridge-id-a",
    "actor": "bridge-id-b"
  },
  "api.suggestionsBatchAction": "bridge-sample",
  "api.suggestionsGet": {
    "id": {
      "bridge": true
    }
  },
  "api.suggestionsIgnore": {
    "id": "bridge-id-a",
    "actor": "bridge-id-b"
  },
  "api.suggestionsList": {
    "0": "b",
    "1": "r",
    "2": "i",
    "3": "d",
    "4": "g",
    "5": "e",
    "6": "-",
    "7": "i",
    "8": "d",
    "9": "-",
    "10": "c",
    "status": "bridge-id-a",
    "sourceAgent": "bridge-id-b"
  },
  "api.suggestionsReject": {
    "id": "bridge-id-a",
    "reason": "bridge-id-b",
    "actor": "bridge-id-c"
  },
  "api.suggestionsRollback": {
    "id": "bridge-id-a",
    "actor": "bridge-id-b"
  },
  "api.suggestionsSearch": "bridge-sample",
  "api.suggestionsUnifiedList": "bridge-sample",
  "api.suggestionsUpsert": {
    "suggestion": {
      "bridge": true
    }
  },
  "api.tagsBulkApply": {
    "itemIds": [
      "bridge-id"
    ],
    "itemKind": "scene",
    "addTags": [
      "bridge-sample"
    ],
    "removeTags": [
      "bridge-sample-2"
    ]
  },
  "api.tagsDelete": {
    "id": {
      "bridge": true
    }
  },
  "api.tagsForItem": {
    "itemId": "bridge-id-a",
    "itemKind": "bridge-id-b"
  },
  "api.tagsItemsForTag": {
    "tagName": {
      "bridge": true
    }
  },
  "api.tagsRename": {
    "id": "bridge-id-a",
    "name": "bridge-id-b"
  },
  "api.tagsSetForItem": {
    "itemId": "bridge-id-a",
    "itemKind": "bridge-id-b",
    "tags": "bridge-id-c"
  },
  "api.tagsUpsert": {
    "name": "bridge-id-a",
    "color": "bridge-id-b"
  },
  "api.telemetryReport": {
    "type": "bridge-id-a",
    "meta": "bridge-id-b"
  },
  "api.templateDelete": {
    "id": {
      "bridge": true
    }
  },
  "api.templateDuplicate": {
    "id": {
      "bridge": true
    }
  },
  "api.templateExport": {
    "id": {
      "bridge": true
    }
  },
  "api.templateImportFromPath": {
    "filePath": {
      "bridge": true
    }
  },
  "api.templateRename": {
    "id": "bridge-id-a",
    "name": "bridge-id-b"
  },
  "api.templateSaveAs": {
    "name": {
      "bridge": true
    }
  },
  "api.templateScaffold": {
    "templateId": "bridge-id-a",
    "parentToken": "bridge-id-b"
  },
  "api.timelineGetScenes": {
    "storyId": {
      "bridge": true
    }
  },
  "api.timelineGetSettings": {
    "storyId": {
      "bridge": true
    }
  },
  "api.timelineInfer": {
    "storyId": {
      "bridge": true
    }
  },
  "api.timelineList": {},
  "api.timelineListArcs": {},
  "api.timelineProposalResolve": {
    "proposalId": "bridge-id-a",
    "decision": "bridge-id-b"
  },
  "api.timelineProposalsGenerate": {
    "storyId": {
      "bridge": true
    }
  },
  "api.timelineProposalsList": {
    "storyId": {
      "bridge": true
    }
  },
  "api.timelineRebuild": {},
  "api.timelineSaveSettings": {
    "settings": "bridge-id-a",
    "storyId": "bridge-id-b"
  },
  "api.timelineUpdateArcColor": {
    "arcId": "bridge-id-a",
    "color": "bridge-id-b",
    "colorIsCustom": "bridge-id-c"
  },
  "api.timelineUpdateScene": "bridge-sample",
  "api.timelineUpsert": "bridge-sample",
  "api.timelinesDeleteItem": "bridge-sample",
  "api.timelinesGetStore": {},
  "api.timelinesSetActive": {
    "timelineId": {
      "bridge": true
    }
  },
  "api.timelinesUpsert": "bridge-sample",
  "api.timelinesUpsertItem": "bridge-sample",
  "api.validatePath": {
    "path": {
      "bridge": true
    }
  },
  "api.vaultAccessSet": "bridge-sample",
  "api.vaultCreateDefaultMythos": "/tmp/bridge-sample",
  "api.vaultCrossLinkAdd": "bridge-sample",
  "api.vaultCrossLinkRemove": "bridge-sample",
  "api.vaultGraphEdges": "both",
  "api.vaultGraphNodes": "notes",
  "api.vaultImportRun": "/tmp/bridge-sample",
  "api.vaultImportScan": {
    "kind": "/tmp/bridge-sample",
    "srcPath": "bridge-id-b"
  },
  "api.vaultLocalFolderMove": "/tmp/bridge-sample",
  "api.vaultSeedApplyBoth": "/tmp/bridge-sample",
  "api.vaultSetPaths": {
    "storyVaultPath": "/tmp/bridge-sample",
    "notesVaultPath": "/tmp/bridge-sample",
    "seedMode": "default",
    "storyVaultToken": "bridge-token"
  },
  "api.vaultSurfaceBlastRadius": {
    "mythosVaultRoot": {
      "bridge": true
    }
  },
  "api.vaultSurfaceHide": "/tmp/bridge-sample",
  "api.vaultSurfaceMoveVaultsParent": {
    "newParentPath": {
      "bridge": true
    }
  },
  "api.vaultSurfaceRevealMythos": {
    "mythosVaultRoot": {
      "bridge": true
    }
  },
  "api.vaultSurfaceTrash": "/tmp/bridge-sample",
  "api.vaultSurfaceUnhide": {
    "vaultRoot": {
      "bridge": true
    }
  },
  "api.versionGet": {
    "sceneId": "bridge-id-a",
    "ts": "bridge-id-b"
  },
  "api.versionList": {
    "sceneId": {
      "bridge": true
    }
  },
  "api.versionRollback": {
    "sceneId": "bridge-id-a",
    "ts": "bridge-id-b"
  },
  "api.versionSave": {
    "sceneId": "bridge-id-a",
    "content": "bridge-id-b",
    "intent": "bridge-id-c"
  },
  "api.voiceAudioChunk": {
    "sessionId": "bridge-id",
    "chunk": {}
  },
  "api.voiceLocalTranscript": {
    "sessionId": "bridge-id",
    "text": "bridge-sample",
    "isFinal": true
  },
  "api.voicePickBinary": {
    "kind": "stt-binary"
  },
  "api.voiceSpeak": {
    "text": "bridge-id-a",
    "voiceId": "bridge-id-b"
  },
  "api.voiceSpeakCancel": {
    "speakId": "bridge-id"
  },
  "api.voiceStart": {
    "micDeviceId": {
      "bridge": true
    }
  },
  "api.voiceStop": {
    "sessionId": {
      "bridge": true
    }
  },
  "api.voiceTranscribe": {
    "audio": "bridge-id-a",
    "mimeType": "bridge-id-b",
    "language": "bridge-id-c"
  },
  "api.writeManifest": {
    "manifest": {
      "bridge": true
    }
  },
  "api.writeNotesVault": {
    "path": "/tmp/bridge-sample",
    "content": "bridge-id-b"
  },
  "api.writeVault": {
    "path": "/tmp/bridge-sample",
    "content": "bridge-id-b"
  },
  "api.writingAssistant": {
    "manuscript": "bridge-id-a",
    "scenePath": "bridge-id-b"
  },
  "api.writingAssistantCadenceChange": "bridge-sample",
  "api.writingAssistantScanNow": "bridge-sample",
  "api.writingAssistantSetActiveScene": "bridge-sample",
  "api.writingAssistantSuggestionList": "bridge-sample",
  "api.writingAssistantTipDecision": "bridge-sample",
  "api.writingModeSet": "bridge-sample",
  "api.writingScan": {
    "sceneId": "bridge-id-a",
    "prose": "bridge-id-b",
    "scenePath": "bridge-id-c"
  },
  "mythosIPC.archive": {
    "manuscript": "bridge-id-a",
    "vaultPath": "bridge-id-b"
  },
  "mythosIPC.brainstormer": {
    "topic": "bridge-id-a",
    "context": "bridge-id-b"
  },
  "mythosIPC.deleteVaultFile": {
    "path": {
      "bridge": true
    }
  },
  "mythosIPC.listVaultFiles": {
    "root": {
      "bridge": true
    }
  },
  "mythosIPC.readVaultFile": {
    "path": {
      "bridge": true
    }
  },
  "mythosIPC.writeManifest": {
    "manifest": {
      "bridge": true
    }
  },
  "mythosIPC.writeVaultFile": {
    "path": "/tmp/bridge-sample",
    "content": "bridge-id-b"
  },
  "mythosIPC.writingAssistant": {
    "manuscript": "bridge-id-a",
    "scenePath": "bridge-id-b"
  }
};

const SINGLE_ARG_INVOKE = new Set<string>([
  'api.agentIndex.clean',
  'api.agentIndex.getStats',
  'api.agentIndex.rebuild',
  'api.agentsVaultClearMemory',
  'api.agentsVaultEnsure',
  'api.agentsVaultReadPartner',
  'api.agentsVaultReveal',
  'api.agentsVaultStats',
  'api.archiveListGlobalContradictions',
  'api.brainstormBoard.migrateToNotes',
  'api.brainstormBoard.migrationPreview',
  'api.brainstormBoard.read',
  'api.modelKeysShowItemInFolder',
  'api.vaultAccessGetState',
  'api.vaultMigrateMultiInner',
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
  const payload =
    override?.payload ??
    (singleArgInvoke ? undefined : op === 'send' ? BRIDGE_RECORDED_PAYLOADS[key] : BRIDGE_RECORDED_PAYLOADS[key]);
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

function assertListenerForwardsToCallback(
  bridgeFn: (...args: unknown[]) => unknown,
  ipcHandler: (...args: unknown[]) => void,
  userCb: ReturnType<typeof vi.fn>,
): void {
  userCb.mockClear();
  const src = Function.prototype.toString.call(bridgeFn);

  if (/\bipcRenderer\.on\([^,]+,\s*cb\)/.test(src)) {
    const fakeEvent = { sender: {} };
    const payload = { path: SAMPLE.path };
    ipcHandler(fakeEvent, payload);
    expect(userCb).toHaveBeenCalledTimes(1);
    expect(userCb).toHaveBeenCalledWith(fakeEvent, payload);
    return;
  }

  if (/\bconst handler = \(\) => cb\(\)/.test(src)) {
    ipcHandler();
    expect(userCb).toHaveBeenCalledTimes(1);
    expect(userCb).toHaveBeenCalledWith();
    return;
  }

  const passthrough = {
    current: 1,
    total: 2,
    lastAction: 'bridge-action',
    streamId: SAMPLE.id,
    token: 'bridge-token',
    category: 'bridge-cat',
    message: 'bridge-msg',
    count: 3,
    path: SAMPLE.path,
    sessionId: SAMPLE.id,
    text: 'bridge-text',
    isFinal: true,
    error: 'bridge-err',
    speakId: SAMPLE.id,
    chunk: SAMPLE.u8,
    format: 'pcm' as const,
    sampleRate: 44100,
    agent: SAMPLE.str,
    agentLabel: SAMPLE.str2,
    reason: 'hourly_token_cap' as const,
    state: 'checking' as const,
    version: '1.0',
    releaseNotes: null,
    sceneId: SAMPLE.id,
    scenePath: SAMPLE.path,
    tips: ['tip'],
    scannedAt: 't',
    startedAt: 't',
    occurredAt: 't',
    vaultRoot: SAMPLE.path,
    notesVaultRoot: SAMPLE.path,
    mode: 'focus',
    focusFlags: { f: true },
    editConfig: { e: true },
    proposals: [SAMPLE.obj],
    panelId: SAMPLE.id,
    docked: true,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    alwaysOnTop: false,
    scope: 'scene',
    items: [SAMPLE.obj],
    tokenUsed: 1,
    partial: false,
    itemId: SAMPLE.id,
    status: 'ok',
    action: 'accept',
    storySlug: 'bridge-slug',
    requestId: SAMPLE.id,
  };

  let ipcArg: unknown;
  let expected: unknown;

  if (src.includes('cb(data.chunk)')) {
    ipcArg = { chunk: 'bridge-chunk' };
    expected = 'bridge-chunk';
  } else if (src.includes('cb(data.requestId)')) {
    ipcArg = { requestId: SAMPLE.id, category: 'x', message: 'y' };
    expected = SAMPLE.id;
  } else if (src.includes('cb(data.text)')) {
    ipcArg = { text: 'bridge-text' };
    expected = 'bridge-text';
  } else if (src.includes('cb(data.panelId)')) {
    ipcArg = { panelId: SAMPLE.id, docked: true, bounds: { x: 0, y: 0, width: 1, height: 1 } };
    expected = SAMPLE.id;
  } else if (src.includes('cb(data.storySlug)')) {
    ipcArg = { storySlug: 'bridge-slug' };
    expected = 'bridge-slug';
  } else if (src.includes('cb(entries)')) {
    ipcArg = [SAMPLE.obj];
    expected = [SAMPLE.obj];
  } else if (src.includes('cb(info)')) {
    ipcArg = { reason: 'test', itemPath: SAMPLE.path };
    expected = ipcArg;
  } else {
    ipcArg = passthrough;
    expected = ipcArg;
  }

  ipcHandler(null, ipcArg);
  expect(userCb).toHaveBeenCalledTimes(1);
  expect(userCb).toHaveBeenCalledWith(expected);
}

describe('preload bridge', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    sendMock.mockClear();
    onMock.mockClear();
    removeListenerMock.mockClear();
  });

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

      assertListenerForwardsToCallback(fn as (...args: unknown[]) => unknown, handler, cb);

      unsub();
      expect(removeListenerMock).toHaveBeenCalledTimes(1);
      expect(removeListenerMock).toHaveBeenCalledWith(row.channel, handler);
    },
  );

  it('isPackaged is a boolean constant, not IPC', () => {
    expect((capturedWorlds.api as { isPackaged: boolean }).isPackaged).toBe(false);
  });
});

describe.skipIf(!process.env.PRELOAD_BRIDGE_RECORD)('preload bridge recorder', () => {
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
    fs.writeFileSync(
      path.join(SRC_DIR, 'preload.bridge.recorded.json'),
      JSON.stringify({ recorded, singles }, null, 2),
    );
    expect(true).toBe(true);
  });
});

describe('preload bridge mutation sentinel', () => {
  it('documents that renaming a channel in preload.ts breaks the bridge suite', () => {
    const preloadPath = path.join(SRC_DIR, 'preload.ts');
    const original = fs.readFileSync(preloadPath, 'utf8');
    const mutated = original.replace("'vault:read'", "'vault:read-MUTATION-1910'");
    expect(mutated).not.toBe(original);
    expect(mutated.includes('vault:read-MUTATION-1910')).toBe(true);
    expect(original.includes("'vault:read'")).toBe(true);
  });
});
