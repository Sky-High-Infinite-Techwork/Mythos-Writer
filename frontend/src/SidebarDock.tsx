/** Tab host for the shell's left sidebar: shows the panels docked there as draggable tabs, renders the active one, and accepts panels dropped from either sidebar. */
import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ContextMenu } from './components/ui/Menu';
import type { SidebarDockPanelId, SidebarDockSide, SidebarDockState } from './frame/sidebarDock';
import { dockMoveMenuItems, useSidebarDockDnd, type SidebarDockDnd } from './sidebarDockDnd';
import './SidebarDock.css';

interface Props {
  side: SidebarDockSide;
  /** Landmark name of the sidebar itself, e.g. "Left sidebar". */
  regionLabel: string;
  /** Accessible name of the tab list, e.g. "Left sidebar panels". */
  label: string;
  /** Panels shown here, in dock order. */
  ids: SidebarDockPanelId[];
  activeId: SidebarDockPanelId | null;
  onActiveChange: (id: SidebarDockPanelId) => void;
  labelOf: (id: SidebarDockPanelId) => string;
  renderPanel: (id: SidebarDockPanelId) => ReactNode;
  dnd: SidebarDockDnd;
}

export default function SidebarDock({ side, regionLabel, label, ids, activeId, onActiveChange, labelOf, renderPanel, dnd }: Props) {
  const baseId = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const active = activeId && ids.includes(activeId) ? activeId : ids[0] ?? null;
  const tabId = (id: SidebarDockPanelId) => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;

  // WAI-ARIA tabs: arrow keys move focus and select (automatic activation).
  const onTabListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = active ? ids.indexOf(active) : -1;
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next < 0 || !ids[next]) return;
    e.preventDefault();
    onActiveChange(ids[next]!);
    tabsRef.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(ids[next]!))}`)?.focus();
  };

  return (
    <aside
      className={`sidebar-dock sidebar-dock--${side}${dnd.dropSlot !== null ? ' sidebar-dock--drop' : ''}`}
      aria-label={regionLabel}
      data-testid={`sidebar-dock-${side}`}
      {...dnd.zoneProps}
    >
      <div
        ref={tabsRef}
        className="sidebar-dock__tabs"
        role="tablist"
        aria-label={label}
        onKeyDown={onTabListKeyDown}
      >
        {ids.map((id, i) => (
          <DockTab
            key={id}
            id={tabId(id)}
            controls={panelId}
            selected={id === active}
            showMarker={dnd.dropSlot === i}
            label={labelOf(id)}
            onSelect={() => onActiveChange(id)}
            dragProps={dnd.tabProps(id)}
          />
        ))}
        {dnd.dropSlot !== null && dnd.dropSlot >= ids.length && (
          <span className="sidebar-dock__marker" aria-hidden="true" />
        )}
      </div>
      {active ? (
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={tabId(active)}
          className="sidebar-dock__body"
        >
          {renderPanel(active)}
        </div>
      ) : (
        <div className="sidebar-dock__empty" data-testid={`sidebar-dock-${side}-empty`}>
          Drag a panel here to dock it in this sidebar.
        </div>
      )}
      <SidebarDockMoveMenu side={side} ids={ids} labelOf={labelOf} dnd={dnd} />
    </aside>
  );
}

/**
 * Calls useSidebarDockDnd from inside PanelDragProvider (the shell renders the
 * provider, so its own body cannot read drag state) and hands the result to
 * `children`.
 */
export function SidebarDockDndScope({ side, dock, visible, otherVisible, labelOf, children }: {
  side: SidebarDockSide;
  dock: SidebarDockState;
  visible: SidebarDockPanelId[];
  otherVisible: SidebarDockPanelId[];
  labelOf: (id: SidebarDockPanelId) => string;
  children: (dnd: SidebarDockDnd) => ReactNode;
}) {
  const dnd = useSidebarDockDnd({ side, dock, visible, otherVisible, labelOf });
  return <>{children(dnd)}</>;
}

/** "Move to …" menu for a tab in the right sidebar (the left one renders its own inside SidebarDock). */
export function SidebarDockMoveMenu({ side, ids, labelOf, dnd }: {
  side: SidebarDockSide;
  ids: SidebarDockPanelId[];
  labelOf: (id: SidebarDockPanelId) => string;
  dnd: SidebarDockDnd;
}) {
  const index = dnd.menu ? ids.indexOf(dnd.menu.id) : -1;
  if (!dnd.menu || index < 0) return null;
  const { id, x, y } = dnd.menu;
  return (
    <ContextMenu
      open
      position={{ x, y }}
      items={dockMoveMenuItems(side, index, ids.length)}
      onAction={(action) => dnd.runMenuAction(id, action)}
      onClose={dnd.closeMenu}
      aria-label={`Move ${labelOf(id)}`}
      data-testid="sidebar-dock-move-menu"
    />
  );
}

function DockTab({ id, controls, selected, showMarker, label, onSelect, dragProps }: {
  id: string;
  controls: string;
  selected: boolean;
  showMarker: boolean;
  label: string;
  onSelect: () => void;
  dragProps: Record<string, unknown>;
}) {
  return (
    <>
      {showMarker && <span className="sidebar-dock__marker" aria-hidden="true" />}
      <button
        type="button"
        role="tab"
        id={id}
        aria-selected={selected}
        aria-controls={controls}
        tabIndex={selected ? 0 : -1}
        className={`sidebar-dock__tab${selected ? ' sidebar-dock__tab--active' : ''}`}
        title={`${label} — drag to the other sidebar or reorder (Alt+Shift+← / →)`}
        onClick={onSelect}
        {...dragProps}
      >
        <span className="sidebar-dock__tab-label">{label}</span>
      </button>
    </>
  );
}
