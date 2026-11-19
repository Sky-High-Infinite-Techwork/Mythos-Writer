/**
 * Big-scene typing and view-switch budgets (#1914).
 *
 * Packaged build, reduced motion, veynn-v2 vault: 300 × 8KB scenes + one
 * 500KB scene. One measured sample per metric. Hard caps (never looser):
 *   20-char burst ≤ 1200ms
 *   switch back to Story Writer ≤ 2500ms
 *   Boards ≤ 3000ms
 * Keystroke p95 and the Timeline switch use the same calibration formula
 * (max(2× p95, 1.25× max) over 20 runs) and are asserted below.
 *
 * BIG_DOC_TRACE=1 records CDP long tasks around the burst and the switches.
 * That overhead is not part of a budget run.
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
import { focusEditorAtEnd, logLongTasks, measureKeystrokeAtEnd, traceLongTasks } from './big-doc-trace';

/**
 * Budgets from 20 GitHub e2e-shard-3 runs on b3b2fb75 (run 44466707465,
 * job 135366448053, BIG_DOC_REPORT=1, --retries=0). Nearest-rank p95 is the
 * 19th of 20 sorted samples. budget = max(2× p95, 1.25× max), then clamped
 * to the #1914 caps (burst 1200, switch-back 2500, Boards 3000). Keystroke
 * p95 and Timeline have no numeric cap.
 *
 *   metric              p95    max    formula   budget
 *   keystroke_p95_ms    7237   7566   14474     14474
 *   burst_20_ms         2110   2381   4220      1200   (cap; 8/20 over it)
 *   switch_timeline_ms  2116   2124   4232      4232
 *   switch_back_story   2339   2527   4678      2500   (cap; 1/20 over it)
 *   switch_boards_ms    1519   1551   3038      3000   (cap; all 20 under it)
 *
 * Burst and switch-back stay at the caps. Those caps are below the observed
 * max, so 20/20 first-try enforce cannot pass on this runner without the
 * deleted tail window. The asserts stay so a sample over the cap fails.
 */
const KEYSTROKE_P95_MS = 14474;
const BURST_MS = 1200;
const TIMELINE_MS = 4232;
const SWITCH_BACK_MS = 2500;
const BOARDS_MS = 3000;

const TRACE = process.env.BIG_DOC_TRACE === '1';
/** Log timings and skip budget asserts. Autosave still has to match the file bytes. */
const REPORT = process.env.BIG_DOC_REPORT === '1';
const KEYSTROKE_CHARS = 'x'.repeat(20);

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

function perf(metric: string, ms: number, budget: number): void {
  // eslint-disable-next-line no-console
  console.log(`[perf] metric=${metric} ms=${Math.round(ms)} budget=${budget} n=1`);
}

async function dismissStoriesPopover(page: Page): Promise<void> {
  const backdrop = page.locator('[data-testid="nav-rail-stories-backdrop"]');
  if (await backdrop.count()) {
    await backdrop.click({ position: { x: 5, y: 5 }, force: true });
    await expect(backdrop).toHaveCount(0);
  }
}

async function switchView(page: Page, testId: string): Promise<number> {
  const button = page.getByTestId(testId);
  await expect(button).toBeVisible();
  const started = Date.now();
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await page.evaluate(
    () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }),
  );
  return Date.now() - started;
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

test.describe('big scene typing and view switch', () => {
  test('500KB scene stays responsive while typing and switching views', async () => {
    test.setTimeout(360_000);
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
      // eslint-disable-next-line no-console
      console.log(`[perf] editor paras=${shape.paras} chars=${shape.chars} scenes=${SCENE_COUNT}`);
      expect(shape.paras).toBeGreaterThan(1000);
      expect(shape.chars).toBeGreaterThan(400_000);
      expect(manuscriptBody(original).startsWith(`${HEAD}\n`)).toBe(true);

      if (TRACE) {
        await focusEditorAtEnd(page);
        const five = await traceLongTasks(page, async () => {
          const t0 = Date.now();
          for (let i = 0; i < 5; i++) {
            await page.keyboard.type('x', { delay: 0 });
            await page.evaluate(() => new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }));
          }
          return Date.now() - t0;
        });
        logLongTasks('five_keys', five.top);
        perf('five_keys_wall_ms', five.result, 0);
      }

      const keystroke = await measureKeystrokeAtEnd(page, 20);
      perf('keystroke_p95_ms', keystroke.p95, KEYSTROKE_P95_MS);
      // eslint-disable-next-line no-console
      console.log(
        `[perf] metric=keystroke_p50_ms ms=${Math.round(keystroke.p50)} samples=${keystroke.samples.length}`,
      );

      // Let the keystroke sample's autosave land before the burst clock
      // starts, so this metric is the 20-character type itself.
      await expect.poll(() => fs.readFileSync(seed.scenePath).includes(Buffer.from('xxxxxxxxxx')), {
        timeout: 8_000,
        intervals: [100, 200, 400],
      }).toBe(true);

      await focusEditorAtEnd(page);
      const burst = TRACE
        ? await traceLongTasks(page, async () => {
          const t0 = Date.now();
          await page.keyboard.type(BURST);
          return Date.now() - t0;
        })
        : { result: await (async () => {
          const t0 = Date.now();
          await page.keyboard.type(BURST);
          return Date.now() - t0;
        })(), top: [] };
      if (TRACE) logLongTasks('burst', burst.top);
      perf('burst_20_ms', burst.result, BURST_MS);

      const typed = KEYSTROKE_CHARS + BURST;
      const expectedProse = bodyWithTyped(manuscriptBody(original), typed);
      let saved = false;
      try {
        await expect.poll(() => savedProse(fs.readFileSync(seed.scenePath)) === expectedProse, {
          timeout: 8_000,
          intervals: [200, 400, 800],
        }).toBe(true);
        saved = true;
      } catch {
        saved = false;
      }
      // eslint-disable-next-line no-console
      console.log(`[perf] metric=autosave_on_disk saved=${saved ? 1 : 0}`);

      const timeline = TRACE
        ? await traceLongTasks(page, () => switchView(page, 'nav-rail-timeline'))
        : { result: await switchView(page, 'nav-rail-timeline'), top: [] };
      if (TRACE) logLongTasks('timeline', timeline.top);
      perf('switch_timeline_ms', timeline.result, TIMELINE_MS);

      const back = TRACE
        ? await traceLongTasks(page, () => switchView(page, 'nav-rail-story'))
        : { result: await switchView(page, 'nav-rail-story'), top: [] };
      if (TRACE) logLongTasks('switch_back_story', back.top);
      perf('switch_back_story_ms', back.result, SWITCH_BACK_MS);
      await dismissStoriesPopover(page);
      await expect(page.locator('.ProseMirror').first()).toContainText(TAIL, { timeout: 30_000 });

      const boards = TRACE
        ? await traceLongTasks(page, () => switchView(page, 'nav-rail-boards'))
        : { result: await switchView(page, 'nav-rail-boards'), top: [] };
      if (TRACE) logLongTasks('boards', boards.top);
      perf('switch_boards_ms', boards.result, BOARDS_MS);

      expect(keystroke.samples.length).toBeGreaterThanOrEqual(10);
      expect(saved, 'autosave kept the original prose and appended the typed characters').toBe(true);
      if (!REPORT) {
        expect(keystroke.p95).toBeLessThanOrEqual(KEYSTROKE_P95_MS);
        expect(burst.result).toBeLessThanOrEqual(BURST_MS);
        expect(timeline.result).toBeLessThanOrEqual(TIMELINE_MS);
        expect(back.result).toBeLessThanOrEqual(SWITCH_BACK_MS);
        expect(boards.result).toBeLessThanOrEqual(BOARDS_MS);
      }
    } finally {
      await app.close().catch(() => undefined);
      rmBigDoc(seed);
    }
  });
});
