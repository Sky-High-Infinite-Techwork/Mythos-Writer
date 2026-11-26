import { describe, expect, it } from 'vitest';
import {
  DOCK_TAB_ATTR,
  DOCK_TAB_SIDE_ATTR,
  dockIndexForVisibleSlot,
  dockMoveMenuItems,
  slotFromPoint,
} from './sidebarDockDnd';

/** A zone with tabs laid out at the given rects (jsdom has no layout). */
function zoneWithTabs(side: 'left' | 'right', rects: Array<[left: number, top: number, width: number, height: number]>, otherSide = 0) {
  const zone = document.createElement('div');
  const add = (s: string, r: [number, number, number, number]) => {
    const tab = document.createElement('button');
    tab.setAttribute(DOCK_TAB_ATTR, 'x');
    tab.setAttribute(DOCK_TAB_SIDE_ATTR, s);
    const [left, top, width, height] = r;
    tab.getBoundingClientRect = () => ({
      left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
    }) as DOMRect;
    zone.appendChild(tab);
  };
  rects.forEach((r) => add(side, r));
  // Tabs of a nested zone for the other side must be ignored.
  for (let i = 0; i < otherSide; i += 1) add(side === 'left' ? 'right' : 'left', [0, 0, 1000, 1000]);
  return zone;
}

describe('slotFromPoint', () => {
  const row: Array<[number, number, number, number]> = [[0, 0, 100, 30], [100, 0, 100, 30], [200, 0, 100, 30]];

  it('lands before the first tab whose midpoint is right of the pointer', () => {
    const zone = zoneWithTabs('right', row);
    expect(slotFromPoint(zone, 'right', 10, 10)).toBe(0);
    expect(slotFromPoint(zone, 'right', 60, 10)).toBe(1);
    expect(slotFromPoint(zone, 'right', 149, 10)).toBe(1);
    expect(slotFromPoint(zone, 'right', 151, 10)).toBe(2);
    expect(slotFromPoint(zone, 'right', 290, 10)).toBe(3);
  });

  it('appends when the pointer is below the tab row (over the panel body)', () => {
    expect(slotFromPoint(zoneWithTabs('right', row), 'right', 10, 400)).toBe(3);
  });

  it('handles wrapped rows: a pointer above a row lands before its first tab', () => {
    const zone = zoneWithTabs('left', [[0, 0, 100, 30], [0, 30, 100, 30]]);
    expect(slotFromPoint(zone, 'left', 90, 40)).toBe(2);
    expect(slotFromPoint(zone, 'left', 10, 40)).toBe(1);
  });

  it('ignores tabs that belong to the other sidebar', () => {
    expect(slotFromPoint(zoneWithTabs('left', [], 2), 'left', 5, 5)).toBe(0);
  });
});

describe('dockIndexForVisibleSlot', () => {
  const full = ['hub-partner', 'hub-suggestions', 'hub-scenes', 'hub-notes-analysis'] as const;

  it('is the identity when every panel is visible', () => {
    expect(dockIndexForVisibleSlot([...full], [...full], 0)).toBe(0);
    expect(dockIndexForVisibleSlot([...full], [...full], 2)).toBe(2);
    expect(dockIndexForVisibleSlot([...full], [...full], 4)).toBe(4);
  });

  it('keeps AI-off panels (hidden) in place: slots map to the full list', () => {
    const visible = ['hub-scenes', 'hub-notes-analysis'] as const;
    expect(dockIndexForVisibleSlot([...full], [...visible], 0)).toBe(2);
    expect(dockIndexForVisibleSlot([...full], [...visible], 1)).toBe(3);
    expect(dockIndexForVisibleSlot([...full], [...visible], 2)).toBe(4);
  });

  it('maps an empty sidebar to slot 0', () => {
    expect(dockIndexForVisibleSlot([], [], 0)).toBe(0);
  });
});

describe('dockMoveMenuItems', () => {
  it('disables the move that would not change anything', () => {
    const left = dockMoveMenuItems('left', 0, 1);
    expect(left.find((i) => i.id === 'move-left')?.disabled).toBe(true);
    expect(left.find((i) => i.id === 'move-right')?.disabled).toBe(false);
    expect(left.find((i) => i.id === 'move-earlier')?.disabled).toBe(true);
    expect(left.find((i) => i.id === 'move-later')?.disabled).toBe(true);

    const right = dockMoveMenuItems('right', 1, 3);
    expect(right.find((i) => i.id === 'move-left')?.disabled).toBe(false);
    expect(right.find((i) => i.id === 'move-right')?.disabled).toBe(true);
    expect(right.find((i) => i.id === 'move-earlier')?.disabled).toBe(false);
    expect(right.find((i) => i.id === 'move-later')?.disabled).toBe(false);
  });
});
