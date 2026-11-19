/**
 * Big-scene autosave and Boards (#1914 correctness slice).
 *
 * Packaged build, reduced motion, veynn-v2 vault: 300 × 8KB scenes + one
 * 500KB scene. Typing and the switch back to Story Writer are not gated
 * here; those stalls are a separate product issue. Boards stays: all 20
 * calibration runs on e2e-shard-3 were at most 1551 ms, under the 3000 ms
 * cap (run 44466707465).
 */
import fs from 'fs';
import { test, expect, type Page } from '@playwright/test';
import { launchApp, firstWindow } from '../helpers/launchApp';
import {
  BIG_SCENE_TITLE,
  BURST,
  HEAD,
  SCENE_COUNT,
  STORY_TITLE,
  TAIL,
  rmBigDoc,
  seedBigDoc,
  type BigDocSeed,
} from './big-doc-seed';

/** All 20 CI samples were ≤ 1551 ms. */
const BOARDS_MS = 3000;
const TYPED = `${'x'.repeat(20)}${BURST}`;

function manuscriptBody(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  const fence = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!fence) throw new Error('scene file has no frontmatter');
  return text.slice(fence[0].length);
}

/** Typed characters land in the last paragraph, before the body's trailing newline. */
function bodyWithTyped(body: string, typed: string): string {
  if (body.endsWith('\n')) return `${body.slice(0, -1)}${typed}\n`;
  return body + typed;
}

/**
 * blocksToMarkdown writes a blank line after the closing frontmatter fence and
 * another after the block. The prose between those is the saved manuscript.
 */
function savedProse(bytes: Buffer): string {
  const body = manuscriptBody(bytes);
  if (body.startsWith('\n') && body.endsWith('\n')) return body.slice(1, -1);
  return body;
}

async function dismissStoriesPopover(page: Page): Promise<void> {
  const backdrop = page.locator('[data-testid="nav-rail-stories-backdrop"]');
  if (await backdrop.count()) {
    await backdrop.click({ position: { x: 5, y: 5 }, force: true });
    await expect(backdrop).toHaveCount(0);
  }
}

async function focusEditorAtEnd(page: Page): Promise<void> {
  const editor = page.locator('.ProseMirror').first();
  await editor.click();
  await editor.evaluate((el) => {
    const node = el as HTMLElement;
    node.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

async function openBigScene(page: Page): Promise<void> {
  const storyBtn = page.getByTestId('nav-rail-story');
  await expect(storyBtn).toBeVisible({ timeout: 60_000 });
  if ((await storyBtn.getAttribute('aria-current')) !== 'page') {
    await storyBtn.click();
  }
  await dismissStoriesPopover(page);

  const storyRow = page.getByRole('button', { name: new RegExp(STORY_TITLE) }).first();
  await expect(storyRow).toBeVisible({ timeout: 60_000 });
  const chapterRow = page.getByRole('button', { name: /Chapter One/ }).first();
  if (!(await chapterRow.isVisible().catch(() => false))) {
    await storyRow.click();
  }
  await expect(chapterRow).toBeVisible({ timeout: 20_000 });

  const big = page.getByRole('button', { name: new RegExp(BIG_SCENE_TITLE) }).first();
  for (let attempt = 0; attempt < 6; attempt++) {
    await chapterRow.click();
    try {
      await big.waitFor({ state: 'visible', timeout: 3_000 });
      break;
    } catch {
      /* navigator collapsed again during reindex */
    }
  }
  await big.click();
  await expect(page.locator('.ProseMirror').first()).toContainText(TAIL, { timeout: 60_000 });
}

test.describe('big scene autosave', () => {
  test('500KB scene autosave keeps the original prose and Boards stays under the cap', async () => {
    test.setTimeout(180_000);
    const seed: BigDocSeed = seedBigDoc(SCENE_COUNT);
    const original = fs.readFileSync(seed.scenePath);
    const app = await launchApp(seed.userData);
    try {
      const page = await firstWindow(app);
      await openBigScene(page);

      const shape = await page.locator('.ProseMirror').first().evaluate((el) => ({
        paras: el.querySelectorAll('p').length,
        chars: el.textContent?.length ?? 0,
      }));
      expect(shape.paras).toBeGreaterThan(1000);
      expect(shape.chars).toBeGreaterThan(400_000);
      expect(manuscriptBody(original).startsWith(`${HEAD}\n`)).toBe(true);

      await focusEditorAtEnd(page);
      await page.keyboard.type(TYPED);

      const expectedProse = bodyWithTyped(manuscriptBody(original), TYPED);
      await expect.poll(() => savedProse(fs.readFileSync(seed.scenePath)) === expectedProse, {
        timeout: 8_000,
        intervals: [200, 400, 800],
      }).toBe(true);

      const boards = page.getByTestId('nav-rail-boards');
      await expect(boards).toBeVisible();
      const started = Date.now();
      await boards.click();
      await expect(boards).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
      await page.evaluate(
        () => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
      );
      const boardsMs = Date.now() - started;
      // eslint-disable-next-line no-console
      console.log(`[perf] metric=switch_boards_ms ms=${boardsMs} budget=${BOARDS_MS} n=1`);
      expect(boardsMs).toBeLessThanOrEqual(BOARDS_MS);
    } finally {
      await app.close().catch(() => undefined);
      rmBigDoc(seed);
    }
  });
});
