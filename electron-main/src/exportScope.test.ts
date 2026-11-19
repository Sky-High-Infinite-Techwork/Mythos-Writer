// SKY-11130 — buildTextExport / resolveExportScope must order chapters via
// chaptersOf() (parts-first), not a flat `story.chapters` sort.
//
// Fixture mirrors manuscriptPass.test.ts's "follows parts order when parts
// exist" case: the delete-chapter -> add-part -> add-chapter history leaves
// per-part chapter orders non-monotonic across the whole story — Part 1
// holds ch-c (order 2), Part 2 holds ch-n (order 1). A global chapter.order
// sort would reverse them; chaptersOf() must not.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChapterEntry, Manifest, PartEntry, SceneEntry, StoryEntry } from './ipc.js';
import { defaultManifest, writeSceneFile } from './vault.js';
import { buildTextExport, resolveExportScope, safeExportFilename } from './exportScope.js';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

function makeScene(id: string, order: number): SceneEntry {
  return {
    id,
    title: `Scene ${id}`,
    path: `scenes/${id}.md`,
    order,
    blocks: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function makeChapter(id: string, order: number, scenes: SceneEntry[]): ChapterEntry {
  return {
    id,
    title: `Chapter ${id}`,
    path: `chapters/${id}`,
    order,
    scenes,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function makeStory(id: string, chapters: ChapterEntry[], parts: PartEntry[]): StoryEntry {
  return {
    id,
    title: `Story ${id}`,
    path: `stories/${id}`,
    chapters,
    parts,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-scope-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Non-monotonic-across-parts fixture: Part 1 -> ch-c (order 2), Part 2 ->
 *  ch-n (order 1). Reading order is ch-c then ch-n; a flat chapter.order
 *  sort would produce ch-n then ch-c. */
function writePartedStory(): { manifest: Manifest; story: StoryEntry } {
  const sceneC = makeScene('sc-c', 1);
  const sceneN = makeScene('sc-n', 1);
  const chC = makeChapter('ch-c', 2, [sceneC]);
  const chN = makeChapter('ch-n', 1, [sceneN]);
  const parts: PartEntry[] = [
    { id: 'p-1', title: 'Part 1', order: 0, note: [], chapters: [chC], createdAt: CREATED_AT, updatedAt: CREATED_AT },
    { id: 'p-2', title: 'Part 2', order: 1, note: [], chapters: [chN], createdAt: CREATED_AT, updatedAt: CREATED_AT },
  ];
  const story = makeStory('st-1', [chC, chN], parts);
  const manifest: Manifest = { ...defaultManifest(tmpDir), stories: [story] };
  writeSceneFile(tmpDir, sceneC.path, { id: sceneC.id, title: sceneC.title, prose: 'Part one prose.' });
  writeSceneFile(tmpDir, sceneN.path, { id: sceneN.id, title: sceneN.title, prose: 'Part two prose.' });
  return { manifest, story };
}

describe('resolveExportScope — part-aware chapter order (SKY-11130)', () => {
  it("'story' scope follows parts order, not raw chapter.order", () => {
    const { manifest, story } = writePartedStory();
    const resolved = resolveExportScope(tmpDir, manifest, { kind: 'story', storyId: story.id });
    expect(resolved.chapters.map((c) => c.id)).toEqual(['ch-c', 'ch-n']);
  });

  it("'vault' scope follows parts order, not raw chapter.order", () => {
    const { manifest } = writePartedStory();
    const resolved = resolveExportScope(tmpDir, manifest, { kind: 'vault' });
    expect(resolved.chapters.map((c) => c.id)).toEqual(['ch-c', 'ch-n']);
  });
});

describe('buildTextExport — part-aware chapter order (SKY-11130)', () => {
  it("'story' scope orders chapter headings by part, not raw chapter.order", () => {
    const { manifest, story } = writePartedStory();
    const { content } = buildTextExport(tmpDir, manifest, { kind: 'story', storyId: story.id }, 'markdown');
    expect(content.indexOf('## Chapter ch-c')).toBeGreaterThanOrEqual(0);
    expect(content.indexOf('## Chapter ch-c')).toBeLessThan(content.indexOf('## Chapter ch-n'));
  });

  it("'vault' scope orders chapter headings by part, not raw chapter.order", () => {
    const { manifest } = writePartedStory();
    const { content } = buildTextExport(tmpDir, manifest, { kind: 'vault' }, 'markdown');
    expect(content.indexOf('## Chapter ch-c')).toBeGreaterThanOrEqual(0);
    expect(content.indexOf('## Chapter ch-c')).toBeLessThan(content.indexOf('## Chapter ch-n'));
  });
});

function writeTwoSceneChapter(): { manifest: Manifest; storyId: string; chapterId: string; sceneIds: [string, string] } {
  const sceneA = makeScene('sc-a', 2);
  const sceneB = makeScene('sc-b', 1);
  const chapter = makeChapter('ch-1', 0, [sceneA, sceneB]);
  const story = makeStory('st-exp', [chapter], []);
  story.synopsis = 'Story synopsis blurb.';
  const manifest: Manifest = { ...defaultManifest(tmpDir), stories: [story] };
  writeSceneFile(tmpDir, sceneA.path, { id: sceneA.id, title: sceneA.title, prose: 'Prose scene A.' });
  writeSceneFile(tmpDir, sceneB.path, { id: sceneB.id, title: sceneB.title, prose: 'Prose scene B.' });
  return { manifest, storyId: story.id, chapterId: chapter.id, sceneIds: [sceneA.id, sceneB.id] };
}

describe('safeExportFilename', () => {
  it('replaces illegal path characters and trims', () => {
    expect(safeExportFilename('My Story: Part 1')).toBe('My Story- Part 1');
    expect(safeExportFilename('   ')).toBe('export');
  });
});

describe('resolveExportScope — scopes and ordering', () => {
  it("'scene' scope returns a single scene with prose from disk", () => {
    const { manifest, sceneIds } = writeTwoSceneChapter();
    const resolved = resolveExportScope(tmpDir, manifest, { kind: 'scene', sceneId: sceneIds[0] });
    expect(resolved.chapters).toHaveLength(1);
    expect(resolved.chapters[0].scenes).toHaveLength(1);
    expect(resolved.chapters[0].scenes[0].prose).toBe('Prose scene A.');
    expect(resolved.missingSceneIds).toEqual([]);
  });

  it("'chapter' scope orders scenes by scene.order and includes synopsis", () => {
    const { manifest, storyId, chapterId } = writeTwoSceneChapter();
    const resolved = resolveExportScope(tmpDir, manifest, { kind: 'chapter', storyId, chapterId });
    expect(resolved.synopsis).toBe('Story synopsis blurb.');
    expect(resolved.chapters[0].scenes.map((s) => s.id)).toEqual(['sc-b', 'sc-a']);
    expect(resolved.chapters[0].scenes[0].prose).toBe('Prose scene B.');
  });

  it("'story' scope includes all chapters and ordered scenes", () => {
    const { manifest, storyId } = writeTwoSceneChapter();
    const resolved = resolveExportScope(tmpDir, manifest, { kind: 'story', storyId });
    expect(resolved.synopsis).toBe('Story synopsis blurb.');
    expect(resolved.chapters[0].scenes.map((s) => s.prose)).toEqual(['Prose scene B.', 'Prose scene A.']);
  });

  it("'vault' scope prefixes chapter titles with story title", () => {
    const { manifest } = writeTwoSceneChapter();
    const resolved = resolveExportScope(tmpDir, manifest, { kind: 'vault' });
    expect(resolved.title).toBe('Vault Export');
    expect(resolved.chapters[0].title).toContain('Story st-exp');
    expect(resolved.chapters[0].scenes.map((s) => s.id)).toEqual(['sc-b', 'sc-a']);
  });

  it('resolves a scene listed only on manifest.scenes fallback', () => {
    const orphan = makeScene('sc-orphan', 0);
    const manifest: Manifest = {
      ...defaultManifest(tmpDir),
      stories: [],
      scenes: [orphan],
    };
    writeSceneFile(tmpDir, orphan.path, { id: orphan.id, title: orphan.title, prose: 'Orphan prose.' });
    const resolved = resolveExportScope(tmpDir, manifest, { kind: 'scene', sceneId: orphan.id });
    expect(resolved.chapters[0].scenes[0].prose).toBe('Orphan prose.');
  });

  it('records missing scene ids when the .md file is absent', () => {
    const scene = makeScene('sc-miss', 0);
    const chapter = makeChapter('ch-empty', 0, [scene]);
    const story = makeStory('st-miss', [chapter], []);
    const manifest: Manifest = { ...defaultManifest(tmpDir), stories: [story] };
    const resolved = resolveExportScope(tmpDir, manifest, { kind: 'story', storyId: story.id });
    expect(resolved.missingSceneIds).toEqual(['sc-miss']);
    expect(resolved.chapters[0].scenes[0].prose).toBe('');
  });

  it('throws when scene, story, or chapter is not found', () => {
    const { manifest, storyId, chapterId } = writeTwoSceneChapter();
    expect(() => resolveExportScope(tmpDir, manifest, { kind: 'scene', sceneId: 'nope' })).toThrow(/Scene not found/);
    expect(() => resolveExportScope(tmpDir, manifest, { kind: 'story', storyId: 'nope' })).toThrow(/Story not found/);
    expect(() => resolveExportScope(tmpDir, manifest, { kind: 'chapter', storyId, chapterId: 'nope' })).toThrow(/Chapter not found/);
  });
});

describe('buildTextExport — scopes and formats', () => {
  it("'scene' scope resolves orphan scenes from manifest.scenes", () => {
    const orphan = makeScene('sc-orphan-md', 0);
    const manifest: Manifest = { ...defaultManifest(tmpDir), stories: [], scenes: [orphan] };
    writeSceneFile(tmpDir, orphan.path, { id: orphan.id, title: orphan.title, prose: 'Orphan md prose.' });
    const { content } = buildTextExport(tmpDir, manifest, { kind: 'scene', sceneId: orphan.id }, 'markdown');
    expect(content).toContain('Orphan md prose.');
  });

  it("'scene' scope builds plaintext for a nested scene", () => {
    const { manifest, sceneIds } = writeTwoSceneChapter();
    const { content } = buildTextExport(
      tmpDir,
      manifest,
      { kind: 'scene', sceneId: sceneIds[1] },
      'plaintext',
    );
    expect(content).toContain('Prose scene B.');
    expect(content).not.toContain('#');
  });

  it("'scene' scope builds markdown with scene prose", () => {
    const { manifest, sceneIds } = writeTwoSceneChapter();
    const { content, defaultFilename, missingSceneIds } = buildTextExport(
      tmpDir,
      manifest,
      { kind: 'scene', sceneId: sceneIds[0] },
      'markdown',
    );
    expect(defaultFilename).toBe('Scene sc-a');
    expect(content).toContain('Prose scene A.');
    expect(missingSceneIds).toEqual([]);
  });

  it("'chapter' scope builds plaintext with scenes in order", () => {
    const { manifest, storyId, chapterId } = writeTwoSceneChapter();
    const { content } = buildTextExport(
      tmpDir,
      manifest,
      { kind: 'chapter', storyId, chapterId },
      'plaintext',
    );
    const idxB = content.indexOf('Prose scene B.');
    const idxA = content.indexOf('Prose scene A.');
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeLessThan(idxA);
  });

  it("'story' scope on an empty story yields headers only", () => {
    const story = makeStory('st-empty', [], []);
    const manifest: Manifest = { ...defaultManifest(tmpDir), stories: [story] };
    const { content } = buildTextExport(tmpDir, manifest, { kind: 'story', storyId: story.id }, 'markdown');
    expect(content).toContain('# Story st-empty');
    expect(content).not.toContain('##');
  });

  it("'chapter' with no scenes still emits the chapter heading", () => {
    const chapter = makeChapter('ch-noscenes', 0, []);
    const story = makeStory('st-noscenes', [chapter], []);
    const manifest: Manifest = { ...defaultManifest(tmpDir), stories: [story] };
    const { content } = buildTextExport(
      tmpDir,
      manifest,
      { kind: 'chapter', storyId: story.id, chapterId: chapter.id },
      'markdown',
    );
    expect(content).toContain('# Chapter ch-noscenes');
    expect(content).not.toContain('##');
  });

  it("'vault' scope with zero stories returns empty markdown", () => {
    const manifest: Manifest = { ...defaultManifest(tmpDir), stories: [] };
    const { content, defaultFilename } = buildTextExport(tmpDir, manifest, { kind: 'vault' }, 'markdown');
    expect(defaultFilename).toBe('vault-export');
    expect(content).toBe('');
  });

  it('buildTextExport throws when scope targets a missing id', () => {
    const { manifest, storyId, chapterId } = writeTwoSceneChapter();
    expect(() => buildTextExport(tmpDir, manifest, { kind: 'scene', sceneId: 'missing' }, 'markdown')).toThrow();
    expect(() => buildTextExport(tmpDir, manifest, { kind: 'story', storyId: 'missing' }, 'markdown')).toThrow();
    expect(() =>
      buildTextExport(tmpDir, manifest, { kind: 'chapter', storyId, chapterId: 'missing' }, 'markdown'),
    ).toThrow();
  });

  it('vault markdown inserts --- between multiple stories', () => {
    const mkTinyStory = (id: string, title: string) => {
      const sc = makeScene(`sc-${id}`, 0);
      const ch = makeChapter(`ch-${id}`, 0, [sc]);
      const st = makeStory(id, [ch], []);
      st.title = title;
      writeSceneFile(tmpDir, sc.path, { id: sc.id, title: sc.title, prose: `${title} prose` });
      return st;
    };
    const stories = [mkTinyStory('a', 'Alpha'), mkTinyStory('b', 'Beta')];
    const manifest: Manifest = { ...defaultManifest(tmpDir), stories };
    const { content } = buildTextExport(tmpDir, manifest, { kind: 'vault' }, 'markdown');
    expect(content).toContain('Alpha prose');
    expect(content).toContain('Beta prose');
    expect(content).toContain('\n\n---\n\n');
    const alphaIdx = content.indexOf('Alpha prose');
    const betaIdx = content.indexOf('Beta prose');
    expect(alphaIdx).toBeLessThan(betaIdx);
  });
});
