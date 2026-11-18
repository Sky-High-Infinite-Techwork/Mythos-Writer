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
    invoke: (...args: unknown[]) => {
      harness.invokeMock(...args);
    },
    send: (...args: unknown[]) => {
      harness.sendMock(...args);
    },
    on: (...args: unknown[]) => {
      harness.onMock(...args);
    },
    removeListener: (...args: unknown[]) => {
      harness.removeListenerMock(...args);
    },
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
    "agentName": "bridge-sample",
    "key": "bridge-sample-2"
  },
  "api.agentPersonaReset": {
    "agentName": "bridge-sample",
    "key": "bridge-sample-2"
  },
  "api.agentPersonaWrite": {
    "agentName": "bridge-sample",
    "key": "bridge-sample-2",
    "content": "bridge-sample-2"
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
    "sessionId": "bridge-sample"
  },
  "api.agentSessions.duplicate": {
    "sessionId": "bridge-sample"
  },
  "api.agentSessions.list": {
    "agent": "bridge-sample"
  },
  "api.agentSessions.read": {
    "sessionId": "bridge-sample"
  },
  "api.agentSessions.rename": {
    "sessionId": "bridge-sample",
    "title": "bridge-sample-2"
  },
  "api.agentVaultCheck": {
    "sceneContent": "/tmp/bridge-sample"
  },
  "api.agentVaultIndex": {},
  "api.agentWritingAssistant": {
    "prompt": "bridge-sample",
    "context": "bridge-sample-2"
  },
  "api.agentsVaultSyncPartner": "/tmp/bridge-sample",
  "api.archive": {
    "manuscript": "bridge-sample",
    "vaultPath": "bridge-sample-2"
  },
  "api.archiveConfirm": {
    "suggestionId": "bridge-sample",
    "action": "bridge-sample-2"
  },
  "api.archiveListContinuity": "bridge-sample",
  "api.archiveResolveContinuity": {
    "itemId": "bridge-sample",
    "action": "bridge-sample-2",
    "note": "bridge-sample-2"
  },
  "api.archiveScan": {
    "sceneText": "bridge-sample",
    "scenePath": "bridge-sample-2"
  },
  "api.archiveScanContinuity": {
    "sceneId": "bridge-sample",
    "text": "bridge-sample-2",
    "scope": "bridge-sample-2",
    "checkType": "bridge-sample-2"
  },
  "api.auditList": {
    "suggestionId": "bridge-sample"
  },
  "api.autoLinkerSetSettings": "bridge-sample",
  "api.backupAppData": {},
  "api.betaReadCreate": {
    "sceneId": "bridge-sample",
    "anchorText": "bridge-sample-2",
    "commentText": "bridge-sample-2"
  },
  "api.betaReadDismiss": {
    "id": "bridge-sample"
  },
  "api.betaReadList": {
    "sceneId": "bridge-sample"
  },
  "api.betaReadScan": {
    "sceneId": "bridge-sample",
    "prose": "bridge-sample-2",
    "scenePath": "bridge-sample-2"
  },
  "api.betaReportGet": {
    "id": "bridge-sample"
  },
  "api.betaReportList": {
    "storyId": "bridge-sample"
  },
  "api.betaReportRun": "bridge-sample",
  "api.brainstormBoard.write": {
    "content": "bridge-sample"
  },
  "api.brainstormEnrichEntry": "bridge-sample",
  "api.brainstormExtractProposals": "bridge-sample",
  "api.brainstormProposalConfirm": "bridge-sample",
  "api.brainstormProposalReject": "bridge-sample",
  "api.brainstormResetCategoryRouting": {
    "category": "bridge-sample"
  },
  "api.brainstormResolveRouting": "bridge-sample",
  "api.brainstormSelectContext": "bridge-sample",
  "api.brainstormWriteNote": "bridge-sample",
  "api.brainstormer": {
    "topic": "bridge-sample",
    "context": "bridge-sample-2"
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
    "defaultPath": "bridge-sample"
  },
  "api.continuityMatchSelection": {
    "selectedText": "bridge-sample",
    "notesVaultRoot": "bridge-sample-2"
  },
  "api.continuityReadEntity": {
    "path": "bridge-sample"
  },
  "api.continuitySearch": {
    "query": "bridge-sample",
    "notesVaultRoot": "bridge-sample-2"
  },
  "api.createBlankVault": {
    "targetPath": "/tmp/bridge-sample",
    "registrationToken": "bridge-sample"
  },
  "api.createVaultFromOptions": "/tmp/bridge-sample",
  "api.customFieldsSet": {
    "fields": "bridge-sample"
  },
  "api.deleteNotesVault": {
    "path": "/tmp/bridge-sample"
  },
  "api.deleteVault": {
    "path": "/tmp/bridge-sample"
  },
  "api.draftsCreate": {
    "sceneId": "bridge-id-a",
    "content": "bridge-id-b",
    "label": "bridge-id-c"
  },
  "api.draftsDelete": {
    "snapshotId": "bridge-id-a"
  },
  "api.draftsLabel": {
    "snapshotId": "bridge-id-a",
    "label": "bridge-id-b"
  },
  "api.draftsList": {
    "sceneId": "bridge-id-a"
  },
  "api.draftsPreview": {
    "snapshotId": "bridge-id-a"
  },
  "api.draftsRestore": {
    "snapshotId": "bridge-id-a",
    "sceneId": "bridge-id-b",
    "currentContent": "bridge-id-c"
  },
  "api.dryRunObsidianImport": {
    "srcPath": "bridge-sample",
    "targetVaultKind": "bridge-sample-2"
  },
  "api.entityBacklinks": {
    "entityId": "bridge-sample"
  },
  "api.entityCreate": "bridge-sample",
  "api.entityDelete": {
    "id": "bridge-sample"
  },
  "api.entityLinkedScenes": {
    "entityId": "bridge-sample"
  },
  "api.entityList": {
    "type": "bridge-sample"
  },
  "api.entityRead": {
    "id": "bridge-sample"
  },
  "api.entityRelationshipsCreate": {
    "fromEntityId": "bridge-sample",
    "toEntityId": "bridge-sample-2",
    "label": "bridge-sample-2"
  },
  "api.entityRelationshipsDelete": {
    "relationshipId": "bridge-sample"
  },
  "api.entityRelationshipsList": {
    "entityId": "bridge-sample"
  },
  "api.entityUpdate": "bridge-sample",
  "api.exportDocx": {
    "storyId": "bridge-id",
    "options": {
      "includeSynopsis": true
    }
  },
  "api.exportEpub": {
    "storyId": "bridge-sample",
    "metadata": "bridge-sample-2",
    "targetPath": "bridge-sample-2",
    "options": "bridge-sample-2"
  },
  "api.exportMarkdown": {
    "scope": "bridge-sample"
  },
  "api.exportPdf": {
    "scope": "bridge-sample",
    "options": "bridge-sample-2"
  },
  "api.exportPlaintext": {
    "scope": "bridge-sample"
  },
  "api.generationLogGet": {
    "id": "bridge-sample"
  },
  "api.generationLogList": {
    "page": "bridge-sample",
    "pageSize": "bridge-sample-2",
    "agent": "bridge-sample-2"
  },
  "api.generationLogRecent": "bridge-sample",
  "api.getRefinementSuggestions": {
    "messages": [
      {
        "role": "user",
        "content": "Action: shorten\nAdditional instruction: more\nActive preset: preset-1\nOriginal suggestion:\norig"
      }
    ],
    "system": "You are a creative writing refinement assistant. Apply the requested refinement to the suggestion below, maintaining prose quality. Return only the refined suggestion text \u2014 no preamble."
  },
  "api.goalsLogWords": {
    "date": "2026-01-01",
    "wordsAdded": 100
  },
  "api.goalsSetGoal": {
    "dailyGoal": 500
  },
  "api.iconReadSvg": {
    "packName": "bridge-sample",
    "iconName": "bridge-sample-2"
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
    "mode": "bridge-sample"
  },
  "api.importHub.previewDropped": {
    "path": "/mock/sample.txt"
  },
  "api.importObsidianVault": "/tmp/bridge-sample",
  "api.importVault": {
    "sourcePath": "/tmp/bridge-sample",
    "registrationToken": "bridge-sample"
  },
  "api.importVaultCommit": {
    "sourcePath": "/tmp/bridge-sample"
  },
  "api.importVaultDryRun": {
    "sourcePath": "/tmp/bridge-sample"
  },
  "api.installUpdate": {
    "quit": false
  },
  "api.jobs.cancel": {
    "jobId": "bridge-sample"
  },
  "api.jobs.enqueue": {
    "type": "bridge-sample"
  },
  "api.jobs.list": "bridge-sample",
  "api.jobs.progress": {
    "jobId": "bridge-sample"
  },
  "api.listNotesVault": {
    "root": "/tmp/bridge-sample"
  },
  "api.listVault": {
    "root": "/tmp/bridge-sample"
  },
  "api.loadBgImage": {
    "filePath": "bridge-sample"
  },
  "api.loadSampleProject": {},
  "api.loadSampleTwoVault": {
    "parentPath": "/tmp/bridge-sample"
  },
  "api.migrationApply": {
    "planId": "bridge-sample",
    "storyPath": "bridge-sample-2"
  },
  "api.migrationDryRun": {
    "storyPath": "bridge-sample"
  },
  "api.mkdirNotesVault": {
    "path": "/tmp/bridge-sample"
  },
  "api.moveNotesVault": {
    "fromPath": "/tmp/bridge-sample",
    "toPath": "bridge-sample"
  },
  "api.moveVault": {
    "fromPath": "/tmp/bridge-sample",
    "toPath": "bridge-sample"
  },
  "api.navigatorReportScene": {
    "sceneId": "bridge-sample"
  },
  "api.navigatorSelectScene": {
    "sceneId": "bridge-sample"
  },
  "api.noteBacklinks": {
    "notePath": "/tmp/bridge-sample"
  },
  "api.noteTemplateList": {
    "kind": "bridge-sample"
  },
  "api.notesBoardCreateItem": {
    "folderPath": "bridge-sample",
    "kind": "bridge-sample-2",
    "position": "bridge-sample-2"
  },
  "api.notesBoardEmptyTrash": {},
  "api.notesBoardFurnitureCreate": {
    "folderPath": "bridge-sample",
    "item": "bridge-sample-2"
  },
  "api.notesBoardFurnitureDelete": {
    "folderPath": "bridge-sample",
    "furnitureId": "bridge-sample-2"
  },
  "api.notesBoardFurnitureUpdate": {
    "folderPath": "bridge-sample",
    "furnitureId": "bridge-sample-2",
    "patch": "bridge-sample-2"
  },
  "api.notesBoardGet": {
    "folderPath": "bridge-sample"
  },
  "api.notesBoardItemDelete": {
    "folderPath": "bridge-sample",
    "itemPath": "bridge-sample-2"
  },
  "api.notesBoardItemRename": {
    "folderPath": "bridge-sample",
    "fromPath": "bridge-sample-2",
    "toPath": "bridge-sample-2"
  },
  "api.notesBoardPatchColors": {
    "folderPath": "bridge-sample",
    "itemPath": "bridge-sample-2",
    "color": "bridge-sample-2"
  },
  "api.notesBoardPatchLayout": {
    "folderPath": "bridge-sample",
    "itemPath": "bridge-sample-2",
    "patch": "bridge-sample-2"
  },
  "api.notesBoardRecentlyDeletedList": {},
  "api.notesBoardRenameItem": {
    "folderPath": "bridge-sample",
    "itemPath": "bridge-sample-2",
    "newName": "bridge-sample-2"
  },
  "api.notesBoardRestore": {
    "id": "bridge-sample"
  },
  "api.notesBoardTrashItems": {
    "folderPath": "/tmp/bridge-sample",
    "targets": []
  },
  "api.notesGet": {
    "sceneId": "bridge-sample"
  },
  "api.notesSet": {
    "sceneId": "bridge-sample",
    "content": "bridge-sample-2"
  },
  "api.notesTagMerge": {
    "sourceTag": "/tmp/bridge-sample",
    "targetTag": "bridge-sample"
  },
  "api.notesTagRename": {
    "oldTag": "/tmp/bridge-sample",
    "newTag": "bridge-sample"
  },
  "api.notesThumbGet": {
    "src": "/tmp/bridge-sample"
  },
  "api.notesThumbImport": {
    "sourcePath": "/tmp/bridge-sample"
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
    "paths": "/tmp/bridge-sample"
  },
  "api.notesTierContext": {
    "sceneId": "bridge-sample"
  },
  "api.notesVaultRegistryCreate": "/tmp/bridge-sample",
  "api.notesVaultRegistryRename": {
    "id": "/tmp/bridge-sample",
    "displayName": "bridge-sample"
  },
  "api.notesVaultRegistrySetActive": {
    "id": "/tmp/bridge-sample"
  },
  "api.notesVaultRegistrySetActivePreview": {
    "id": "/tmp/bridge-sample"
  },
  "api.notesVaultSetIcon": {
    "path": "/tmp/bridge-sample",
    "icon": "bridge-sample",
    "color": "bridge-sample-2"
  },
  "api.obsidianDryRun": {
    "sourcePath": "/tmp/bridge-sample",
    "registrationToken": "bridge-sample"
  },
  "api.obsidianPickFolderByPath": {
    "sourcePath": "/tmp/bridge-sample"
  },
  "api.obsidianRegister": {
    "sourcePath": "/tmp/bridge-sample",
    "registrationToken": "bridge-sample"
  },
  "api.onboardingComplete": "bridge-sample",
  "api.onboardingDetectMythosVault": {
    "path": "/tmp/bridge-sample"
  },
  "api.onboardingOpenExistingVault": {
    "path": "/tmp/bridge-sample"
  },
  "api.onboardingReset": "bridge-sample",
  "api.onboardingValidatePath": {
    "path": "/tmp/bridge-sample"
  },
  "api.outline.load": {
    "storyVaultPath": "bridge-sample"
  },
  "api.outline.save": {
    "storyVaultPath": "bridge-sample",
    "data": "bridge-sample-2"
  },
  "api.panelFloat": {
    "0": "b",
    "1": "r",
    "2": "i",
    "3": "d",
    "4": "g",
    "5": "e",
    "6": "-",
    "7": "s",
    "8": "a",
    "9": "m",
    "10": "p",
    "11": "l",
    "12": "e",
    "13": "-",
    "14": "2",
    "panelId": "bridge-sample"
  },
  "api.panelFloatDockBack": {
    "panelId": "bridge-sample"
  },
  "api.panelFloatSetPin": {
    "panelId": "bridge-sample",
    "alwaysOnTop": "bridge-sample-2"
  },
  "api.panelPopout": {
    "panelId": "bridge-sample",
    "sceneId": "bridge-sample-2"
  },
  "api.pickFolder": "/tmp/bridge-sample",
  "api.productionRoleRun": "bridge-sample",
  "api.projectIconSet": "bridge-sample",
  "api.projectNameSet": "bridge-sample",
  "api.projectSwitch": {
    "vaultRoot": "bridge-sample",
    "notesVaultRoot": "bridge-sample-2"
  },
  "api.provenanceUpsert": {
    "entityId": "bridge-sample",
    "entityKind": "bridge-sample-2",
    "agentId": "bridge-sample-2",
    "agentType": "bridge-sample-2",
    "runId": "bridge-sample-2"
  },
  "api.providerListModels": "bridge-sample",
  "api.readNotesVault": {
    "path": "/tmp/bridge-sample"
  },
  "api.readVault": {
    "path": "/tmp/bridge-sample"
  },
  "api.reorderNotesVault": {
    "parentPath": "/tmp/bridge-sample",
    "orderedPaths": "bridge-sample"
  },
  "api.restoreAppData": {
    "confirmed": "bridge-sample"
  },
  "api.sceneAppendBrainstormNote": {
    "sceneId": "bridge-sample",
    "content": "bridge-sample-2"
  },
  "api.sceneCrafterAddCard": "bridge-sample",
  "api.sceneCrafterAddLane": {
    "storySlug": "bridge-sample",
    "name": "bridge-sample-2"
  },
  "api.sceneCrafterClose": {
    "storySlug": "bridge-sample"
  },
  "api.sceneCrafterCreateBoard": {
    "storyId": "bridge-sample",
    "storySlug": "bridge-sample-2"
  },
  "api.sceneCrafterDeleteCard": "bridge-sample",
  "api.sceneCrafterDeleteLane": "bridge-sample",
  "api.sceneCrafterGetBoard": {
    "storyId": "bridge-sample",
    "storySlug": "bridge-sample-2"
  },
  "api.sceneCrafterMoveCard": "bridge-sample",
  "api.sceneCrafterRenameLane": "bridge-sample",
  "api.sceneCrafterReorderLanes": "bridge-sample",
  "api.sceneCrafterSaveBoard": "bridge-sample",
  "api.sceneCrafterSuggestionAccept": {
    "suggestionId": "bridge-sample",
    "actor": "bridge-sample-2"
  },
  "api.sceneCrafterSuggestionReject": {
    "suggestionId": "bridge-sample",
    "actor": "bridge-sample-2"
  },
  "api.sceneCrafterToggleCardDone": "bridge-sample",
  "api.sceneCreate": "bridge-sample",
  "api.scenePropsGet": {
    "sceneId": "bridge-sample"
  },
  "api.scenePropsSet": {
    "sceneId": "bridge-sample",
    "customFields": "bridge-sample-2"
  },
  "api.sceneRename": "bridge-sample",
  "api.sceneSave": "bridge-sample",
  "api.sceneSetTags": "bridge-sample",
  "api.searchVault": {
    "query": "/tmp/bridge-sample",
    "scope": "bridge-sample",
    "limit": "bridge-sample-2",
    "filterTags": "bridge-sample-2"
  },
  "api.sessionSaveScene": "bridge-sample",
  "api.setAgentConfig": {
    "agent": "bridge-sample",
    "config": "bridge-sample-2"
  },
  "api.settingsSet": {
    "0": "b",
    "1": "r",
    "2": "i",
    "3": "d",
    "4": "g",
    "5": "e",
    "6": "-",
    "7": "s",
    "8": "a",
    "9": "m",
    "10": "p",
    "11": "l",
    "12": "e",
    "13": "-",
    "14": "2",
    "settings": "bridge-sample"
  },
  "api.settingsTestConnection": {
    "provider": "bridge-sample"
  },
  "api.smartFolderCreate": {
    "name": "bridge-sample",
    "query": "bridge-sample-2"
  },
  "api.smartFolderDelete": {
    "id": "bridge-sample"
  },
  "api.smartFolderQuery": {
    "query": "bridge-sample"
  },
  "api.smartFolderUpdate": {
    "0": "b",
    "1": "r",
    "2": "i",
    "3": "d",
    "4": "g",
    "5": "e",
    "6": "-",
    "7": "s",
    "8": "a",
    "9": "m",
    "10": "p",
    "11": "l",
    "12": "e",
    "13": "-",
    "14": "2",
    "id": "bridge-sample"
  },
  "api.snapshotDelete": {
    "sceneId": "bridge-id-a",
    "snapshotId": "bridge-id-b"
  },
  "api.snapshotDeleteAll": {
    "sceneId": "bridge-id-a"
  },
  "api.snapshotGet": {
    "sceneId": "bridge-id-a",
    "snapshotId": "bridge-id-b"
  },
  "api.snapshotList": {
    "sceneId": "bridge-id-a"
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
    "format": "bridge-sample",
    "filePath": "bridge-sample-2"
  },
  "api.storyStashRestore": "bridge-sample",
  "api.storyStashSave": "bridge-sample",
  "api.storyVaultRegistryCreate": "/tmp/bridge-sample",
  "api.storyVaultRegistryPair": {
    "storyVaultId": "/tmp/bridge-sample",
    "notesVaultId": "bridge-sample"
  },
  "api.storyVaultRegistryRename": {
    "id": "/tmp/bridge-sample",
    "displayName": "bridge-sample"
  },
  "api.storyVaultRegistrySetActive": {
    "id": "/tmp/bridge-sample"
  },
  "api.streamAck": {
    "streamId": "bridge-id",
    "count": 7
  },
  "api.streamCancel": {
    "streamId": "bridge-sample"
  },
  "api.streamStart": "bridge-sample",
  "api.suggestionsAccept": {
    "id": "bridge-sample",
    "actor": "bridge-sample-2"
  },
  "api.suggestionsBatchAction": "bridge-sample",
  "api.suggestionsGet": {
    "id": "bridge-sample"
  },
  "api.suggestionsIgnore": {
    "id": "bridge-sample",
    "actor": "bridge-sample-2"
  },
  "api.suggestionsList": {
    "0": "b",
    "1": "r",
    "2": "i",
    "3": "d",
    "4": "g",
    "5": "e",
    "6": "-",
    "7": "s",
    "8": "a",
    "9": "m",
    "10": "p",
    "11": "l",
    "12": "e",
    "13": "-",
    "14": "2",
    "status": "bridge-sample",
    "sourceAgent": "bridge-sample-2"
  },
  "api.suggestionsReject": {
    "id": "bridge-sample",
    "reason": "bridge-sample-2",
    "actor": "bridge-sample-2"
  },
  "api.suggestionsRollback": {
    "id": "bridge-sample",
    "actor": "bridge-sample-2"
  },
  "api.suggestionsSearch": "bridge-sample",
  "api.suggestionsUnifiedList": "bridge-sample",
  "api.suggestionsUpsert": {
    "suggestion": "bridge-sample"
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
    "id": "bridge-sample"
  },
  "api.tagsForItem": {
    "itemId": "bridge-sample",
    "itemKind": "bridge-sample-2"
  },
  "api.tagsItemsForTag": {
    "tagName": "bridge-sample"
  },
  "api.tagsRename": {
    "id": "bridge-sample",
    "name": "bridge-sample-2"
  },
  "api.tagsSetForItem": {
    "itemId": "bridge-sample",
    "itemKind": "bridge-sample-2",
    "tags": "bridge-sample-2"
  },
  "api.tagsUpsert": {
    "name": "bridge-sample",
    "color": "bridge-sample-2"
  },
  "api.telemetryReport": {
    "type": "bridge-sample",
    "meta": "bridge-sample-2"
  },
  "api.templateDelete": {
    "id": "bridge-sample"
  },
  "api.templateDuplicate": {
    "id": "bridge-sample"
  },
  "api.templateExport": {
    "id": "bridge-sample"
  },
  "api.templateImportFromPath": {
    "filePath": "/tmp/bridge-sample"
  },
  "api.templateRename": {
    "id": "bridge-sample",
    "name": "bridge-sample-2"
  },
  "api.templateSaveAs": {
    "name": "bridge-sample"
  },
  "api.templateScaffold": {
    "templateId": "bridge-sample",
    "parentToken": "bridge-sample-2"
  },
  "api.timelineGetScenes": {
    "storyId": "bridge-sample"
  },
  "api.timelineGetSettings": {
    "storyId": "bridge-sample"
  },
  "api.timelineInfer": {
    "storyId": "bridge-sample"
  },
  "api.timelineList": {},
  "api.timelineListArcs": {},
  "api.timelineProposalResolve": {
    "proposalId": "bridge-sample",
    "decision": "bridge-sample-2"
  },
  "api.timelineProposalsGenerate": {
    "storyId": "bridge-sample"
  },
  "api.timelineProposalsList": {
    "storyId": "bridge-sample"
  },
  "api.timelineRebuild": {},
  "api.timelineSaveSettings": {
    "settings": "bridge-sample",
    "storyId": "bridge-sample-2"
  },
  "api.timelineUpdateArcColor": {
    "arcId": "bridge-sample",
    "color": "bridge-sample-2",
    "colorIsCustom": "bridge-sample-2"
  },
  "api.timelineUpdateScene": "bridge-sample",
  "api.timelineUpsert": "bridge-sample",
  "api.timelinesDeleteItem": "bridge-sample",
  "api.timelinesGetStore": {},
  "api.timelinesSetActive": {
    "timelineId": "bridge-sample"
  },
  "api.timelinesUpsert": "bridge-sample",
  "api.timelinesUpsertItem": "bridge-sample",
  "api.validatePath": {
    "path": "/tmp/bridge-sample"
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
    "srcPath": "bridge-sample"
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
    "mythosVaultRoot": "/tmp/bridge-sample"
  },
  "api.vaultSurfaceHide": "/tmp/bridge-sample",
  "api.vaultSurfaceMoveVaultsParent": {
    "newParentPath": "/tmp/bridge-sample"
  },
  "api.vaultSurfaceRevealMythos": {
    "mythosVaultRoot": "/tmp/bridge-sample"
  },
  "api.vaultSurfaceTrash": "/tmp/bridge-sample",
  "api.vaultSurfaceUnhide": {
    "vaultRoot": "/tmp/bridge-sample"
  },
  "api.versionGet": {
    "sceneId": "bridge-id-a",
    "ts": "bridge-id-b"
  },
  "api.versionList": {
    "sceneId": "bridge-id-a"
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
    "text": "bridge-sample",
    "voiceId": "bridge-sample-2"
  },
  "api.voiceSpeakCancel": {
    "speakId": "bridge-id"
  },
  "api.voiceStart": {
    "micDeviceId": "bridge-sample"
  },
  "api.voiceStop": {
    "sessionId": "bridge-sample"
  },
  "api.voiceTranscribe": {
    "audio": "bridge-sample",
    "mimeType": "bridge-sample-2",
    "language": "bridge-sample-2"
  },
  "api.writeManifest": {
    "manifest": "/tmp/bridge-sample"
  },
  "api.writeNotesVault": {
    "path": "/tmp/bridge-sample",
    "content": "bridge-sample"
  },
  "api.writeVault": {
    "path": "/tmp/bridge-sample",
    "content": "bridge-sample"
  },
  "api.writingAssistant": {
    "manuscript": "bridge-sample",
    "scenePath": "bridge-sample-2"
  },
  "api.writingAssistantCadenceChange": "bridge-sample",
  "api.writingAssistantScanNow": "bridge-sample",
  "api.writingAssistantSetActiveScene": "bridge-sample",
  "api.writingAssistantSuggestionList": "bridge-sample",
  "api.writingAssistantTipDecision": "bridge-sample",
  "api.writingModeSet": "bridge-sample",
  "api.writingScan": {
    "sceneId": "bridge-sample",
    "prose": "bridge-sample-2",
    "scenePath": "bridge-sample-2"
  },
  "mythosIPC.archive": {
    "manuscript": "bridge-sample",
    "vaultPath": "bridge-sample-2"
  },
  "mythosIPC.brainstormer": {
    "topic": "bridge-sample",
    "context": "bridge-sample-2"
  },
  "mythosIPC.deleteVaultFile": {
    "path": "/tmp/bridge-sample"
  },
  "mythosIPC.listVaultFiles": {
    "root": "/tmp/bridge-sample"
  },
  "mythosIPC.readVaultFile": {
    "path": "/tmp/bridge-sample"
  },
  "mythosIPC.writeManifest": {
    "manifest": "/tmp/bridge-sample"
  },
  "mythosIPC.writeVaultFile": {
    "path": "/tmp/bridge-sample",
    "content": "bridge-sample"
  },
  "mythosIPC.writingAssistant": {
    "manuscript": "bridge-sample",
    "scenePath": "bridge-sample-2"
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
  if (
    row.channel.includes('version:') ||
    row.channel.includes('drafts') ||
    row.channel.includes('snapshot:')
  ) {
    return Array.from({ length: n }, (_, i) => ORDERED_IDS[i] ?? SAMPLE.str);
  }
  if (
    row.path.includes('Vault') ||
    row.path.includes('Path') ||
    row.path.endsWith('Folder') ||
    row.channel.startsWith('vault:') ||
    row.channel.startsWith('notesVault:') ||
    row.channel.startsWith('notesThumb:')
  ) {
    return Array.from({ length: n }, (_, i) => (i === 0 ? SAMPLE.path : i === 1 ? SAMPLE.str : SAMPLE.str2));
  }
  return Array.from({ length: n }, (_, i) => (i === 0 ? SAMPLE.str : SAMPLE.str2));
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

      const cb = vi.fn<() => void>();
      const unsub = (fn as (listener: () => void) => () => void)(cb);
      expect(typeof unsub).toBe('function');
      expect(onMock).toHaveBeenCalledTimes(1);
      const onCall = firstIpcMockCall(onMock);
      expect(onCall[0]).toBe(row.channel);
      const handler = onCall[1];
      expect(typeof handler).toBe('function');

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
