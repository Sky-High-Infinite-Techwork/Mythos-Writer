// SKY-11189 (Notes Board 6/9): unit coverage for the deferred-delete pending
// registry — trash/restore/flush/invalidate. Real filesystem via
// fs.mkdtempSync (matching notesBoard.test.ts's pattern); `electron`'s
// `shell` is mocked (matching vaultSurface.test.ts's pattern) so flush can be
// asserted without touching a real OS trash.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock is hoisted — factory must not reference outer variables.
vi.mock('electron', () => ({
  shell: {
    trashItem: vi.fn(),
  },
}));

// Imports come AFTER vi.mock so the hoisted mock applies.
import { shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  UNDO_WINDOW_MS,
  trashTargets,
  restoreEntry,
  listPendingForVault,
  emptyTrash,
  flushAllPendingNotesTrash,
  invalidatePendingUnderPath,
  isVaultRelPathPending,
  isFurniturePending,
  resetNotesTrashForTests,
  notesTrashPathSeams,
  notesTrashGroupSeams,
  notesTrashFlushSeams,
} from './notesTrash.js';
import { getBoard, patchLayout, flushPendingNotesBoardWrites, furnitureCreate } from './notesBoard.js';
import { readIconMap, writeIconMap } from './vaultIcons.js';

const mockTrashItem = vi.mocked(shell.trashItem);

function writeNote(root: string, relPath: string, content = ''): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('notesTrash path seams', () => {
  it('splitVaultRelPath, vaultRelJoin, and depth stay inverse for nested and root paths', () => {
    expect(notesTrashPathSeams.splitVaultRelPath('Root.md')).toEqual({
      parentRelPath: '',
      itemName: 'Root.md',
    });
    expect(notesTrashPathSeams.splitVaultRelPath('World/Places/City.md')).toEqual({
      parentRelPath: 'World/Places',
      itemName: 'City.md',
    });
    expect(notesTrashPathSeams.vaultRelJoin('World', 'City.md')).toBe('World/City.md');
    expect(notesTrashPathSeams.vaultRelJoin('', 'Solo.md')).toBe('Solo.md');
    expect(notesTrashPathSeams.depth('A/B/C')).toBe(3);
    expect(notesTrashPathSeams.depth('solo')).toBe(1);
  });
});

describe('notesTrash group seams', () => {
  let seamRoot: string;

  beforeEach(() => {
    seamRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-notestrash-seam-'));
  });

  afterEach(() => {
    fs.rmSync(seamRoot, { recursive: true, force: true });
  });

  it('isAncestorOrSame treats equality and strict-prefix paths as overlapping', () => {
    const { isAncestorOrSame } = notesTrashGroupSeams;
    expect(isAncestorOrSame('/vault/Board', '/vault/Board')).toBe(true);
    expect(isAncestorOrSame('/vault/Board', '/vault/Board/Card.md')).toBe(true);
    expect(isAncestorOrSame('/vault/Other', '/vault/Board/Card.md')).toBe(false);
  });

  it('groupRoots collapses descendant paths to minimal ancestor roots', () => {
    const { groupRoots } = notesTrashGroupSeams;
    const roots = groupRoots({
      id: 'g',
      vaultRoot: seamRoot,
      entries: [
        { vaultRoot: seamRoot, vaultRelPath: 'Board/Sub/Card.md' },
        { vaultRoot: seamRoot, vaultRelPath: 'Board' },
        { vaultRoot: seamRoot, vaultRelPath: 'Other.md' },
      ] as import('./notesTrash.js').PendingEntry[],
      timer: setTimeout(() => {}, 1),
      flushing: false,
    });
    expect(roots.map((p) => path.relative(seamRoot, p)).sort()).toEqual(['Board', 'Other.md'].sort());
  });

  it('overlapChains merges groups that touch the same subtree', () => {
    const { overlapChains } = notesTrashGroupSeams;
    const mk = (id: string, paths: string[]) => ({
      id,
      vaultRoot: seamRoot,
      entries: paths.map((vaultRelPath) => ({
        vaultRoot: seamRoot,
        vaultRelPath,
      })) as import('./notesTrash.js').PendingEntry[],
      timer: setTimeout(() => {}, 1),
      flushing: false,
    });
    const chains = overlapChains([
      mk('ancestor', ['Board']),
      mk('descendant', ['Board/Card.md']),
      mk('unrelated', ['Loose.md']),
    ]);
    expect(chains).toHaveLength(2);
    const merged = chains.find((c) => c.length === 2)!;
    expect(merged.map((g) => g.id).sort()).toEqual(['ancestor', 'descendant']);
    const solo = chains.find((c) => c.length === 1)!;
    expect(solo[0]!.id).toBe('unrelated');
  });

  it('groupDepth returns the shallowest vault-relative path depth in a group', () => {
    const { groupDepth } = notesTrashGroupSeams;
    expect(
      groupDepth({
        id: 'g',
        vaultRoot: '/v',
        entries: [
          { vaultRelPath: 'Board/Sub/Deep.md' },
          { vaultRelPath: 'Board' },
        ] as import('./notesTrash.js').PendingEntry[],
        timer: setTimeout(() => {}, 1),
        flushing: false,
      }),
    ).toBe(1);
    expect(
      groupDepth({
        id: 'g2',
        vaultRoot: '/v',
        entries: [{ kind: 'furniture', furnitureId: 'x' }] as import('./notesTrash.js').PendingEntry[],
        timer: setTimeout(() => {}, 1),
        flushing: false,
      }),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('notesTrash', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-notestrash-'));
    vi.useFakeTimers();
    mockTrashItem.mockReset();
    // Real shell.trashItem actually removes the path (that's the whole
    // point) — the mock does the same so flush-time "is this descendant
    // already gone" logic has something real to observe, instead of always
    // finding the file still there because the mock is a no-op.
    //
    // SKY-11742: the removal MUST be deferred past an async boundary. Real
    // shell.trashItem is a genuine async OS move and never settles in the
    // turn it was called in; a mock that calls the synchronous fs.rmSync
    // straight down its body settles before it even returns, which let a
    // caller that fired every entry off concurrently still observe an
    // ancestor as already-gone. That made the ancestor-skip assertions below
    // pass by coincidence rather than because flushGroup serializes. Defer
    // here and those assertions can actually fail if the serialization
    // regresses. process.nextTick (not setTimeout) because these tests run
    // on fake timers — nextTick is not faked, so the mock stays independent
    // of whichever advanceTimers* call is driving the flush.
    mockTrashItem.mockImplementation(async (target: string) => {
      await new Promise<void>((resolve) => { process.nextTick(resolve); });
      fs.rmSync(target, { recursive: true, force: true });
    });
    resetNotesTrashForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetNotesTrashForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hides a trashed note immediately, and leaves the file untouched on disk (crash-safety by construction)', () => {
    writeNote(root, 'Idea.md', 'hello\n');
    trashTargets(root, '', [{ kind: 'note', itemPath: 'Idea.md', label: 'Idea.md' }]);

    expect(isVaultRelPathPending(root, 'Idea.md')).toBe(true);
    // Nothing physically happens until flush — this IS the crash-safety
    // guarantee (§8): a process death right here leaves the file exactly as
    // it was, with nothing to roll back.
    expect(fs.existsSync(path.join(root, 'Idea.md'))).toBe(true);
    expect(mockTrashItem).not.toHaveBeenCalled();
  });

  it('flushes to shell.trashItem once the undo window elapses, and drops off the pending list (§15 test 8)', async () => {
    writeNote(root, 'Idea.md', 'hello\n');
    trashTargets(root, '', [{ kind: 'note', itemPath: 'Idea.md', label: 'Idea.md' }]);

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);

    expect(mockTrashItem).toHaveBeenCalledWith(path.join(root, 'Idea.md'));
    expect(isVaultRelPathPending(root, 'Idea.md')).toBe(false);
    expect(listPendingForVault(root)).toEqual([]);
  });

  it('Ctrl+Z before the window elapses restores it — un-hidden, never trashed (§15 test 8)', async () => {
    writeNote(root, 'Idea.md', 'hello\n');
    const { entries } = trashTargets(root, '', [{ kind: 'note', itemPath: 'Idea.md', label: 'Idea.md' }]);

    const result = restoreEntry(entries[0]!.id);
    expect(result.restored).toBe(true);
    expect(isVaultRelPathPending(root, 'Idea.md')).toBe(false);

    // Even if the original timer somehow still fired, restoreEntry already
    // cleared it — advancing past the window must not trash it after the fact.
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(mockTrashItem).not.toHaveBeenCalled();
  });

  it('preserves the item\'s own layout entry through the pending window, so a restore lands it back at the same position', () => {
    writeNote(root, 'Idea.md', 'hello\n');
    const { id } = patchLayout(root, '', 'Idea.md', { x: 10, y: 20 });
    flushPendingNotesBoardWrites(root);

    trashTargets(root, '', [{ kind: 'note', itemPath: 'Idea.md', label: 'Idea.md' }]);

    const board = getBoard(root, '');
    // getBoard doesn't know about pending state itself (that's a main.ts-level
    // filter) — the layout entry must still be sitting there, untouched.
    expect(board.layout[`n:${id}`]).toEqual({ x: 10, y: 20 });
  });

  it('trashing a folder cascades every live descendant into the SAME restore group (§15 test 9)', () => {
    writeNote(root, 'Board/Card A.md');
    writeNote(root, 'Board/Sub/Card B.md');
    const { entries } = trashTargets(root, '', [{ kind: 'folder', itemPath: 'Board', label: 'Board' }]);

    // The folder itself + both descendants each get their OWN entry...
    const paths = entries.map((e) => e.vaultRelPath).sort();
    expect(paths).toEqual(['Board', 'Board/Card A.md', 'Board/Sub', 'Board/Sub/Card B.md'].sort());
    // ...but they all share one group, so restoring any one restores all.
    const groupIds = new Set(entries.map((e) => e.groupId));
    expect(groupIds.size).toBe(1);

    expect(isVaultRelPathPending(root, 'Board')).toBe(true);
    expect(isVaultRelPathPending(root, 'Board/Card A.md')).toBe(true);
    expect(isVaultRelPathPending(root, 'Board/Sub/Card B.md')).toBe(true);

    const restored = restoreEntry(entries.find((e) => e.vaultRelPath === 'Board/Card A.md')!.id);
    expect(restored.restored).toBe(true);
    expect(isVaultRelPathPending(root, 'Board')).toBe(false);
    expect(isVaultRelPathPending(root, 'Board/Card A.md')).toBe(false);
  });

  it('flushing a trashed folder trashes only the folder — descendants are skipped as already-gone', async () => {
    writeNote(root, 'Board/Card A.md');
    trashTargets(root, '', [{ kind: 'folder', itemPath: 'Board', label: 'Board' }]);

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);

    expect(mockTrashItem).toHaveBeenCalledTimes(1);
    expect(mockTrashItem).toHaveBeenCalledWith(path.join(root, 'Board'));
  });

  it('skips descendants at EVERY depth, not just the folder\'s direct children (SKY-11742)', async () => {
    // The single-level case above can be satisfied by checking only the
    // first descendant. A nested tree proves the serialized flush keeps
    // observing real post-move state all the way down.
    writeNote(root, 'Board/Card A.md');
    writeNote(root, 'Board/Sub/Card B.md');
    writeNote(root, 'Board/Sub/Deeper/Card C.md');
    trashTargets(root, '', [{ kind: 'folder', itemPath: 'Board', label: 'Board' }]);

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);

    expect(mockTrashItem).toHaveBeenCalledTimes(1);
    expect(mockTrashItem).toHaveBeenCalledWith(path.join(root, 'Board'));
    expect(fs.existsSync(path.join(root, 'Board'))).toBe(false);
  });

  it('a force-flush orders OVERLAPPING groups ancestor-first, so a separately-trashed descendant is not double-trashed (SKY-11742)', async () => {
    writeNote(root, 'Board/Card A.md');

    // Two SEPARATE user actions: the card is deleted on its own board
    // first, then the whole folder is deleted from the root board. The
    // second call re-enumerates the still-on-disk card into its own group,
    // so one path now sits in two groups with no cross-group awareness.
    const first = trashTargets(root, 'Board', [{ kind: 'note', itemPath: 'Card A.md', label: 'Card A.md' }]);
    const second = trashTargets(root, '', [{ kind: 'folder', itemPath: 'Board', label: 'Board' }]);
    expect(first.entries.map((e) => e.vaultRelPath)).toEqual(['Board/Card A.md']);
    expect(second.entries.map((e) => e.vaultRelPath).sort()).toEqual(['Board', 'Board/Card A.md']);
    expect(first.entries[0]!.groupId).not.toBe(second.entries[0]!.groupId);

    // Empty flushes every group at once — without ancestor-first ordering
    // the card's group would race an overlapping trash against the folder's.
    const { flushedGroupIds } = await emptyTrash(root);

    expect(flushedGroupIds).toHaveLength(2);
    expect(mockTrashItem).toHaveBeenCalledTimes(1);
    expect(mockTrashItem).toHaveBeenCalledWith(path.join(root, 'Board'));
    expect(listPendingForVault(root)).toEqual([]);
  });

  it('a force-flush claims EVERY group before the first OS move, so nothing can race it (SKY-11742)', async () => {
    writeNote(root, 'A.md');
    writeNote(root, 'B.md');
    trashTargets(root, '', [{ kind: 'note', itemPath: 'A.md', label: 'A.md' }]);
    const second = trashTargets(root, '', [{ kind: 'note', itemPath: 'B.md', label: 'B.md' }]);

    // Sampled from inside the OS move — i.e. while the flush is suspended,
    // which is exactly the window where a still-armed undo timer or a Restore
    // IPC used to be able to reach a group the flush had not claimed yet.
    const pendingDuringMove: number[] = [];
    const restoreRefusedDuringMove: boolean[] = [];
    mockTrashItem.mockImplementation(async (target: string) => {
      pendingDuringMove.push(listPendingForVault(root).length);
      restoreRefusedDuringMove.push(!restoreEntry(second.entries[0]!.id).restored);
      await new Promise<void>((resolve) => { process.nextTick(resolve); });
      fs.rmSync(target, { recursive: true, force: true });
    });

    await emptyTrash(root);

    // Both groups had already left the registry before the first move began.
    expect(pendingDuringMove).toEqual([0, 0]);
    expect(restoreRefusedDuringMove).toEqual([true, true]);
    expect(mockTrashItem).toHaveBeenCalledTimes(2);
  });

  it('unrelated top-level groups still trash CONCURRENTLY — one slow move must not delay the others (SKY-11742)', async () => {
    writeNote(root, 'A.md');
    writeNote(root, 'Other/B.md');
    trashTargets(root, '', [{ kind: 'note', itemPath: 'A.md', label: 'A.md' }]);
    trashTargets(root, '', [{ kind: 'folder', itemPath: 'Other', label: 'Other' }]);

    // emptyTrash and the app-quit hook are both awaited (main.ts holds the
    // window open until this settles), so serializing groups that share no
    // subtree would put every independent OS move on the critical path.
    let inFlight = 0;
    let peakInFlight = 0;
    mockTrashItem.mockImplementation(async (target: string) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => { process.nextTick(resolve); });
      fs.rmSync(target, { recursive: true, force: true });
      inFlight -= 1;
    });

    await emptyTrash(root);

    expect(mockTrashItem).toHaveBeenCalledTimes(2);
    expect(peakInFlight).toBe(2);
    expect(listPendingForVault(root)).toEqual([]);
  });

  it('an unrelated multi-select gets INDEPENDENT groups — restoring one leaves the other pending', () => {
    writeNote(root, 'A.md');
    writeNote(root, 'B.md');
    const { entries } = trashTargets(root, '', [
      { kind: 'note', itemPath: 'A.md', label: 'A.md' },
      { kind: 'note', itemPath: 'B.md', label: 'B.md' },
    ]);
    expect(entries[0]!.groupId).not.toBe(entries[1]!.groupId);

    restoreEntry(entries[0]!.id);
    expect(isVaultRelPathPending(root, 'A.md')).toBe(false);
    expect(isVaultRelPathPending(root, 'B.md')).toBe(true);
  });

  it('cascade-deletes a connector line immediately at trash-time, and restoring the card does not resurrect it (§15 test 10)', () => {
    writeNote(root, 'Board/Card A.md');
    writeNote(root, 'Board/Card B.md');
    const a = patchLayout(root, 'Board', 'Card A.md', { x: 0, y: 0 });
    const b = patchLayout(root, 'Board', 'Card B.md', { x: 100, y: 0 });
    flushPendingNotesBoardWrites(root);
    furnitureCreate(root, 'Board', { k: 'line', x: 0, y: 0, from: a.key, to: b.key } as never);

    const { entries } = trashTargets(root, 'Board', [{ kind: 'note', itemPath: 'Card A.md', label: 'Card A.md' }]);
    // Connector is gone the instant the card is marked pending — not deferred.
    expect(getBoard(root, 'Board').furniture.some((f) => f.k === 'line')).toBe(false);

    restoreEntry(entries[0]!.id);
    // Still gone after restore — documented behaviour, not a bug.
    expect(getBoard(root, 'Board').furniture.some((f) => f.k === 'line')).toBe(false);
  });

  it('furniture trash is deferred the same way, and flush converts it into the PERMANENT record (§7/§8)', async () => {
    fs.mkdirSync(path.join(root, 'Board'));
    const item = furnitureCreate(root, 'Board', { k: 'swatch', x: 0, y: 0 });

    trashTargets(root, 'Board', [{ kind: 'furniture', furnitureId: item.id, label: 'Swatch' }]);
    expect(isFurniturePending(root, 'Board', item.id)).toBe(true);
    // Still live in Store B until flush — nothing moved yet.
    expect(getBoard(root, 'Board').furniture.some((f) => f.id === item.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);

    expect(isFurniturePending(root, 'Board', item.id)).toBe(false);
    const board = getBoard(root, 'Board');
    expect(board.furniture.some((f) => f.id === item.id)).toBe(false);
    // shell.trashItem has no furniture equivalent — the permanent record IS
    // the flush outcome for furniture, not an OS trash call.
    expect(mockTrashItem).not.toHaveBeenCalled();
  });

  it('the "Empty" action force-flushes immediately, without waiting for the window', async () => {
    writeNote(root, 'Idea.md');
    trashTargets(root, '', [{ kind: 'note', itemPath: 'Idea.md', label: 'Idea.md' }]);

    await emptyTrash(root);

    expect(mockTrashItem).toHaveBeenCalledWith(path.join(root, 'Idea.md'));
    expect(listPendingForVault(root)).toEqual([]);
  });

  it('flushAllPendingNotesTrash (app-quit hook) flushes every pending group across vaults', async () => {
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-notestrash-b-'));
    try {
      writeNote(root, 'Idea.md');
      writeNote(rootB, 'Other.md');
      trashTargets(root, '', [{ kind: 'note', itemPath: 'Idea.md', label: 'Idea.md' }]);
      trashTargets(rootB, '', [{ kind: 'note', itemPath: 'Other.md', label: 'Other.md' }]);

      await flushAllPendingNotesTrash();

      expect(mockTrashItem).toHaveBeenCalledWith(path.join(root, 'Idea.md'));
      expect(mockTrashItem).toHaveBeenCalledWith(path.join(rootB, 'Other.md'));
    } finally {
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it('invalidates (drops without flushing) a pending entry whose target changed externally AFTER it was marked pending (§8)', async () => {
    writeNote(root, 'Idea.md');
    const { entries } = trashTargets(root, '', [{ kind: 'note', itemPath: 'Idea.md', label: 'Idea.md' }]);

    // Simulate the notes watcher firing for this path — e.g. Obsidian or sync
    // touched it while we believed it was sitting untouched, pending. Bump
    // the mtime strictly past `deletedAt` so it is unambiguously a write
    // that happened AFTER this entry became pending, not a delayed report
    // of the write that created it (see the next test).
    const laterMtime = new Date(Date.parse(entries[0]!.deletedAt) + 1000);
    fs.utimesSync(path.join(root, 'Idea.md'), laterMtime, laterMtime);

    invalidatePendingUnderPath(root, 'Idea.md');

    expect(isVaultRelPathPending(root, 'Idea.md')).toBe(false);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(mockTrashItem).not.toHaveBeenCalled();
  });

  it('does NOT invalidate when the watcher event is just a delayed echo of the write that predates the entry becoming pending', () => {
    // Regression: a chokidar event for the app's OWN earlier write (e.g. the
    // create/rename that gave this file its current name) can arrive after
    // vault.ts's SELF_WRITE_TTL_MS (2.5s) has already elapsed under load,
    // landing here looking exactly like a fresh external edit. Without the
    // mtime check, this silently abandoned every pending-delete it touched —
    // found via a real end-to-end run, not appearing in a synthetic pure-unit
    // scenario. The file's mtime here is from BEFORE trashTargets ran (no
    // write happens after it), so it must NOT be treated as a conflict.
    //
    // writeNote is a REAL fs write, stamped with the REAL OS clock, while
    // `deletedAt` below comes from the FAKE, frozen `Date` installed in
    // beforeEach. Those two clocks are not the same clock, so nothing
    // guarantees the frozen fake "now" already sits at-or-after the real
    // mtime the OS just wrote — on a loaded runner the real write can land
    // later than the frozen instant fake timers captured, which would flip
    // this into the "conflict" branch for a reason that has nothing to do
    // with the invalidation logic under test. Pin the fake clock to the
    // file's actual mtime so `deletedAt` is deterministically >= it,
    // matching production (where both come from the same real clock).
    writeNote(root, 'Idea.md');
    const writeMtimeMs = fs.statSync(path.join(root, 'Idea.md')).mtimeMs;
    vi.setSystemTime(Math.ceil(writeMtimeMs));
    const { entries } = trashTargets(root, '', [{ kind: 'note', itemPath: 'Idea.md', label: 'Idea.md' }]);

    invalidatePendingUnderPath(root, 'Idea.md');

    expect(isVaultRelPathPending(root, 'Idea.md')).toBe(true);
    restoreEntry(entries[0]!.id); // cleanup — leave nothing pending for the next test
  });

  it('invalidation matches a changed descendant path under a still-pending folder', () => {
    writeNote(root, 'Board/Card A.md');
    const { entries } = trashTargets(root, '', [{ kind: 'folder', itemPath: 'Board', label: 'Board' }]);
    const cardEntry = entries.find((e) => e.vaultRelPath === 'Board/Card A.md')!;
    const laterMtime = new Date(Date.parse(cardEntry.deletedAt) + 1000);
    fs.utimesSync(path.join(root, 'Board', 'Card A.md'), laterMtime, laterMtime);

    invalidatePendingUnderPath(root, 'Board/Card A.md');

    // The whole group is dropped, not just the one descendant — our belief
    // about the WHOLE folder's contents is stale, not just one file's.
    expect(isVaultRelPathPending(root, 'Board')).toBe(false);
  });

  it('invalidates unconditionally when the changed path no longer exists at all (external unlink)', () => {
    writeNote(root, 'Idea.md');
    trashTargets(root, '', [{ kind: 'note', itemPath: 'Idea.md', label: 'Idea.md' }]);
    // Nothing to stat any more — always ambiguous in the entry's favor: treat
    // a vanished path as a real external change rather than risk a stale flush.
    fs.rmSync(path.join(root, 'Idea.md'));

    invalidatePendingUnderPath(root, 'Idea.md');

    expect(isVaultRelPathPending(root, 'Idea.md')).toBe(false);
  });

  it('a target already gone from disk before trashTargets runs is silently skipped', () => {
    const { entries } = trashTargets(root, '', [{ kind: 'note', itemPath: 'Ghost.md', label: 'Ghost.md' }]);
    expect(entries).toEqual([]);
  });

  it('pending queries return false for a different vault root or unrelated paths', () => {
    writeNote(root, 'Only.md');
    trashTargets(root, '', [{ kind: 'note', itemPath: 'Only.md', label: 'Only.md' }]);
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-notestrash-other-'));
    try {
      expect(isVaultRelPathPending(otherRoot, 'Only.md')).toBe(false);
      expect(isVaultRelPathPending(root, 'Missing.md')).toBe(false);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('isFurniturePending requires an exact board path and furniture id', () => {
    fs.mkdirSync(path.join(root, 'Board'));
    const item = furnitureCreate(root, 'Board', { k: 'swatch', x: 0, y: 0 });
    trashTargets(root, 'Board', [{ kind: 'furniture', furnitureId: item.id, label: 'Swatch' }]);
    expect(isFurniturePending(root, 'Board', item.id)).toBe(true);
    expect(isFurniturePending(root, '', item.id)).toBe(false);
    expect(isFurniturePending(root, 'Board', 'not-this-id')).toBe(false);
  });

  it('listPendingForVault returns the newest delete first', () => {
    writeNote(root, 'A.md');
    writeNote(root, 'B.md');
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    trashTargets(root, '', [{ kind: 'note', itemPath: 'A.md', label: 'A.md' }]);
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    trashTargets(root, '', [{ kind: 'note', itemPath: 'B.md', label: 'B.md' }]);
    const pending = listPendingForVault(root);
    expect(pending.map((e) => e.vaultRelPath)).toEqual(['B.md', 'A.md']);
  });

  it('trashes from a nested board path (2+ levels) and keeps sibling folders independent', () => {
    writeNote(root, 'Teams/Alpha/Dossier.md');
    writeNote(root, 'Teams/Beta/Dossier.md');
    const onlyAlpha = trashTargets(root, 'Teams/Alpha', [
      { kind: 'note', itemPath: 'Dossier.md', label: 'Alpha Dossier' },
    ]);
    expect(onlyAlpha.entries.map((e) => e.vaultRelPath)).toEqual(['Teams/Alpha/Dossier.md']);
    expect(isVaultRelPathPending(root, 'Teams/Beta/Dossier.md')).toBe(false);
    expect(isVaultRelPathPending(root, 'Teams/Alpha/Dossier.md')).toBe(true);
    expect(fs.existsSync(path.join(root, 'Teams/Beta/Dossier.md'))).toBe(true);
  });

  it('flush on a deeply nested note removes layout from that note\'s board, not the vault root', async () => {
    writeNote(root, 'World/Places/City.md', 'text\n');
    const { id } = patchLayout(root, 'World/Places', 'City.md', { x: 4, y: 8 });
    flushPendingNotesBoardWrites(root);
    trashTargets(root, 'World/Places', [{ kind: 'note', itemPath: 'City.md', label: 'City' }]);

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);

    const worldPlaces = getBoard(root, 'World/Places');
    const rootBoard = getBoard(root, '');
    expect(worldPlaces.layout[`n:${id}`]).toBeUndefined();
    expect(Object.keys(rootBoard.layout)).toHaveLength(0);
  });

  it('restore still clears pending when the parent folder was removed externally', () => {
    writeNote(root, 'Board/Sub/Orphan.md');
    const { entries } = trashTargets(root, 'Board/Sub', [
      { kind: 'note', itemPath: 'Orphan.md', label: 'Orphan' },
    ]);
    fs.rmSync(path.join(root, 'Board'), { recursive: true, force: true });
    const restored = restoreEntry(entries[0]!.id);
    expect(restored.restored).toBe(true);
    expect(isVaultRelPathPending(root, 'Board/Sub/Orphan.md')).toBe(false);
  });

  it('isVaultRelPathPending requires an exact vault-relative path match', () => {
    writeNote(root, 'Board/Exact.md');
    trashTargets(root, 'Board', [{ kind: 'note', itemPath: 'Exact.md', label: 'Exact' }]);
    expect(isVaultRelPathPending(root, 'Board/Exact.md')).toBe(true);
    expect(isVaultRelPathPending(root, 'Board/Exact')).toBe(false);
    expect(isVaultRelPathPending(root, 'Board')).toBe(false);
  });

  it('flushClaimedGroups sorts shallow groups before deeper overlapping ones', async () => {
    writeNote(root, 'Parent/Child.md');
    const deep = trashTargets(root, 'Parent', [{ kind: 'note', itemPath: 'Child.md', label: 'Child' }]);
    const shallow = trashTargets(root, '', [{ kind: 'folder', itemPath: 'Parent', label: 'Parent' }]);
    const claimed = [deep, shallow].flatMap((r) =>
      r.entries.map((e) => e.groupId),
    ).filter((id, idx, arr) => arr.indexOf(id) === idx).map((id) => notesTrashFlushSeams.claimGroup(id)!).filter(Boolean);
    let shallowFirst = true;
    mockTrashItem.mockImplementation(async (target: string) => {
      const rel = path.relative(root, target);
      if (!shallowFirst) return;
      if (rel !== 'Parent') shallowFirst = false;
      await new Promise<void>((r) => { process.nextTick(r); });
      if (rel === 'Parent') fs.rmSync(target, { recursive: true, force: true });
    });
    await notesTrashFlushSeams.flushClaimedGroups(claimed as never);
    expect(shallowFirst).toBe(true);
    resetNotesTrashForTests();
  });

  it('claimGroup is idempotent — a second claim returns undefined', () => {
    writeNote(root, 'Claim.md');
    const { entries } = trashTargets(root, '', [{ kind: 'note', itemPath: 'Claim.md', label: 'Claim' }]);
    const groupId = entries[0]!.groupId;
    const claimed = notesTrashFlushSeams.claimGroup(groupId);
    expect(claimed).toBeDefined();
    expect(notesTrashFlushSeams.claimGroup(groupId)).toBeUndefined();
    expect(listPendingForVault(root)).toEqual([]);
    expect(isVaultRelPathPending(root, 'Claim.md')).toBe(false);
    resetNotesTrashForTests();
  });

  it('flush removes a root-board layout entry using parentRelPath \"\" (splitVaultRelPath)', async () => {
    writeNote(root, 'Root.md');
    const { id } = patchLayout(root, '', 'Root.md', { x: 3, y: 3 });
    flushPendingNotesBoardWrites(root);
    trashTargets(root, '', [{ kind: 'note', itemPath: 'Root.md', label: 'Root' }]);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(getBoard(root, '').layout[`n:${id}`]).toBeUndefined();
  });

  it('flush removes a nested-board layout via split parent folder + item name', async () => {
    writeNote(root, 'Board/Nested/Item.md');
    const { id } = patchLayout(root, 'Board/Nested', 'Item.md', { x: 9, y: 9 });
    flushPendingNotesBoardWrites(root);
    trashTargets(root, 'Board/Nested', [{ kind: 'note', itemPath: 'Item.md', label: 'Item' }]);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(getBoard(root, 'Board/Nested').layout[`n:${id}`]).toBeUndefined();
  });

  it('restoreEntry returns false for an unknown id', () => {
    expect(restoreEntry(crypto.randomUUID())).toEqual({ restored: false, restoredIds: [] });
  });

  it('flush removes icon assignments for a trashed path (best-effort at flush time)', async () => {
    writeNote(root, 'Tagged.md');
    writeIconMap(root, { 'Tagged.md': '🎯' });
    trashTargets(root, '', [{ kind: 'note', itemPath: 'Tagged.md', label: 'Tagged' }]);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(readIconMap(root)).toEqual({});
  });

  it('orders three mutually overlapping folder groups ancestor-first on emptyTrash', async () => {
    writeNote(root, 'Tree/A.md');
    writeNote(root, 'Tree/A/B.md');
    writeNote(root, 'Tree/A/B/C.md');
    trashTargets(root, 'Tree/A/B', [{ kind: 'note', itemPath: 'C.md', label: 'C' }]);
    trashTargets(root, 'Tree/A', [{ kind: 'folder', itemPath: 'B', label: 'B' }]);
    trashTargets(root, '', [{ kind: 'folder', itemPath: 'Tree', label: 'Tree' }]);
    const order: string[] = [];
    mockTrashItem.mockImplementation(async (target: string) => {
      order.push(path.relative(root, target));
      await new Promise<void>((resolve) => { process.nextTick(resolve); });
      fs.rmSync(target, { recursive: true, force: true });
    });
    await emptyTrash(root);
    expect(order[0]).toBe('Tree');
    expect(mockTrashItem).toHaveBeenCalledTimes(1);
  });

  it('refuses restore while a force-flush has already claimed the group', async () => {
    writeNote(root, 'Hold.md');
    const { entries } = trashTargets(root, '', [{ kind: 'note', itemPath: 'Hold.md', label: 'Hold.md' }]);
    let claimed = false;
    mockTrashItem.mockImplementation(async (target: string) => {
      if (!claimed) {
        claimed = true;
        const refused = restoreEntry(entries[0]!.id);
        expect(refused.restored).toBe(false);
      }
      await new Promise<void>((resolve) => { process.nextTick(resolve); });
      fs.rmSync(target, { recursive: true, force: true });
    });
    await emptyTrash(root);
    expect(listPendingForVault(root)).toEqual([]);
  });

  it('records each descendant with the boardRelPath of its direct containing folder', () => {
    writeNote(root, 'A/B/Leaf.md');
    const { entries } = trashTargets(root, '', [{ kind: 'folder', itemPath: 'A', label: 'A' }]);
    const leaf = entries.find((e) => e.vaultRelPath === 'A/B/Leaf.md')!;
    const sub = entries.find((e) => e.vaultRelPath === 'A/B')!;
    expect(leaf.boardRelPath).toBe('A/B');
    expect(sub.boardRelPath).toBe('A');
  });

  it('leaves key empty when a trashed note has no resolvable id', () => {
    writeNote(root, 'Plain.md', '# No id in frontmatter\n');
    const { entries } = trashTargets(root, '', [{ kind: 'note', itemPath: 'Plain.md', label: 'Plain' }]);
    expect(entries[0]!.key).toBe('');
    expect(entries[0]!.vaultRelPath).toBe('Plain.md');
  });

  it('uses an x: furniture key for deferred furniture trash', () => {
    fs.mkdirSync(path.join(root, 'Desk'));
    const item = furnitureCreate(root, 'Desk', { k: 'swatch', x: 1, y: 1 });
    const { entries } = trashTargets(root, 'Desk', [
      { kind: 'furniture', furnitureId: item.id, label: 'Swatch' },
    ]);
    expect(entries[0]!.key).toBe(`x:${item.id}`);
  });

  it('trashing a root-level note uses an empty boardRelPath on the pending entry', () => {
    writeNote(root, 'RootNote.md');
    const { entries } = trashTargets(root, '', [{ kind: 'note', itemPath: 'RootNote.md', label: 'Root' }]);
    expect(entries[0]!.boardRelPath).toBe('');
    expect(entries[0]!.vaultRelPath).toBe('RootNote.md');
  });

  it('invalidates when the watch reports a change ON the pending folder path itself', () => {
    writeNote(root, 'Board/Inside.md');
    const { entries } = trashTargets(root, '', [{ kind: 'folder', itemPath: 'Board', label: 'Board' }]);
    const folderEntry = entries.find((e) => e.vaultRelPath === 'Board')!;
    const touch = new Date(Date.parse(folderEntry.deletedAt) + 500);
    fs.utimesSync(path.join(root, 'Board'), touch, touch);
    invalidatePendingUnderPath(root, 'Board');
    expect(isVaultRelPathPending(root, 'Board')).toBe(false);
  });

  it('does not drop furniture-only pending groups during filesystem invalidation', () => {
    fs.mkdirSync(path.join(root, 'Studio'));
    const item = furnitureCreate(root, 'Studio', { k: 'swatch', x: 0, y: 0 });
    trashTargets(root, 'Studio', [{ kind: 'furniture', furnitureId: item.id, label: 'Swatch' }]);
    invalidatePendingUnderPath(root, 'Unrelated.md');
    expect(isFurniturePending(root, 'Studio', item.id)).toBe(true);
  });

  it('invalidates a pending folder when a change lands under its subtree prefix', () => {
    writeNote(root, 'Board/Inner/Card.md');
    trashTargets(root, '', [{ kind: 'folder', itemPath: 'Board', label: 'Board' }]);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'Board/Inner/Card.md'), later, later);
    invalidatePendingUnderPath(root, 'Board/Inner/Card.md');
    expect(isVaultRelPathPending(root, 'Board')).toBe(false);
  });

  it('emptyTrash on an empty vault returns no flushed ids', async () => {
    await expect(emptyTrash(root)).resolves.toEqual({ flushedGroupIds: [] });
  });

  it('does not invalidate furniture when an unrelated note path changes', () => {
    fs.mkdirSync(path.join(root, 'Art'));
    writeNote(root, 'Elsewhere.md');
    const item = furnitureCreate(root, 'Art', { k: 'swatch', x: 0, y: 0 });
    trashTargets(root, 'Art', [{ kind: 'furniture', furnitureId: item.id, label: 'Swatch' }]);
    const touch = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'Elsewhere.md'), touch, touch);
    invalidatePendingUnderPath(root, 'Elsewhere.md');
    expect(isFurniturePending(root, 'Art', item.id)).toBe(true);
  });

  it('keeps a pending delete when external mtime equals deletedAt exactly', () => {
    writeNote(root, 'Edge.md');
    const { entries } = trashTargets(root, '', [{ kind: 'note', itemPath: 'Edge.md', label: 'Edge' }]);
    const at = new Date(Date.parse(entries[0]!.deletedAt));
    fs.utimesSync(path.join(root, 'Edge.md'), at, at);
    invalidatePendingUnderPath(root, 'Edge.md');
    expect(isVaultRelPathPending(root, 'Edge.md')).toBe(true);
  });

  it('flushes furniture entries even when they carry no vaultRelPath', async () => {
    fs.mkdirSync(path.join(root, 'Gallery'));
    const item = furnitureCreate(root, 'Gallery', { k: 'swatch', x: 0, y: 0 });
    trashTargets(root, 'Gallery', [{ kind: 'furniture', furnitureId: item.id, label: 'Swatch' }]);
    await emptyTrash(root);
    expect(getBoard(root, 'Gallery').furniture.some((f) => f.id === item.id)).toBe(false);
    expect(mockTrashItem).not.toHaveBeenCalled();
  });

  it('invalidates a pending folder when an ancestor path changes externally', () => {
    writeNote(root, 'Board/Card A.md');
    const { entries } = trashTargets(root, '', [{ kind: 'folder', itemPath: 'Board', label: 'Board' }]);
    const laterMtime = new Date(Date.parse(entries[0]!.deletedAt) + 1000);
    fs.utimesSync(path.join(root, 'Board'), laterMtime, laterMtime);
    invalidatePendingUnderPath(root, 'Board');
    expect(isVaultRelPathPending(root, 'Board')).toBe(false);
    expect(isVaultRelPathPending(root, 'Board/Card A.md')).toBe(false);
  });

});
