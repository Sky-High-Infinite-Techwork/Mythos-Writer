/** Owns which shell sidebar (left or right) each live sidebar panel docks in, and in what order. Pure: never reads settings, never renders. */

/**
 * Every panel the shell's two sidebars render today, by stable id:
 * - `story-navigator`: the Story page's left rail (vault picker, story card,
 *   navigator, Prism checklist).
 * - `hub-*`: the right sidebar's Agent Hub tabs (partner, Suggestions, Scenes,
 *   Notes & Analysis).
 * Kept distinct from the legacy `WidgetId` catalog (panelRegistry.ts), which
 * still names the pre-M6 panel system that no sidebar renders any more.
 */
export const SIDEBAR_DOCK_PANEL_IDS = [
  'story-navigator',
  'hub-partner',
  'hub-suggestions',
  'hub-scenes',
  'hub-notes-analysis',
] as const;

export type SidebarDockPanelId = (typeof SIDEBAR_DOCK_PANEL_IDS)[number];
export type SidebarDockSide = 'left' | 'right';

export interface SidebarDockState {
  left: SidebarDockPanelId[];
  right: SidebarDockPanelId[];
}

/** Where each panel lived before panels could move — the layout a fresh profile keeps. */
const DEFAULT_SIDE: Record<SidebarDockPanelId, SidebarDockSide> = {
  'story-navigator': 'left',
  'hub-partner': 'right',
  'hub-suggestions': 'right',
  'hub-scenes': 'right',
  'hub-notes-analysis': 'right',
};

/** Fresh copy of today's layout: navigator on the left, Agent Hub tabs on the right. */
export function defaultSidebarDock(): SidebarDockState {
  return {
    left: SIDEBAR_DOCK_PANEL_IDS.filter((id) => DEFAULT_SIDE[id] === 'left'),
    right: SIDEBAR_DOCK_PANEL_IDS.filter((id) => DEFAULT_SIDE[id] === 'right'),
  };
}

export function isSidebarDockPanelId(value: unknown): value is SidebarDockPanelId {
  return typeof value === 'string' && (SIDEBAR_DOCK_PANEL_IDS as readonly string[]).includes(value);
}

/**
 * Turn whatever was persisted into a valid dock: unknown ids and duplicates are
 * dropped (first placement wins, left before right), and any panel missing from
 * both sides goes back to its default side, after the panels already there.
 * Absent or malformed input yields the default layout.
 */
export function normalizeSidebarDock(raw: unknown): SidebarDockState {
  const source = (raw && typeof raw === 'object') ? raw as Partial<Record<SidebarDockSide, unknown>> : {};
  const seen = new Set<SidebarDockPanelId>();
  const pick = (list: unknown): SidebarDockPanelId[] => {
    if (!Array.isArray(list)) return [];
    const out: SidebarDockPanelId[] = [];
    for (const id of list) {
      if (isSidebarDockPanelId(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  };
  const left = pick(source.left);
  const right = pick(source.right);
  for (const id of SIDEBAR_DOCK_PANEL_IDS) {
    if (seen.has(id)) continue;
    (DEFAULT_SIDE[id] === 'left' ? left : right).push(id);
  }
  return { left, right };
}

export function sidebarOfPanel(state: SidebarDockState, id: SidebarDockPanelId): SidebarDockSide {
  return state.left.includes(id) ? 'left' : 'right';
}

/**
 * Move `id` to `toSide` at insertion index `toIndex` (0 = first; the list
 * length or more = last). Indices count slots in the target list as it looks
 * before the move, so dropping a panel onto its own slot, or the slot just
 * after it, leaves the order unchanged. Returns `state` itself when nothing
 * changes, so callers can skip a settings write.
 */
export function moveSidebarPanel(
  state: SidebarDockState,
  id: SidebarDockPanelId,
  toSide: SidebarDockSide,
  toIndex: number,
): SidebarDockState {
  const fromSide = sidebarOfPanel(state, id);
  const fromIndex = state[fromSide].indexOf(id);
  if (fromIndex < 0) return state;
  const target = state[toSide];
  let insertAt = Math.max(0, Math.min(Number.isFinite(toIndex) ? Math.trunc(toIndex) : target.length, target.length));
  if (fromSide === toSide) {
    if (insertAt === fromIndex || insertAt === fromIndex + 1) return state;
    if (insertAt > fromIndex) insertAt -= 1;
  }
  const next: SidebarDockState = {
    left: state.left.filter((p) => p !== id),
    right: state.right.filter((p) => p !== id),
  };
  next[toSide].splice(insertAt, 0, id);
  return next;
}

export function sidebarDocksEqual(a: SidebarDockState, b: SidebarDockState): boolean {
  return a.left.length === b.left.length
    && a.right.length === b.right.length
    && a.left.every((id, i) => b.left[i] === id)
    && a.right.every((id, i) => b.right[i] === id);
}
