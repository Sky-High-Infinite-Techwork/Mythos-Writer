/**
 * streamingFrames.ts — SKY-8217 metric 4 support: "No dropped frames with
 * agents live."
 *
 * Drives a REAL hub partner chat streaming session — the only thing mocked
 * is the `agent:brainstorm` IPC handler in the Electron main process
 * (the Anthropic network boundary). Partner send (`ahp-partner-chat-send`) goes
 * through `invokeBrainstorm` → `agent:brainstorm`, matching
 * `electron-main/src/main.ts` stream-start + chunk events on
 * `agent:brainstorm:stream-start` / `agent:brainstorm:chunk`.
 *
 * This file only installs the mock, opens the chat panel, and sends a
 * prompt — it does NOT sample frames. The integration spec is expected to
 * call `sampleFrameDeltas`/`summarizeFrames` (animationFps.ts) concurrently
 * with `sendPromptAndWaitForStreamStart`'s returned promise, e.g. via
 * `Promise.all`, so frame-drop can be measured while the stream is live and
 * compared against the metric-3 idle baseline.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { openPartnerWriterTips } from '../../helpers/partnerHub';

/**
 * Small, deterministic word bank for generating lorem-ipsum-style stream
 * tokens. Not meant to be prose — just short, distinct chunks that exercise
 * the renderer's per-chunk append path the same way a real streamed
 * completion would.
 */
const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et',
  'dolore', 'magna', 'aliqua', 'enim', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex',
];

/** Generates `count` short word tokens (each with a trailing space) cycling through LOREM_WORDS. */
function generateLoremTokens(count: number): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < count; i++) {
    tokens.push(`${LOREM_WORDS[i % LOREM_WORDS.length]} `);
  }
  return tokens;
}

export interface StreamingMockOptions {
  /** Number of streamed chunks to emit. Default 30. */
  tokenCount?: number;
  /** Delay in ms between chunks. Default 100. */
  chatDelayMs?: number;
}

/**
 * Installs the hub partner `agent:brainstorm` chat-stream IPC mock in the
 * Electron main process — not the full writing-assistant / tips surface from
 * `e2e/writing-assistant.spec.ts`'s `installIpcMocks`, since partner chat
 * never calls `agent:writing-assistant`.
 *
 * Defaults (tokenCount=30, chatDelayMs=100) keep a streaming window open for
 * ~3 seconds, giving `sampleFrameDeltas` (animationFps.ts) room to capture a
 * meaningful number of frames concurrently while the stream is in flight.
 */
export async function installMockChatStream(
  app: ElectronApplication,
  opts: StreamingMockOptions = {},
): Promise<void> {
  const { tokenCount = 30, chatDelayMs = 100 } = opts;
  const chatTokens = generateLoremTokens(tokenCount);
  const chatResponse = chatTokens.join('');

  await app.evaluate(
    async (
      { ipcMain },
      args: { chatTokens: string[]; chatResponse: string; chatDelayMs: number },
    ) => {
      const safeRemove = (channel: string) => {
        try {
          ipcMain.removeHandler(channel);
        } catch {
          /* not yet registered */
        }
      };
      safeRemove('agent:brainstorm');
      ipcMain.handle('agent:brainstorm', async (event) => {
        const requestId = `mock-brainstorm-${Date.now()}`;
        if (!event.sender.isDestroyed()) {
          event.sender.send('agent:brainstorm:stream-start', { requestId });
        }
        for (const token of args.chatTokens) {
          await new Promise<void>((r) => setTimeout(r, args.chatDelayMs));
          if (!event.sender.isDestroyed()) {
            event.sender.send('agent:brainstorm:chunk', { chunk: token });
          }
        }
        return { text: args.chatResponse };
      });
    },
    { chatTokens, chatResponse, chatDelayMs },
  );
}

/** Full mocked response text for assertions (default installMockChatStream tokens). */
export const DEFAULT_MOCK_CHAT_RESPONSE = generateLoremTokens(30).join('');

/**
 * Opens the Writing Coach chat view in the agent hub panel.
 *
 * Assumes the caller already navigated to the editor and opened a scene
 * (e.g. via `openSeededScene` in e2e/helpers/launchApp.ts) so the panel has scene context —
 * this only expands the panel and drills into the chat row, mirroring
 * `openWritingAssistantWithScene` in e2e/writing-assistant.spec.ts.
 */
export async function openWritingCoachChat(page: Page): Promise<void> {
  const hubPanel = page.locator('[data-testid="agent-hub-panel"]');
  await expect(hubPanel).toBeVisible({ timeout: 4_000 });
  const partnerTab = page.locator('[data-testid="ahp-tab-partner"]');
  if (await partnerTab.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await partnerTab.click();
  }
  await expect(page.getByTestId('ahp-partner-view')).toBeVisible({ timeout: 8_000 });
  const panel = page.locator('.writing-assistant-panel');
  if ((await panel.count()) === 0) {
    await openPartnerWriterTips(page);
  }
  await expect(page.locator('.writing-assistant-panel')).toBeAttached({ timeout: 8_000 });
  await expect(page.getByTestId('ahp-partner-chat-input')).toBeVisible({ timeout: 8_000 });
}

/**
 * Fills the Writing Coach prompt box, clicks Ask, and returns as soon as the
 * FIRST streamed chunk has visibly landed — not once the whole response has
 * finished. Callers want to sample frames WHILE the stream is still going,
 * so this deliberately does not wait for stream completion.
 *
 * "Stream has started" reuses the same signal e2e/writing-assistant.spec.ts's
 * TC-WA-10 uses to detect an in-progress assistant message: the partner hub
 * typing indicator (F3 N4-A: `.wa-cursor` is retired).
 */
export async function sendPromptAndWaitForStreamStart(page: Page, prompt: string): Promise<void> {
  const input = page.getByTestId('ahp-partner-chat-input');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await expect(input).toBeEnabled({ timeout: 5_000 });
  await input.fill(prompt);

  const askBtn = page.getByTestId('ahp-partner-chat-send');
  await expect(askBtn).toBeEnabled({ timeout: 5_000 });
  await askBtn.click();

  await expect(page.getByTestId('ahp-partner-typing')).toBeVisible({ timeout: 6_000 });
}