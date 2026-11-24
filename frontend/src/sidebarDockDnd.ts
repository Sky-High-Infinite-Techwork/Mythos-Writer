/** Wires one shell sidebar's panel tabs into PanelDragContext: HTML5 drag sources, a drop zone that reports the insertion slot, and keyboard/menu moves. */
import { useCallback, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import { useOptionalPanelDrag } from './PanelDragContext';
import {
  isSidebarDockPanelId,
  type SidebarDockPanelId,
  type SidebarDockSide,
  type SidebarDockState,
} from './frame/sidebarDock';

/** dataTransfer type set on every sidebar-panel drag (lets other drop targets ignore it). */
export const SIDEBAR_PANEL_DRAG_MIME = 'application/x-mythos-sidebar-panel';

/** Attribute on each draggable tab: its panel id. The drop zone reads tab rects through it. */
export const DOCK_TAB_ATTR = 'data-dock-panel';
/** Attribute on each draggable tab: the sidebar it belongs to (nested zones never read each other's tabs). */
export const DOCK_TAB_SIDE_ATTR = 'data-dock-side';

export interface DockMoveMenuState {
  id: SidebarDockPanelId;
  x: number;
  y: number;
}

export interface SidebarDockDnd {
  /** Spread on each panel tab button. */
  tabProps: (id: SidebarDockPanelId) => Record<string, unknown>;
  /** Spread on the sidebar's outer element: the whole sidebar accepts drops. */
  zoneProps: Record<string, unknown>;
  /** Visible-tab slot where a drop would land in this sidebar, or null. */
  dropSlot: number | null;
  /** True while any sidebar panel is being dragged (pointer drag). */
  dragging: boolean;
  /** Open "Move to …" menu for a tab, or null. */
  menu: DockMoveMenuState | null;
  closeMenu: () => void;
  /** Run a menu action id from dockMoveMenuItems(). */
  runMenuAction: (id: SidebarDockPanelId, action: string) => void;
}

interface Options {
  side: SidebarDockSide;
  dock: SidebarDockState;
  /** This sidebar's panels as shown (dock order, minus any hidden with AI off). */
  visible: SidebarDockPanelId[];
  /** The other sidebar's panels as shown — keyboard moves land among these. */
  otherVisible: SidebarDockPanelId[];
  labelOf: (id: SidebarDockPanelId) => string;
}

/** The linear slot walk used by keyboard moves: left sidebar first, then right. */
function linearOrder(side: SidebarDockSide, visible: SidebarDockPanelId[], otherVisible: SidebarDockPanelId[]) {
  return side === 'left'
    ? { left: visible, right: otherVisible }
    : { left: otherVisible, right: visible };
}

/** Map a slot among visible tabs to a slot in the full dock list (hidden AI-off panels keep their place). */
export function dockIndexForVisibleSlot(
  full: SidebarDockPanelId[],
  visible: SidebarDockPanelId[],
  slot: number,
): number {
  if (slot >= visible.length) return full.length;
  const anchor = visible[Math.max(0, slot)];
  const at = anchor ? full.indexOf(anchor) : -1;
  return at < 0 ? full.length : at;
}

/**
 * Where a drop at (x, y) lands among the tabs inside `zone` that belong to
 * `side`: before the first tab whose row has not been passed and whose
 * horizontal midpoint is right of the pointer; after the last tab otherwise.
 */
export function slotFromPoint(zone: Element, side: SidebarDockSide, x: number, y: number): number {
  const tabs = Array.from(zone.querySelectorAll(`[${DOCK_TAB_ATTR}][${DOCK_TAB_SIDE_ATTR}="${side}"]`));
  for (let i = 0; i < tabs.length; i += 1) {
    const r = tabs[i]!.getBoundingClientRect();
    if (y < r.top) return i;
    if (y <= r.bottom && x < r.left + r.width / 2) return i;
  }
  return tabs.length;
}

export function dockMoveMenuItems(side: SidebarDockSide, index: number, count: number) {
  return [
    { id: 'move-left', label: 'Move to left sidebar', disabled: side === 'left' },
    { id: 'move-right', label: 'Move to right sidebar', disabled: side === 'right' },
    { id: 'move-earlier', label: 'Move earlier', disabled: index <= 0, separator: true },
    { id: 'move-later', label: 'Move later', disabled: index >= count - 1 },
  ];
}

function focusDockTab(id: SidebarDockPanelId) {
  // The tab re-renders (possibly in the other sidebar) on the next commit.
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[${DOCK_TAB_ATTR}="${id}"]`);
    el?.focus();
  });
}

export function useSidebarDockDnd({ side, dock, visible, otherVisible, labelOf }: Options): SidebarDockDnd {
  const drag = useOptionalPanelDrag();
  const [menu, setMenu] = useState<DockMoveMenuState | null>(null);
  const full = dock[side];

  const dockDrag = drag?.dragState && isSidebarDockPanelId(drag.dragState.panelId) ? drag.dragState : null;
  const target = drag?.activeDropTarget;
  /** The pending drop as a slot among visible tabs (the drop target holds a full-list index). */
  let dropSlot: number | null = null;
  if (dockDrag && target && target.sidebar === side) {
    const i = visible.findIndex((id) => full.indexOf(id) >= target.index);
    dropSlot = i < 0 ? visible.length : i;
  }

  const move = useCallback((id: SidebarDockPanelId, toSide: SidebarDockSide, toVisibleSlot: number) => {
    if (!drag) return;
    const fromSide: SidebarDockSide = dock.left.includes(id) ? 'left' : 'right';
    const toVisible = toSide === side ? visible : otherVisible;
    drag.movePanel(
      { panelId: id, label: labelOf(id), sourceSidebar: fromSide, sourceIndex: dock[fromSide].indexOf(id) },
      { sidebar: toSide, index: dockIndexForVisibleSlot(dock[toSide], toVisible, toVisibleSlot) },
    );
    focusDockTab(id);
  }, [drag, dock, side, visible, otherVisible, labelOf]);

  /** Keyboard: step one slot along left-then-right, crossing sidebars at the edge. */
  const step = useCallback((id: SidebarDockPanelId, dir: -1 | 1) => {
    const order = linearOrder(side, visible, otherVisible);
    const at = visible.indexOf(id);
    if (at < 0) return;
    if (side === 'left') {
      if (dir < 0) { if (at > 0) move(id, 'left', at - 1); return; }
      if (at < order.left.length - 1) move(id, 'left', at + 2);
      else move(id, 'right', 0);
    } else {
      if (dir > 0) { if (at < order.right.length - 1) move(id, 'right', at + 2); return; }
      if (at > 0) move(id, 'right', at - 1);
      else move(id, 'left', order.left.length);
    }
  }, [side, visible, otherVisible, move]);

  const runMenuAction = useCallback((id: SidebarDockPanelId, action: string) => {
    setMenu(null);
    const at = visible.indexOf(id);
    if (action === 'move-left' && side !== 'left') move(id, 'left', otherVisible.length);
    else if (action === 'move-right' && side !== 'right') move(id, 'right', otherVisible.length);
    else if (action === 'move-earlier' && at > 0) move(id, side, at - 1);
    else if (action === 'move-later' && at >= 0 && at < visible.length - 1) move(id, side, at + 2);
  }, [visible, otherVisible, side, move]);

  const tabProps = useCallback((id: SidebarDockPanelId) => {
    const index = visible.indexOf(id);
    return {
      [DOCK_TAB_ATTR]: id,
      [DOCK_TAB_SIDE_ATTR]: side,
      draggable: drag ? true : undefined,
      'aria-keyshortcuts': drag ? 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight' : undefined,
      'data-dragging': dockDrag?.panelId === id ? 'true' : undefined,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        if (!drag) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(SIDEBAR_PANEL_DRAG_MIME, id);
        e.dataTransfer.setData('text/plain', labelOf(id));
        drag.startDrag({ panelId: id, label: labelOf(id), sourceSidebar: side, sourceIndex: full.indexOf(id) });
      },
      onDragEnd: () => { drag?.endDrag(); },
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        if (!drag) return;
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          e.stopPropagation();
          step(id, e.key === 'ArrowLeft' ? -1 : 1);
          return;
        }
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({ id, x: r.left, y: r.bottom });
        }
      },
      onContextMenu: (e: MouseEvent<HTMLElement>) => {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        setMenu({ id, x: e.clientX, y: e.clientY });
      },
      'data-dock-index': index,
    };
  }, [drag, side, full, visible, labelOf, dockDrag, step]);

  const zoneProps = {
    'data-sidebar-dock-zone': side,
    'data-drop-active': dropSlot !== null ? 'true' : undefined,
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!drag || !dockDrag) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const slot = slotFromPoint(e.currentTarget, side, e.clientX, e.clientY);
      const index = dockIndexForVisibleSlot(full, visible, slot);
      if (target?.sidebar !== side || target.index !== index) drag.setActiveDropTarget({ sidebar: side, index });
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!drag || !dockDrag) return;
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) return;
      if (drag.activeDropTarget?.sidebar === side) drag.setActiveDropTarget(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!drag || !dockDrag) return;
      e.preventDefault();
      e.stopPropagation();
      const slot = slotFromPoint(e.currentTarget, side, e.clientX, e.clientY);
      drag.commitDrop({ sidebar: side, index: dockIndexForVisibleSlot(full, visible, slot) });
    },
  };

  return {
    tabProps,
    zoneProps,
    dropSlot,
    dragging: dockDrag !== null,
    menu,
    closeMenu: () => setMenu(null),
    runMenuAction,
  };
}
