// Snapshot, rollback, and one-shot undo owned by vaultTransaction.
// These tests call the module directly. renameCascade.test.ts keeps its
// expectations and still covers the cascade that decides what text changes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rewriteWikiLinksForRename } from '@mythos-writer/shared/wikiLinkRename';
import { writeVaultFileAtomic } from './vault.js';
import { symlinkSkipLine } from './vault/writeErrors.js';
import { VaultWriteRefusedError } from './vault/noFollowWrite.js';
import {
  applyVaultTransaction,
  undoVaultTransaction,
  _resetVaultTransactionState,
  type VaultWriter,
} from './vaultTransaction.js';

let notesRoot: string;
let storyRoot: string;

function writeNote(relPath: string, content: string) {
  const full = path.join(notesRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function writeScene(relPath: string, content: string) {
  const full = path.join(storyRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function readNote(relPath: string): string {
  return fs.readFileSync(path.join(notesRoot, relPath), 'utf-8');
}

function readScene(relPath: string): string {
  return fs.readFileSync(path.join(storyRoot, relPath), 'utf-8');
}

function bytesEqual(root: string, relPath: string, text: string): boolean {
  return fs.readFileSync(path.join(root, relPath)).equals(Buffer.from(text, 'utf-8'));
}

beforeEach(() => {
  notesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tx-notes-'));
  storyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tx-story-'));
  _resetVaultTransactionState();
});

afterEach(() => {
  fs.rmSync(notesRoot, { recursive: true, force: true });
  fs.rmSync(storyRoot, { recursive: true, force: true });
});

describe('vaultTransaction', () => {
  it('refuses undo immediately when the undo slot was reset', () => {
    writeNote('Jasper Thorne.md', 'x');
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [],
    });
    _resetVaultTransactionState();
    const refused = undoVaultTransaction({ notesRoot, storyRoot });
    expect(refused.response.undone).toBe(false);
    expect(refused.response.reason).toBe('Nothing to undo.');
    expect(refused.response.restoredNotesPaths).toEqual([]);
    expect(refused.response.restoredStoryPaths).toEqual([]);
    expect(refused.conflicts).toEqual([]);
  });
  it('surfaces rollback failures when restore after a mid-cascade error also fails', () => {
    writeNote('Jasper Thorne.md', 'j');
    writeNote('Allies.md', 'a');
    writeNote('B.md', 'b');
    let calls = 0;
    const flaky: VaultWriter = (r, rel, content) => {
      calls += 1;
      if (calls === 2) throw new Error('write boom');
      if (calls === 3) throw new Error('rollback also failed');
      writeVaultFileAtomic(r, rel, content);
    };
    expect(() =>
      applyVaultTransaction({
        notesRoot,
        storyRoot,
        fromPath: 'Jasper.md',
        toPath: 'Jasper Thorne.md',
        oldStem: 'Jasper',
        newStem: 'Jasper Thorne',
        changes: [
          {
            side: 'notes',
            kind: 'note',
            relPath: 'Allies.md',
            newContent: 'a2',
            linkCount: 0,
            mode: 'update-display',
          },
          {
            side: 'notes',
            kind: 'note',
            relPath: 'B.md',
            newContent: 'b2',
            linkCount: 0,
            mode: 'update-display',
          },
        ],
        writeFile: flaky,
      }),
    ).toThrow(/could not be restored/);
  });

  it('reports rename cascade progress while applying', () => {
    writeNote('Jasper Thorne.md', 'body');
    writeNote('Allies.md', 'a');
    writeNote('B.md', 'b');
    const progress: number[] = [];
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: 'a2',
          linkCount: 0,
          mode: 'update-display',
        },
        {
          side: 'notes',
          kind: 'note',
          relPath: 'B.md',
          newContent: 'b2',
          linkCount: 0,
          mode: 'update-display',
        },
      ],
      onProgress: (p) => progress.push(p.current),
    });
    expect(progress).toEqual([1, 2]);
  });

  it('snapshots every file before any write', () => {
    const alliesOriginal = 'See [[Jasper]] for details.';
    const sceneOriginal = 'Then [[Jasper]] arrived.';
    const alliesNext = 'See [[Jasper Thorne]] for details.';
    const sceneNext = 'Then [[Jasper Thorne|Jasper]] arrived.';
    writeNote('Allies.md', alliesOriginal);
    writeScene('Manuscript/01/scene-1.md', sceneOriginal);

    // The first content write clobbers the other planned file. A snapshot
    // taken after any write would record that clobber instead of the original.
    const writeFile: VaultWriter = (root, relPath, content) => {
      if (relPath === 'Allies.md') {
        fs.writeFileSync(path.join(storyRoot, 'Manuscript/01/scene-1.md'), 'clobbered-after-first-write', 'utf-8');
      }
      writeVaultFileAtomic(root, relPath, content);
    };

    const { files } = applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: alliesNext,
          linkCount: 1,
          mode: 'update-display',
        },
        {
          side: 'story',
          kind: 'note',
          relPath: 'Manuscript/01/scene-1.md',
          newContent: sceneNext,
          linkCount: 1,
          mode: 'preserve-display',
        },
      ],
      writeFile,
    });

    expect(files.map((f) => f.oldContent)).toEqual([alliesOriginal, sceneOriginal]);
    expect(readNote('Allies.md')).toBe(alliesNext);
    expect(readScene('Manuscript/01/scene-1.md')).toBe(sceneNext);
  });

  it('rolls back every file when a write fails mid-cascade', () => {
    writeNote('Jasper Thorne.md', 'The man himself.');
    writeNote('Allies.md', 'See [[Jasper]] for details.');
    writeNote('Enemies.md', 'Feared by [[Jasper|Jay]].');
    writeScene('Manuscript/01/scene-1.md', 'Then [[Jasper]] arrived.');

    let writes = 0;
    const failingWriter: VaultWriter = (root, relPath, content) => {
      writes++;
      if (writes === 3) throw new Error('disk full');
      writeVaultFileAtomic(root, relPath, content);
    };

    expect(() =>
      applyVaultTransaction({
        notesRoot,
        storyRoot,
        fromPath: 'Jasper.md',
        toPath: 'Jasper Thorne.md',
        oldStem: 'Jasper',
        newStem: 'Jasper Thorne',
        changes: [
          {
            side: 'notes',
            kind: 'note',
            relPath: 'Allies.md',
            newContent: 'See [[Jasper Thorne]] for details.',
            linkCount: 1,
            mode: 'update-display',
          },
          {
            side: 'notes',
            kind: 'note',
            relPath: 'Enemies.md',
            newContent: 'Feared by [[Jasper Thorne|Jay]].',
            linkCount: 1,
            mode: 'update-display',
          },
          {
            side: 'story',
            kind: 'note',
            relPath: 'Manuscript/01/scene-1.md',
            newContent: 'Then [[Jasper Thorne|Jasper]] arrived.',
            linkCount: 1,
            mode: 'preserve-display',
          },
        ],
        writeFile: failingWriter,
      }),
    ).toThrow(/rolled back/);

    expect(fs.existsSync(path.join(notesRoot, 'Jasper.md'))).toBe(true);
    expect(fs.existsSync(path.join(notesRoot, 'Jasper Thorne.md'))).toBe(false);
    expect(readNote('Jasper.md')).toBe('The man himself.');
    expect(readNote('Allies.md')).toBe('See [[Jasper]] for details.');
    expect(readNote('Enemies.md')).toBe('Feared by [[Jasper|Jay]].');
    expect(readScene('Manuscript/01/scene-1.md')).toBe('Then [[Jasper]] arrived.');
  });

  it('rolls back a story-side rewrite to the story root when the cascade fails on the next change', () => {
    writeNote('Jasper Thorne.md', 'note-body\n');
    writeNote('Allies.md', 'allies-v1\n');
    writeNote('B.md', 'b-v1\n');
    writeScene('Manuscript/01/scene-1.md', 'scene-v1\n');
    let writes = 0;
    const failAfterStory: VaultWriter = (root, relPath, content) => {
      writes += 1;
      writeVaultFileAtomic(root, relPath, content);
      if (writes === 3) throw new Error('stop after story and allies');
    };
    expect(() =>
      applyVaultTransaction({
        notesRoot,
        storyRoot,
        fromPath: 'Jasper.md',
        toPath: 'Jasper Thorne.md',
        oldStem: 'Jasper',
        newStem: 'Jasper Thorne',
        changes: [
          {
            side: 'notes',
            kind: 'note',
            relPath: 'Allies.md',
            newContent: 'allies-v2\n',
            linkCount: 0,
            mode: 'update-display',
          },
          {
            side: 'story',
            kind: 'note',
            relPath: 'Manuscript/01/scene-1.md',
            newContent: 'scene-v2\n',
            linkCount: 0,
            mode: 'preserve-display',
          },
          {
            side: 'notes',
            kind: 'note',
            relPath: 'B.md',
            newContent: 'b-v2\n',
            linkCount: 0,
            mode: 'update-display',
          },
        ],
        writeFile: failAfterStory,
      }),
    ).toThrow(/rolled back/);
    expect(readNote('Allies.md')).toBe('allies-v1\n');
    expect(readNote('B.md')).toBe('b-v1\n');
    expect(readScene('Manuscript/01/scene-1.md')).toBe('scene-v1\n');
    expect(bytesEqual(notesRoot, 'Allies.md', 'allies-v1\n')).toBe(true);
    expect(bytesEqual(notesRoot, 'B.md', 'b-v1\n')).toBe(true);
    expect(bytesEqual(storyRoot, 'Manuscript/01/scene-1.md', 'scene-v1\n')).toBe(true);
  });

  it('omits skippedSymlinks from the response when every file restored cleanly', () => {
    writeNote('Jasper Thorne.md', 'self-v1\n');
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Jasper Thorne.md',
          newContent: 'self-v2\n',
          linkCount: 1,
          mode: 'update-display',
        },
      ],
    });
    const undo = undoVaultTransaction({ notesRoot, storyRoot });
    expect(undo.response.undone).toBe(true);
    expect(undo.response.skippedSymlinks).toBeUndefined();
    expect(bytesEqual(notesRoot, 'Jasper.md', 'self-v1\n')).toBe(true);
  });

  it('undo restores exact pre-write bytes', () => {
    // Not wikilinks: only the stored snapshot can put these bytes back.
    const noteOriginal = 'note-v1\n';
    const alliesOriginal = 'allies-v1\n';
    const sceneOriginal = 'scene-v1\n';
    writeNote('Jasper Thorne.md', noteOriginal);
    writeNote('Allies.md', alliesOriginal);
    writeScene('Manuscript/01/scene-1.md', sceneOriginal);

    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Jasper Thorne.md',
          newContent: 'note-v2\n',
          linkCount: 1,
          mode: 'update-display',
        },
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: 'allies-v2\n',
          linkCount: 1,
          mode: 'update-display',
        },
        {
          side: 'story',
          kind: 'note',
          relPath: 'Manuscript/01/scene-1.md',
          newContent: 'scene-v2\n',
          linkCount: 1,
          mode: 'preserve-display',
        },
      ],
    });

    const undo = undoVaultTransaction({ notesRoot, storyRoot });

    expect(undo.response.undone).toBe(true);
    expect(undo.response.filesRestored).toBe(3);
    expect(undo.conflicts).toEqual([]);
    expect(fs.existsSync(path.join(notesRoot, 'Jasper Thorne.md'))).toBe(false);
    expect(bytesEqual(notesRoot, 'Jasper.md', noteOriginal)).toBe(true);
    expect(bytesEqual(notesRoot, 'Allies.md', alliesOriginal)).toBe(true);
    expect(bytesEqual(storyRoot, 'Manuscript/01/scene-1.md', sceneOriginal)).toBe(true);
  });

  it('reverts only the touched span after a later edit and lists conflicts (SKY-10887)', () => {
    writeNote('Jasper Thorne.md', 'x');
    const sceneOriginal = 'Then [[Jasper]] arrived. The weather was calm.';
    const otherOriginal = '[[Jasper]] left.';
    writeScene('Manuscript/01/scene-1.md', sceneOriginal);
    writeScene('Manuscript/01/scene-2.md', otherOriginal);

    const sceneNext = rewriteWikiLinksForRename(sceneOriginal, 'Jasper', 'Jasper Thorne', 'preserve-display').content;
    const otherNext = rewriteWikiLinksForRename(otherOriginal, 'Jasper', 'Jasper Thorne', 'preserve-display').content;

    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'story',
          kind: 'note',
          relPath: 'Manuscript/01/scene-1.md',
          newContent: sceneNext,
          linkCount: 1,
          mode: 'preserve-display',
        },
        {
          side: 'story',
          kind: 'note',
          relPath: 'Manuscript/01/scene-2.md',
          newContent: otherNext,
          linkCount: 1,
          mode: 'preserve-display',
        },
      ],
    });

    const laterEdit = 'Then [[Jasper Thorne|Jasper]] arrived. The weather turned stormy without warning.';
    writeScene('Manuscript/01/scene-1.md', laterEdit);
    const conflictText = 'The visitor left without a trace.';
    writeScene('Manuscript/01/scene-2.md', conflictText);

    const undo = undoVaultTransaction({ notesRoot, storyRoot });

    expect(undo.response.undone).toBe(true);
    expect(readScene('Manuscript/01/scene-1.md')).toBe(
      'Then [[Jasper]] arrived. The weather turned stormy without warning.',
    );
    expect(undo.conflicts).toEqual([{ side: 'story', relPath: 'Manuscript/01/scene-2.md' }]);
    expect(readScene('Manuscript/01/scene-2.md')).toBe(conflictText);
    expect(undo.response.filesRestored).toBe(1);
    expect(undo.response.filesSkipped).toBe(undo.conflicts.length);
  });

  it('refuses undo for a different vault root, writes nothing, and clears the undo slot', () => {
    const alliesOriginal = 'allies-before';
    const alliesNext = 'allies-after';
    writeNote('Jasper Thorne.md', 'note-before');
    writeNote('Allies.md', alliesOriginal);
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: alliesNext,
          linkCount: 1,
          mode: 'update-display',
        },
      ],
    });

    const otherNotes = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tx-other-notes-'));
    const writes: string[] = [];
    const spy: VaultWriter = (root, relPath, content) => {
      writes.push(relPath);
      writeVaultFileAtomic(root, relPath, content);
    };
    try {
      const refused = undoVaultTransaction({
        notesRoot: otherNotes,
        storyRoot,
        writeFile: spy,
      });
      expect(refused.response.undone).toBe(false);
      expect(refused.response.reason).toBe('The project has changed since the rename.');
      expect(writes).toEqual([]);
      expect(fs.existsSync(path.join(notesRoot, 'Jasper Thorne.md'))).toBe(true);
      expect(fs.existsSync(path.join(notesRoot, 'Jasper.md'))).toBe(false);
      expect(readNote('Allies.md')).toBe(alliesNext);

      const again = undoVaultTransaction({ notesRoot, storyRoot, writeFile: spy });
      expect(again.response.undone).toBe(false);
      expect(again.response.reason).toBe('Nothing to undo.');
      expect(writes).toEqual([]);
      expect(readNote('Allies.md')).toBe(alliesNext);
      expect(fs.existsSync(path.join(notesRoot, 'Jasper Thorne.md'))).toBe(true);
    } finally {
      fs.rmSync(otherNotes, { recursive: true, force: true });
    }
  });

  it('refuses undo when the story vault root no longer matches the transaction', () => {
    writeNote('Jasper Thorne.md', 'body');
    writeNote('Allies.md', 'before');
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: 'after',
          linkCount: 0,
          mode: 'update-display',
        },
      ],
    });

    const otherStory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tx-other-story-'));
    try {
      const refused = undoVaultTransaction({ notesRoot, storyRoot: otherStory });
      expect(refused.response.undone).toBe(false);
      expect(refused.response.reason).toBe('The project has changed since the rename.');
      expect(readNote('Allies.md')).toBe('after');
      expect(fs.existsSync(path.join(notesRoot, 'Jasper Thorne.md'))).toBe(true);
    } finally {
      fs.rmSync(otherStory, { recursive: true, force: true });
    }
  });

  it('refuses undo when the renamed note was deleted after the cascade', () => {
    writeNote('Jasper Thorne.md', 'note');
    writeNote('Allies.md', '[[Jasper]]');
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: '[[Jasper Thorne]]',
          linkCount: 1,
          mode: 'update-display',
        },
      ],
    });
    fs.rmSync(path.join(notesRoot, 'Jasper Thorne.md'));

    const refused = undoVaultTransaction({ notesRoot, storyRoot });
    expect(refused.response.undone).toBe(false);
    expect(refused.response.reason).toBe('The renamed note has been moved or deleted.');
    expect(readNote('Allies.md')).toBe('[[Jasper Thorne]]');
  });

  it('refuses undo when a note already occupies the original path', () => {
    writeNote('Jasper Thorne.md', 'new');
    writeNote('Jasper.md', 'blocker');
    writeNote('Allies.md', 'x');
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: 'y',
          linkCount: 0,
          mode: 'update-display',
        },
      ],
    });

    const refused = undoVaultTransaction({ notesRoot, storyRoot });
    expect(refused.response.undone).toBe(false);
    expect(refused.response.reason).toBe('A note now exists under the original name.');
    expect(readNote('Jasper.md')).toBe('blocker');
    expect(fs.existsSync(path.join(notesRoot, 'Jasper Thorne.md'))).toBe(true);
  });

  it('lists symlinked files as skippedSymlinks instead of following them on undo', () => {
    let symlinksWork = true;
    try {
      const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-probe-'));
      fs.symlinkSync('t', path.join(probe, 'l'));
      fs.rmSync(probe, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOTSUP') symlinksWork = false;
      else throw err;
    }
    if (!symlinksWork) return;

    writeNote('Jasper Thorne.md', 'body');
    writeNote('Allies.md', 'See [[Jasper]]');
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: 'See [[Jasper Thorne]]',
          linkCount: 1,
          mode: 'update-display',
        },
      ],
    });

    const realBody = readNote('Allies.md');
    const backing = path.join(notesRoot, 'allies-backing.md');
    fs.writeFileSync(backing, realBody, 'utf-8');
    fs.rmSync(path.join(notesRoot, 'Allies.md'));
    fs.symlinkSync(backing, path.join(notesRoot, 'Allies.md'));

    const undo = undoVaultTransaction({ notesRoot, storyRoot });
    expect(undo.response.undone).toBe(true);
    expect(undo.response.skippedSymlinks).toEqual([symlinkSkipLine('Allies.md')]);
    expect(fs.readFileSync(backing, 'utf-8')).toBe('See [[Jasper Thorne]]');
    expect(fs.existsSync(path.join(notesRoot, 'Jasper.md'))).toBe(true);
    expect(undo.response.filesRestored).toBe(0);
    expect(undo.response.filesSkipped).toBe(1);
  });

  it('undo span-reverts a board sidecar ref after a later manual edit (kind: board)', () => {
    const sidecarDir = path.join(notesRoot, 'Worldbuilding');
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(
      path.join(sidecarDir, '.mythos-board.json'),
      JSON.stringify({
        version: 2,
        id: 'board-1',
        updated: new Date(0).toISOString(),
        layout: {},
        colors: {},
        furniture: [{ id: 'x1', k: 'column', x: 0, y: 0, items: [{ t: 'J', ref: 'Jasper.md' }] }],
        view: { zoom: 100, panX: 0, panY: 0 },
      }),
      'utf-8',
    );
    writeNote('Jasper Thorne.md', 'body');
    const updated = JSON.stringify({
      version: 2,
      id: 'board-1',
      updated: new Date(0).toISOString(),
      layout: {},
      colors: {},
      furniture: [{ id: 'x1', k: 'column', x: 0, y: 0, items: [{ t: 'J', ref: 'Jasper Thorne.md' }] }],
      view: { zoom: 100, panX: 0, panY: 0 },
    });
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'board',
          relPath: 'Worldbuilding/.mythos-board.json',
          newContent: updated,
          linkCount: 1,
          mode: 'update-display',
        },
      ],
    });

    const edited = JSON.stringify({
      version: 2,
      id: 'board-1',
      updated: new Date(0).toISOString(),
      layout: {},
      colors: {},
      furniture: [{ id: 'x1', k: 'column', x: 0, y: 0, items: [{ t: 'J', ref: 'Jasper Thorne.md', edited: true }] }],
      view: { zoom: 100, panX: 0, panY: 0 },
    });
    fs.writeFileSync(path.join(sidecarDir, '.mythos-board.json'), edited, 'utf-8');

    const undo = undoVaultTransaction({ notesRoot, storyRoot });
    expect(undo.response.undone).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(path.join(sidecarDir, '.mythos-board.json'), 'utf-8')) as {
      furniture: Array<{ items?: Array<{ ref?: string }> }>;
    };
    expect(parsed.furniture[0]!.items![0]!.ref).toBe('Jasper.md');
    expect(JSON.parse(fs.readFileSync(path.join(sidecarDir, '.mythos-board.json'), 'utf-8')).furniture[0]).toMatchObject({
      items: [{ ref: 'Jasper.md', edited: true }],
    });
  });

  it('records a write refusal during undo as a conflict without following a symlink target', () => {
    let symlinksWork = true;
    try {
      const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-probe-'));
      fs.symlinkSync('t', path.join(probe, 'l'));
      fs.rmSync(probe, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOTSUP') symlinksWork = false;
      else throw err;
    }
    if (!symlinksWork) return;

    writeNote('Jasper Thorne.md', 'body');
    writeNote('Allies.md', '[[Jasper]]');
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: '[[Jasper Thorne]]',
          linkCount: 1,
          mode: 'update-display',
        },
      ],
    });

    const undo = undoVaultTransaction({
      notesRoot,
      storyRoot,
      writeFile: () => {
        throw new VaultWriteRefusedError('LEAF_LINK', 'Allies.md');
      },
    });
    expect(undo.response.undone).toBe(true);
    expect(undo.conflicts).toContainEqual({ side: 'notes', relPath: 'Allies.md' });
    expect(undo.response.skippedSymlinks).toEqual([symlinkSkipLine('Allies.md')]);
  });

  it('undo fills restoredNotesPaths and restoredStoryPaths with the paths actually rewritten', () => {
    writeNote('Jasper Thorne.md', 'self\n');
    writeNote('Allies.md', 'allies-v1\n');
    writeScene('Manuscript/01/scene-1.md', 'scene-v1\n');
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: 'allies-v2\n',
          linkCount: 1,
          mode: 'update-display',
        },
        {
          side: 'story',
          kind: 'note',
          relPath: 'Manuscript/01/scene-1.md',
          newContent: 'scene-v2\n',
          linkCount: 1,
          mode: 'preserve-display',
        },
      ],
    });
    const undo = undoVaultTransaction({ notesRoot, storyRoot });
    expect(undo.response.undone).toBe(true);
    expect(undo.response.restoredNotesPaths).toEqual(['Allies.md']);
    expect(undo.response.restoredStoryPaths).toEqual(['Manuscript/01/scene-1.md']);
    expect(readNote('Allies.md')).toBe('allies-v1\n');
    expect(readScene('Manuscript/01/scene-1.md')).toBe('scene-v1\n');
  });

  it('undo writes the renamed note back to fromPath when the transaction touched that file', () => {
    const renamedWas = 'renamed-self-v1\n';
    const renamedNext = 'renamed-self-v2\n';
    writeNote('Jasper Thorne.md', renamedWas);
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Jasper Thorne.md',
          newContent: renamedNext,
          linkCount: 0,
          mode: 'update-display',
        },
      ],
    });
    expect(readNote('Jasper Thorne.md')).toBe(renamedNext);
    const undo = undoVaultTransaction({ notesRoot, storyRoot });
    expect(undo.response.undone).toBe(true);
    expect(undo.response.restoredNotesPaths).toContain('Jasper.md');
    expect(fs.existsSync(path.join(notesRoot, 'Jasper Thorne.md'))).toBe(false);
    expect(bytesEqual(notesRoot, 'Jasper.md', renamedWas)).toBe(true);
  });

  it('throws the rollback-only message when a write fails but rollback succeeds', () => {
    writeNote('Jasper Thorne.md', 'j');
    writeNote('Allies.md', 'a');
    writeNote('B.md', 'b');
    let calls = 0;
    const flaky: VaultWriter = (r, rel, content) => {
      calls += 1;
      if (calls === 2) throw new Error('fail on second write');
      writeVaultFileAtomic(r, rel, content);
    };
    expect(() =>
      applyVaultTransaction({
        notesRoot,
        storyRoot,
        fromPath: 'Jasper.md',
        toPath: 'Jasper Thorne.md',
        oldStem: 'Jasper',
        newStem: 'Jasper Thorne',
        changes: [
          {
            side: 'notes',
            kind: 'note',
            relPath: 'Allies.md',
            newContent: 'a2',
            linkCount: 0,
            mode: 'update-display',
          },
          {
            side: 'notes',
            kind: 'note',
            relPath: 'B.md',
            newContent: 'b2',
            linkCount: 0,
            mode: 'update-display',
          },
        ],
        writeFile: flaky,
      }),
    ).toThrow(/no changes were kept/);
    expect(readNote('Allies.md')).toBe('a');
    expect(readNote('B.md')).toBe('b');
  });

  it('undo counts a missing rewritten file as skipped with a conflict entry', () => {
    writeNote('Jasper Thorne.md', 'body');
    writeNote('Allies.md', '[[Jasper]]');
    applyVaultTransaction({
      notesRoot,
      storyRoot,
      fromPath: 'Jasper.md',
      toPath: 'Jasper Thorne.md',
      oldStem: 'Jasper',
      newStem: 'Jasper Thorne',
      changes: [
        {
          side: 'notes',
          kind: 'note',
          relPath: 'Allies.md',
          newContent: '[[Jasper Thorne]]',
          linkCount: 1,
          mode: 'update-display',
        },
      ],
    });
    fs.rmSync(path.join(notesRoot, 'Allies.md'));
    const undo = undoVaultTransaction({ notesRoot, storyRoot });
    expect(undo.response.undone).toBe(true);
    expect(undo.response.filesRestored).toBe(0);
    expect(undo.response.filesSkipped).toBe(1);
    expect(undo.conflicts).toEqual([{ side: 'notes', relPath: 'Allies.md' }]);
    expect(fs.existsSync(path.join(notesRoot, 'Jasper.md'))).toBe(true);
  });

  it('rolls back the rename and does not recreate a file deleted after planning', () => {
    writeNote('Jasper Thorne.md', 'The man himself.');
    writeNote('Allies.md', 'See [[Jasper]] for details.');
    writeNote('Enemies.md', 'Feared by [[Jasper|Jay]].');
    const planned = [
      {
        side: 'notes' as const,
        kind: 'note' as const,
        relPath: 'Allies.md',
        newContent: 'See [[Jasper Thorne]] for details.',
        linkCount: 1,
        mode: 'update-display' as const,
      },
      {
        side: 'notes' as const,
        kind: 'note' as const,
        relPath: 'Enemies.md',
        newContent: 'Feared by [[Jasper Thorne|Jay]].',
        linkCount: 1,
        mode: 'update-display' as const,
      },
    ];
    fs.rmSync(path.join(notesRoot, 'Enemies.md'));

    expect(() =>
      applyVaultTransaction({
        notesRoot,
        storyRoot,
        fromPath: 'Jasper.md',
        toPath: 'Jasper Thorne.md',
        oldStem: 'Jasper',
        newStem: 'Jasper Thorne',
        changes: planned,
      }),
    ).toThrow(/rolled back/);

    expect(fs.existsSync(path.join(notesRoot, 'Jasper.md'))).toBe(true);
    expect(fs.existsSync(path.join(notesRoot, 'Jasper Thorne.md'))).toBe(false);
    expect(readNote('Jasper.md')).toBe('The man himself.');
    expect(readNote('Allies.md')).toBe('See [[Jasper]] for details.');
    expect(fs.existsSync(path.join(notesRoot, 'Enemies.md'))).toBe(false);
  });
});
