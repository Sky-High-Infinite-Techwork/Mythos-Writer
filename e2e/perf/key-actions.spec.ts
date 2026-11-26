/**
 * key-actions.spec.ts — test gap 10 (#1913, tracking #1903).
 *
 * CI-gated perf budgets for nine actions. The fixture and the stop
 * conditions match the audit scratch in #1903 (packaged out/ build,
 * --force-prefers-reduced-motion, veynn-v2 mythos.json, Story Vault,
 * book.md spine). One measured launch per startup metric. The 300-scene
 * launch continues into open-big-scene, the three view switches, and the
 * three exports so the shard grows by one extra app boot, not nine.
 *
 * Big-doc typing, switch-back to Story Writer, and Boards are slice 11.
 *
 * The key-actions gate runs from `test:e2e:wallpaper-picker` on shard 4 until it gets its own CI step (a carve-out for Skyy).
 *
 * Report mode logged `[perf] metric=<name> ms=<n>` for 20 CI runs.
 * Budgets are max(2× CI p95, 1.25× CI max), nearest-rank p95, and never
 * above BOX_CAPS_MS. The three switch budgets were collected again after
 * the clock moved to destination content (20 repeats in one CI job).
 * Mythos and Notes Editor landed on their caps. ENFORCE_BUDGETS fails
 * the test when a sample exceeds its budget.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import zlib from 'zlib';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, firstWindow, MAIN_JS } from '../helpers/launchApp';

test.describe.configure({ mode: 'serial' });

const NOW = '2026-07-01T00:00:00.000Z';
const STORY_TITLE = 'Audit Perf Story';
const SMALL_SCENE_COUNT = 300;
const BIG_BYTES = 500 * 1024;
const TAIL = 'AUDIT-TAIL-MARKER-ZQX';
const SCENE_COUNT = SMALL_SCENE_COUNT + 1;

/** Box caps from #1913. A budget above its cap is a loosened gate. */
const BOX_CAPS_MS = {
  launch_empty_to_story_tree_ms: 3_500,
  launch_300_to_story_tree_ms: 6_000,
  open_big_scene_500kb_ms: 5_500,
  switch_timeline_ms: 700,
  switch_mythos_ms: 300,
  switch_notes_editor_ms: 4_500,
  export_docx_301_ms: 1_500,
  export_epub_301_ms: 800,
  export_pdf_301_ms: 8_000,
} as const;

type PerfMetric = keyof typeof BOX_CAPS_MS;

/** Switch numbers are the content-visible re-baseline (20 CI repeats). Mythos and Notes Editor are the cap; the formula was higher. */
const ENFORCE_BUDGETS = true;

const BUDGETS_MS: { [K in PerfMetric]: number } = {
  launch_empty_to_story_tree_ms: 1_860,
  launch_300_to_story_tree_ms: 2_334,
  open_big_scene_500kb_ms: 5_472,
  switch_timeline_ms: 238,
  switch_mythos_ms: 300,
  switch_notes_editor_ms: 4_500,
  export_docx_301_ms: 876,
  export_epub_301_ms: 730,
  export_pdf_301_ms: 4_234,
};

const METRICS = Object.keys(BOX_CAPS_MS) as PerfMetric[];

function assertBudgetsWithinCaps(): void {
  for (const metric of METRICS) {
    if (BUDGETS_MS[metric] > BOX_CAPS_MS[metric]) {
      throw new Error(
        `budget for ${metric} (${BUDGETS_MS[metric]}) is looser than box cap ${BOX_CAPS_MS[metric]}`,
      );
    }
  }
}

function perf(metric: PerfMetric, ms: number): void {
  const rounded = Math.round(ms);
  console.log(`[perf] metric=${metric} ms=${rounded}`);
  if (!ENFORCE_BUDGETS) return;
  expect.soft(
    rounded,
    `${metric} ${rounded}ms exceeded budget ${BUDGETS_MS[metric]}ms (box cap ${BOX_CAPS_MS[metric]}ms)`,
  ).toBeLessThanOrEqual(BUDGETS_MS[metric]);
}

function prose(bytes: number): string {
  const unit = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

interface SeededVault {
  root: string;
  userData: string;
  chapterDir: string;
}

/**
 * Audit scratch seed. `smallScenes = 0` is the empty-vault launch: the story,
 * chapter, and the 500 KB scene file are on disk (the scratch always wrote
 * Scene 000) and none of the 8 KB scenes are. `smallScenes = 300` is the
 * 301-scene vault (300 × 8 KB + the 500 KB scene).
 */
function seedVault(smallScenes: number): SeededVault {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mythos-key-actions-${smallScenes}-`));
  const userData = path.join(root, 'ud');
  const bundle = path.join(root, 'vault');
  const notes = path.join(bundle, 'Notes Vault');
  const storyDir = path.join(bundle, 'Story Vault', STORY_TITLE);
  const chapterDir = path.join(storyDir, 'Part 1', 'Chapter 01');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(chapterDir, { recursive: true });
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({ onboardingComplete: true, theme: 'dark' }),
  );
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({ vaultRoot: path.join(bundle, 'Story Vault'), notesVaultRoot: notes }),
  );
  fs.writeFileSync(
    path.join(bundle, 'mythos.json'),
    JSON.stringify({
      formatVersion: 2,
      id: 'vault-audit',
      name: 'Audit Vault',
      createdAt: NOW,
      stories: [{ id: 'story-audit', title: STORY_TITLE, folder: STORY_TITLE, createdAt: NOW, updatedAt: NOW }],
      seed: { layout: 'veynn-v2', mode: 'blank', seededAt: NOW },
    }),
  );
  const spine = [{ dir: 'Part 1', chapters: [{ dir: 'Chapter 01', id: 'ch-audit', title: 'Chapter One' }] }];
  fs.writeFileSync(
    path.join(storyDir, 'book.md'),
    [
      '---',
      'id: story-audit',
      `title: ${STORY_TITLE}`,
      `createdAt: ${NOW}`,
      `updatedAt: ${NOW}`,
      '---',
      `# ${STORY_TITLE}`,
      '',
      '## Part 1',
      '',
      '- [[Part 1/Chapter 01|Chapter One]]',
      '',
      '<!-- mythos:spine',
      JSON.stringify(spine),
      '-->',
      '',
    ].join('\n'),
  );
  const small = prose(8 * 1024);
  const bigBody = prose(BIG_BYTES).replace(/\. /g, '.\n\n');
  fs.writeFileSync(
    path.join(chapterDir, 'Scene 000.md'),
    `---\nid: scene-big\ntitle: Big Scene\nstatus: draft\nupdatedAt: ${NOW}\n---\n${bigBody}\n\n${TAIL}\n`,
  );
  for (let i = 1; i <= smallScenes; i += 1) {
    const id = String(i).padStart(3, '0');
    fs.writeFileSync(
      path.join(chapterDir, `Scene ${id}.md`),
      `---\nid: scene-${id}\ntitle: Scene ${id}\nstatus: draft\nupdatedAt: ${NOW}\n---\n${small}\n`,
    );
  }
  return { root, userData, chapterDir };
}

async function revealStoryTree(page: Page): Promise<void> {
  const nav = page.locator('nav[aria-label="Main navigation"]');
  await nav.waitFor({ state: 'visible', timeout: 60_000 });
  const storyBtn = nav.getByRole('button', { name: /^story( writer)?$/i }).first();
  await storyBtn.waitFor({ state: 'visible', timeout: 60_000 });
  if ((await storyBtn.getAttribute('aria-current')) !== 'page') {
    await storyBtn.click();
  }
  const backdrop = page.locator('[data-testid="nav-rail-stories-backdrop"]');
  if (await backdrop.count()) {
    await backdrop.click({ position: { x: 5, y: 5 }, force: true });
    await expect(backdrop).toHaveCount(0);
  }
  // The row's accessible name includes the chevron, so match the title as a substring.
  await page.getByRole('button', { name: new RegExp(STORY_TITLE) }).first().waitFor({
    state: 'visible',
    timeout: 60_000,
  });
}

async function dismissBackdrop(page: Page): Promise<void> {
  const backdrop = page.locator('[data-testid="nav-rail-stories-backdrop"]');
  if (await backdrop.count()) {
    await backdrop.click({ position: { x: 5, y: 5 }, force: true });
    await expect(backdrop).toHaveCount(0);
  }
}

/** Native save dialogs cannot be driven. The export handlers themselves are not patched. */
async function patchSaveDialog(app: ElectronApplication, exportDir: string): Promise<void> {
  await app.evaluate(({ dialog }, { dir }: { dir: string }) => {
    let counter = 0;
    (dialog as unknown as Record<string, unknown>).showSaveDialog = async (
      options: { filters?: Array<{ extensions?: string[] }> },
    ) => {
      const ext = options?.filters?.[0]?.extensions?.[0] ?? 'bin';
      const getBuiltinModule = (process as unknown as {
        getBuiltinModule: (id: string) => { join: (...parts: string[]) => string };
      }).getBuiltinModule;
      const nodePath = getBuiltinModule('path');
      return { canceled: false, filePath: nodePath.join(dir, `key-action-${counter++}.${ext}`) };
    };
  }, { dir: exportDir });
}

function allSceneTitles(): string[] {
  const titles = ['Big Scene'];
  for (let i = 1; i <= SMALL_SCENE_COUNT; i += 1) titles.push(`Scene ${String(i).padStart(3, '0')}`);
  return titles;
}

/** Local-file ZIP reader (store or deflate). Enough for DOCX and EPUB. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed);
    out.set(name, data);
    offset = dataStart + compSize;
  }
  return out;
}

function zipStored(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(20, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

function decodeUtf16be(hex: string): string {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length === 0 || raw.length % 2 !== 0) return '';
  const swapped = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i += 2) {
    swapped[i] = raw[i + 1]!;
    swapped[i + 1] = raw[i]!;
  }
  return swapped.toString('utf16le');
}

function parseCmap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(Number.parseInt(pair[1]!, 16), decodeUtf16be(pair[2]!));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = Number.parseInt(range[1]!, 16);
      const end = Number.parseInt(range[2]!, 16);
      const base = decodeUtf16be(range[3]!).codePointAt(0) ?? 0;
      for (let k = 0; k <= end - start; k += 1) map.set(start + k, String.fromCodePoint(base + k));
    }
  }
  return map;
}

/**
 * Chromium's printToPDF writes one content stream per page and subsets a
 * different cmap per font. Titles are letter-spaced into single-glyph `Tj`
 * operators. Compressed streams are sliced with `/Length` because the
 * deflated bytes can contain the literal `endstream`.
 */
function pdfText(buf: Buffer): string {
  const headerAt = new Map<number, number>();
  for (const match of buf.toString('latin1').matchAll(/(\d+) 0 obj/g)) {
    headerAt.set(Number.parseInt(match[1]!, 10), match.index ?? 0);
  }

  function streamAfter(at: number): Buffer | null {
    const window = buf.subarray(at, Math.min(buf.length, at + 600));
    const marker = window.indexOf('stream');
    if (marker < 0) return null;
    const lengthMatch = /\/Length\s+(\d+)/.exec(window.subarray(0, marker).toString('latin1'));
    if (!lengthMatch) return null;
    let dataStart = at + marker + 'stream'.length;
    if (buf[dataStart] === 0x0d) dataStart += 1;
    if (buf[dataStart] === 0x0a) dataStart += 1;
    return buf.subarray(dataStart, dataStart + Number.parseInt(lengthMatch[1]!, 10));
  }

  function inflate(data: Buffer): string {
    try {
      return zlib.inflateSync(data).toString('latin1');
    } catch {
      return data.toString('latin1');
    }
  }

  const cmaps = new Map<number, Map<number, string>>();
  const fontCmap = new Map<number, Map<number, string>>();
  for (const [id, at] of headerAt) {
    const data = streamAfter(at);
    if (!data) continue;
    const text = inflate(data);
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) cmaps.set(id, parseCmap(text));
  }
  for (const [id, at] of headerAt) {
    const headerEnd = buf.indexOf('endobj', at);
    if (headerEnd < 0 || headerEnd - at > 2000) continue;
    const header = buf.subarray(at, headerEnd).toString('latin1');
    const toUnicode = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(header);
    if (!toUnicode) continue;
    const cmap = cmaps.get(Number.parseInt(toUnicode[1]!, 10));
    if (cmap) fontCmap.set(id, cmap);
  }

  const contentFonts = new Map<number, Map<string, Map<number, string>>>();
  for (const [id, at] of headerAt) {
    const headerEnd = buf.indexOf('endobj', at);
    if (headerEnd < 0 || headerEnd - at > 2500) continue;
    const header = buf.subarray(at, headerEnd).toString('latin1');
    const contents = /\/Contents\s+(\d+)\s+0\s+R/.exec(header);
    const fontBlock = /\/Font\s*<<([\s\S]*?)>>/.exec(header);
    if (!contents || !fontBlock) continue;
    const fonts = new Map<string, Map<number, string>>();
    for (const ref of fontBlock[1]!.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
      const cmap = fontCmap.get(Number.parseInt(ref[2]!, 10));
      if (cmap) fonts.set(ref[1]!, cmap);
    }
    contentFonts.set(Number.parseInt(contents[1]!, 10), fonts);
  }

  const pieces: string[] = [];
  for (const [id, at] of headerAt) {
    const data = streamAfter(at);
    if (!data) continue;
    const text = inflate(data);
    if (!text.includes('Tj')) {
      pieces.push(text);
      continue;
    }
    const fonts = contentFonts.get(id);
    let font = fonts?.keys().next().value as string | undefined;
    let run = '';
    for (const op of text.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj/g)) {
      if (op[1]) {
        font = op[1];
        continue;
      }
      const cmap = font ? fonts?.get(font) : undefined;
      const hex = op[2]!;
      for (let i = 0; i + 4 <= hex.length; i += 4) {
        const glyph = Number.parseInt(hex.slice(i, i + 4), 16);
        run += cmap?.get(glyph) ?? '';
      }
    }
    pieces.push(run);
  }
  return pieces.join('\n');
}

function exportText(buf: Buffer, ext: string): string {
  if (ext === 'docx') return unzip(buf).get('word/document.xml')?.toString('utf8') ?? '';
  if (ext === 'epub') {
    return [...unzip(buf).entries()]
      .filter(([name]) => name.endsWith('.xhtml') || name.endsWith('.html'))
      .map(([, data]) => data.toString('utf8'))
      .join('\n');
  }
  if (ext === 'pdf') return pdfText(buf);
  throw new Error(`unknown export type ${ext}`);
}

function missingSceneTitles(buf: Buffer, ext: string, titles: string[]): string[] {
  const hay = exportText(buf, ext).toLowerCase();
  return titles.filter((title) => !hay.includes(title.toLowerCase()));
}

function assertExportBytes(exportDir: string, ext: string, magic: string): void {
  const names = fs.readdirSync(exportDir).filter((name) => name.endsWith(`.${ext}`));
  expect(names, `expected a .${ext} file in ${exportDir}`).toHaveLength(1);
  const buf = fs.readFileSync(path.join(exportDir, names[0]!));
  expect(buf.length, `${ext} export must contain the 301-scene book`).toBeGreaterThan(10_000);
  expect(buf.subarray(0, magic.length).toString('latin1')).toBe(magic);
  const titles = allSceneTitles();
  const missing = missingSceneTitles(buf, ext, titles);
  expect(missing, `${ext} export is missing ${missing.length} of ${titles.length} scene titles`).toEqual([]);
}

const VIEW_READY: Record<string, string> = {
  'Notes Editor': '[data-testid="notes-tab-panel"]',
  Mythos: '[aria-label="Brainstorm prompt"]',
  Timeline: '[data-testid="timeline-root"]',
};

async function switchView(page: Page, label: string): Promise<number> {
  const ready = VIEW_READY[label];
  if (!ready) throw new Error(`no destination content for ${label}`);
  const nav = page.locator('nav[aria-label="Main navigation"]');
  const button = nav.getByRole('button', { name: label, exact: true });
  await expect(button).toBeVisible({ timeout: 15_000 });
  // Trial click waits out layout from the previous view. The clock stops when
  // that view's own content is on screen, seen on an animation frame, then
  // two more frames. aria-current alone is not the stop.
  await button.click({ trial: true, timeout: 20_000 });
  const started = Date.now();
  await button.click({ force: true, noWaitAfter: true });
  await page.waitForFunction((selector: string) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }, ready, { polling: 'raf', timeout: 30_000 });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  return Date.now() - started;
}

let emptyVault: SeededVault;
let largeVault: SeededVault;
const openApps: ElectronApplication[] = [];

test.beforeAll(() => {
  assertBudgetsWithinCaps();
  expect(fs.existsSync(MAIN_JS), `packaged build missing at ${MAIN_JS}`).toBe(true);
  emptyVault = seedVault(0);
  largeVault = seedVault(SMALL_SCENE_COUNT);
  const sceneFiles = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
  expect(sceneFiles(emptyVault.chapterDir)).toEqual(['Scene 000.md']);
  expect(sceneFiles(largeVault.chapterDir)).toHaveLength(SCENE_COUNT);
  expect(fs.readFileSync(path.join(largeVault.chapterDir, 'Scene 000.md'), 'utf8')).toContain(TAIL);
  const bigStat = fs.statSync(path.join(largeVault.chapterDir, 'Scene 000.md'));
  expect(bigStat.size).toBeGreaterThan(BIG_BYTES);
});

test.afterAll(async () => {
  for (const app of openApps) {
    await app.close().catch(() => undefined);
  }
  for (const vault of [emptyVault, largeVault]) {
    if (vault) fs.rmSync(vault.root, { recursive: true, force: true });
  }
});

async function launchMeasured(userData: string): Promise<{ app: ElectronApplication; page: Page; started: number }> {
  const started = Date.now();
  const app = await launchApp(userData, { reducedMotion: true });
  openApps.push(app);
  const page = await firstWindow(app);
  page.on('pageerror', (error) => console.log('[renderer:pageerror]', error.message));
  return { app, page, started };
}

test('a file that drops one scene fails the export completeness check', () => {
  const titles = allSceneTitles();
  const dropped = 'Scene 017';
  const kept = titles.filter((title) => title !== dropped).join(' ');
  const docx = zipStored({ 'word/document.xml': `<document>${kept}</document>` });
  const epub = zipStored({ 'OEBPS/ch.xhtml': `<html><body><h3>${kept}</h3></body></html>` });
  const pdf = Buffer.from(`%PDF-1.4\n1 0 obj<</Length ${kept.length}>>stream\n${kept}\nendstream\nendobj\n%%EOF`);
  expect(missingSceneTitles(docx, 'docx', titles)).toEqual([dropped]);
  expect(missingSceneTitles(epub, 'epub', titles)).toEqual([dropped]);
  expect(missingSceneTitles(pdf, 'pdf', titles)).toEqual([dropped]);
  expect(() => {
    const missing = missingSceneTitles(docx, 'docx', titles);
    if (missing.length > 0) throw new Error(`export missing ${missing[0]}`);
  }).toThrow(/Scene 017/);
});

test('launch to story tree, empty vault', async () => {
  test.setTimeout(120_000);
  const { app, page, started } = await launchMeasured(emptyVault.userData);
  try {
    await revealStoryTree(page);
    perf('launch_empty_to_story_tree_ms', Date.now() - started);
  } finally {
    await app.close().catch(() => undefined);
  }
});

test('launch 300-scene vault, open 500KB scene, switch view, export book', async () => {
  test.setTimeout(240_000);
  const exportDir = path.join(largeVault.root, `exports-${test.info().repeatEachIndex}`);
  fs.mkdirSync(exportDir);

  const { app, page, started } = await launchMeasured(largeVault.userData);
  await revealStoryTree(page);
  perf('launch_300_to_story_tree_ms', Date.now() - started);

  await patchSaveDialog(app, exportDir);

  const chapterRow = page.getByRole('button', { name: /Chapter One/ }).first();
  const big = page.getByRole('button', { name: /Big Scene/ }).first();
  if (!(await chapterRow.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: new RegExp(STORY_TITLE) }).first().click();
  }
  await expect(chapterRow).toBeVisible({ timeout: 20_000 });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await big.isVisible().catch(() => false)) break;
    await chapterRow.click();
    try {
      await big.waitFor({ state: 'visible', timeout: 3_000 });
      break;
    } catch {
      /* reindex collapsed the chapter — retry */
    }
  }
  await expect(big).toBeVisible({ timeout: 20_000 });

  const editor = page.locator('.ProseMirror').first();
  const other = page.getByRole('button', { name: /Scene 001/ }).first();
  await other.click();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor).toContainText('Lorem', { timeout: 30_000 });
  await expect(editor).not.toContainText(TAIL, { timeout: 30_000 });

  const openStarted = Date.now();
  await big.click();
  await page.waitForFunction((tail: string) => {
    const editorEl = document.querySelector('.ProseMirror');
    return !!editorEl && (editorEl.textContent ?? '').includes(tail);
  }, TAIL, { polling: 'raf', timeout: 60_000 });
  perf('open_big_scene_500kb_ms', Date.now() - openStarted);
  await expect(editor).toContainText(TAIL);

  const nav = page.locator('nav[aria-label="Main navigation"]');
  const navLabels = (await nav.getByRole('button').allInnerTexts()).map((label) => label.trim()).filter(Boolean);
  console.log(`[perf] nav=${JSON.stringify(navLabels)}`);

  // Notes Editor is the first switch off the 500 KB scene and is gated.
  // The first Mythos open and the first Timeline switch after it are not
  // gated yet (#1929). They are logged as [perf] detail only. The gated
  // Mythos and Timeline samples are the next switch in this launch.
  // Boards and the return to Story Writer stay out (slice 11).
  perf('switch_notes_editor_ms', await switchView(page, 'Notes Editor'));
  await dismissBackdrop(page);
  await expect(page.getByTestId('notes-tab-panel')).toBeVisible({ timeout: 15_000 });

  const mythosCold = await switchView(page, 'Mythos');
  console.log(`[perf] detail mythos_first_open_ms=${mythosCold}`);
  await dismissBackdrop(page);
  await expect(page.getByRole('textbox', { name: 'Brainstorm prompt' })).toBeVisible({ timeout: 15_000 });

  const timelineCold = await switchView(page, 'Timeline');
  console.log(`[perf] detail timeline_first_open_ms=${timelineCold}`);
  await dismissBackdrop(page);
  await expect(page.getByTestId('timeline-root')).toBeVisible({ timeout: 15_000 });

  perf('switch_mythos_ms', await switchView(page, 'Mythos'));
  await dismissBackdrop(page);
  await expect(page.getByRole('textbox', { name: 'Brainstorm prompt' })).toBeVisible({ timeout: 15_000 });

  perf('switch_timeline_ms', await switchView(page, 'Timeline'));
  await dismissBackdrop(page);
  await expect(page.getByTestId('timeline-root')).toBeVisible({ timeout: 15_000 });

  const formats: Array<{ value: string; metric: PerfMetric; magic: string }> = [
    { value: 'docx', metric: 'export_docx_301_ms', magic: 'PK' },
    { value: 'epub', metric: 'export_epub_301_ms', magic: 'PK' },
    { value: 'pdf', metric: 'export_pdf_301_ms', magic: '%PDF' },
  ];
  for (const format of formats) {
    await page.getByTestId('wc-menu-file').click();
    await page.locator('.wc-menu-item', { hasText: 'Export…' }).click();
    const dialog = page.locator('[role="dialog"][aria-labelledby="export-dialog-title"]');
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Full book', exact: true }).click();
    await expect(dialog.getByText(`${SCENE_COUNT} scenes`)).toBeVisible({ timeout: 15_000 });
    await dialog.locator(`input[type="radio"][value="${format.value}"]`).click();
    const exportStarted = Date.now();
    await dialog.getByRole('button', { name: /^Export/ }).click();
    await page.waitForFunction(() => {
      const dialogEl = document.querySelector('[role="dialog"][aria-labelledby="export-dialog-title"]');
      if (!dialogEl) return false;
      for (const el of dialogEl.querySelectorAll('*')) {
        if ((el.textContent ?? '').trim() !== 'Export complete') continue;
        const box = el.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) return true;
      }
      return false;
    }, null, { polling: 'raf', timeout: 120_000 });
    perf(format.metric, Date.now() - exportStarted);
    await expect(dialog.getByText('Export complete')).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    assertExportBytes(exportDir, format.value, format.magic);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  }
  await app.close().catch(() => undefined);
});
