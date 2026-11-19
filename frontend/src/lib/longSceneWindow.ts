/**
 * A scene of thousands of paragraphs is one TipTap document today, and every
 * keystroke pays for all of those DOM nodes. Past this size the editor mounts
 * only a window at the end (where writing happens) and stitches edits back
 * into the full markdown.
 */
export const LONG_SCENE_PARAS = 120;
export const LONG_SCENE_WINDOW = 48;

export function splitSceneParagraphs(markdown: string): string[] {
  const body = markdown.replace(/\n+$/, '');
  if (!body) return [];
  return body.split(/\n\n/);
}

export function windowStartForEnd(count: number, windowSize = LONG_SCENE_WINDOW): number {
  return Math.max(0, count - windowSize);
}

export function visibleSlice(parts: readonly string[], start: number, count: number): string {
  return parts.slice(start, start + count).join('\n\n');
}

export function stitchWindow(
  parts: readonly string[],
  start: number,
  previousCount: number,
  windowMarkdown: string,
): { parts: string[]; windowCount: number } {
  const edited = splitSceneParagraphs(windowMarkdown);
  const next = parts.slice();
  next.splice(start, previousCount, ...edited);
  return { parts: next, windowCount: edited.length };
}
