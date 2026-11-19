import { describe, expect, it } from 'vitest';
import {
  LONG_SCENE_WINDOW,
  splitSceneParagraphs,
  stitchWindow,
  visibleSlice,
  windowStartForEnd,
} from './longSceneWindow';

describe('long scene window', () => {
  it('keeps the hidden prefix when the visible tail is edited', () => {
    const parts = ['one', 'two', 'three', 'four', 'five'];
    const start = windowStartForEnd(parts.length, 2);
    expect(start).toBe(3);
    expect(visibleSlice(parts, start, 2)).toBe('four\n\nfive');
    const stitched = stitchWindow(parts, start, 2, 'four\n\nfive plus\n');
    expect(stitched.parts).toEqual(['one', 'two', 'three', 'four', 'five plus']);
    expect(stitched.windowCount).toBe(2);
  });

  it('opens a long scene on the last window, not paragraph zero', () => {
    expect(windowStartForEnd(9000, LONG_SCENE_WINDOW)).toBe(9000 - LONG_SCENE_WINDOW);
  });

  it('splits on blank lines and drops the trailing newline the serializer adds', () => {
    expect(splitSceneParagraphs('Alpha.\n\nBeta.\n')).toEqual(['Alpha.', 'Beta.']);
  });
});
