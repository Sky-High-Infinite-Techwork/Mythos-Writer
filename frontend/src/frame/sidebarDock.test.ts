import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_DOCK_PANEL_IDS,
  defaultSidebarDock,
  isSidebarDockPanelId,
  moveSidebarPanel,
  normalizeSidebarDock,
  sidebarDocksEqual,
  sidebarOfPanel,
  type SidebarDockState,
} from './sidebarDock';
import { PANEL_REGISTRY } from './panelRegistry';

const DEFAULT: SidebarDockState = {
  left: ['story-navigator'],
  right: ['hub-partner', 'hub-suggestions', 'hub-scenes', 'hub-notes-analysis'],
};

describe('sidebarDock', () => {
  it('defaults to the layout the sidebars had before panels could move', () => {
    expect(defaultSidebarDock()).toEqual(DEFAULT);
    const a = defaultSidebarDock();
    a.left.pop();
    expect(defaultSidebarDock()).toEqual(DEFAULT);
  });

  it('never shares an id with the legacy panel registry', () => {
    const legacy = new Set<string>(PANEL_REGISTRY.map((e) => e.id));
    expect(SIDEBAR_DOCK_PANEL_IDS.filter((id) => legacy.has(id))).toEqual([]);
    expect(isSidebarDockPanelId('hub-scenes')).toBe(true);
    expect(isSidebarDockPanelId('scenes')).toBe(false);
    expect(isSidebarDockPanelId(undefined)).toBe(false);
  });

  describe('normalizeSidebarDock', () => {
    it('returns the default for absent or malformed input', () => {
      expect(normalizeSidebarDock(undefined)).toEqual(DEFAULT);
      expect(normalizeSidebarDock(null)).toEqual(DEFAULT);
      expect(normalizeSidebarDock('left')).toEqual(DEFAULT);
      expect(normalizeSidebarDock({ left: 'story-navigator', right: 7 })).toEqual(DEFAULT);
    });

    it('keeps a saved placement and order', () => {
      const saved = { left: ['hub-scenes', 'story-navigator'], right: ['hub-notes-analysis', 'hub-partner', 'hub-suggestions'] };
      expect(normalizeSidebarDock(saved)).toEqual(saved);
    });

    it('drops unknown ids and duplicates, first placement wins', () => {
      expect(normalizeSidebarDock({
        left: ['story-navigator', 'nope', 'hub-scenes', 'story-navigator'],
        right: ['hub-scenes', 'hub-partner', 'hub-suggestions', 'hub-notes-analysis', 42],
      })).toEqual({
        left: ['story-navigator', 'hub-scenes'],
        right: ['hub-partner', 'hub-suggestions', 'hub-notes-analysis'],
      });
    });

    it('puts panels missing from both sides back on their default side, at the end', () => {
      expect(normalizeSidebarDock({ left: ['hub-partner'], right: [] })).toEqual({
        left: ['hub-partner', 'story-navigator'],
        right: ['hub-suggestions', 'hub-scenes', 'hub-notes-analysis'],
      });
    });
  });

  describe('moveSidebarPanel', () => {
    it('moves a panel from the left sidebar to the right at the drop index', () => {
      expect(moveSidebarPanel(DEFAULT, 'story-navigator', 'right', 1)).toEqual({
        left: [],
        right: ['hub-partner', 'story-navigator', 'hub-suggestions', 'hub-scenes', 'hub-notes-analysis'],
      });
    });

    it('moves a panel from the right sidebar to the left', () => {
      expect(moveSidebarPanel(DEFAULT, 'hub-scenes', 'left', 0)).toEqual({
        left: ['hub-scenes', 'story-navigator'],
        right: ['hub-partner', 'hub-suggestions', 'hub-notes-analysis'],
      });
    });

    it('appends when the index is past the end, and clamps negatives to the start', () => {
      expect(moveSidebarPanel(DEFAULT, 'hub-partner', 'left', 99).left).toEqual(['story-navigator', 'hub-partner']);
      expect(moveSidebarPanel(DEFAULT, 'hub-partner', 'left', -3).left).toEqual(['hub-partner', 'story-navigator']);
      expect(moveSidebarPanel(DEFAULT, 'hub-partner', 'left', Number.NaN).left).toEqual(['story-navigator', 'hub-partner']);
    });

    it('reorders within one sidebar using before-move slot indices', () => {
      // Drag Partner (slot 0) to the slot after Scenes (index 3).
      expect(moveSidebarPanel(DEFAULT, 'hub-partner', 'right', 3).right)
        .toEqual(['hub-suggestions', 'hub-scenes', 'hub-partner', 'hub-notes-analysis']);
      // Drag Notes & Analysis (slot 3) to the front.
      expect(moveSidebarPanel(DEFAULT, 'hub-notes-analysis', 'right', 0).right)
        .toEqual(['hub-notes-analysis', 'hub-partner', 'hub-suggestions', 'hub-scenes']);
    });

    it('returns the same state object when dropped on its own slot', () => {
      expect(moveSidebarPanel(DEFAULT, 'hub-scenes', 'right', 2)).toBe(DEFAULT);
      expect(moveSidebarPanel(DEFAULT, 'hub-scenes', 'right', 3)).toBe(DEFAULT);
      expect(moveSidebarPanel(DEFAULT, 'story-navigator', 'left', 0)).toBe(DEFAULT);
    });

    it('never mutates its input', () => {
      const before = JSON.stringify(DEFAULT);
      moveSidebarPanel(DEFAULT, 'hub-scenes', 'left', 0);
      moveSidebarPanel(DEFAULT, 'hub-partner', 'right', 4);
      expect(JSON.stringify(DEFAULT)).toBe(before);
    });

    it('round-trips: left to right and back restores the default', () => {
      const moved = moveSidebarPanel(DEFAULT, 'story-navigator', 'right', 4);
      expect(sidebarOfPanel(moved, 'story-navigator')).toBe('right');
      const back = moveSidebarPanel(moved, 'story-navigator', 'left', 0);
      expect(sidebarDocksEqual(back, DEFAULT)).toBe(true);
      expect(normalizeSidebarDock(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
    });
  });
});
