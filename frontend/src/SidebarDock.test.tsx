import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { configureAxe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';
import type { AxeMatchers } from 'vitest-axe/matchers';
import SidebarDock, { SidebarDockDndScope } from './SidebarDock';
import { PanelDragProvider } from './PanelDragContext';
import {
  defaultSidebarDock,
  isSidebarDockPanelId,
  moveSidebarPanel,
  type SidebarDockPanelId,
  type SidebarDockSide,
  type SidebarDockState,
} from './frame/sidebarDock';

// vitest-axe@0.1.0's legacy matcher typing — same registration as accessibility.test.tsx.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  interface Assertion<T = any> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
expect.extend(axeMatchers);
// colour-contrast needs computed styles jsdom does not have.
const axe = configureAxe({ rules: { 'color-contrast': { enabled: false } } });
// The move menu portals to <body> like every app menu, so it sits outside the
// sidebar landmarks by design; `region` is a page-level rule for page content.
const axePortal = configureAxe({ rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });

const LABELS: Record<SidebarDockPanelId, string> = {
  'story-navigator': 'Story navigator',
  'hub-partner': 'Mythos',
  'hub-suggestions': 'Suggestions',
  'hub-scenes': 'Scenes',
  'hub-notes-analysis': 'Notes & Analysis',
};
const labelOf = (id: SidebarDockPanelId) => LABELS[id];

/** Both sidebars as SidebarDocks under one provider whose drop handler moves panels like the shell does. */
function Harness({ initial = defaultSidebarDock(), onDrop }: {
  initial?: SidebarDockState;
  onDrop?: (...args: unknown[]) => void;
}) {
  const [dock, setDock] = useState(initial);
  const [active, setActive] = useState<Record<SidebarDockSide, SidebarDockPanelId | null>>({ left: null, right: null });
  const side = (s: SidebarDockSide) => (
    <SidebarDockDndScope side={s} dock={dock} visible={dock[s]} otherVisible={dock[s === 'left' ? 'right' : 'left']} labelOf={labelOf}>
      {(dnd) => (
        <SidebarDock
          side={s}
          regionLabel={s === 'left' ? 'Left sidebar' : 'Right sidebar'}
          label={s === 'left' ? 'Left sidebar panels' : 'Right sidebar panels'}
          ids={dock[s]}
          activeId={active[s]}
          onActiveChange={(id) => setActive((a) => ({ ...a, [s]: id }))}
          labelOf={labelOf}
          renderPanel={(id) => <div data-testid={`body-${id}`}>{LABELS[id]} body</div>}
          dnd={dnd}
        />
      )}
    </SidebarDockDndScope>
  );
  return (
    <PanelDragProvider
      onDrop={(id, from, fromIndex, to, toIndex) => {
        onDrop?.(id, from, fromIndex, to, toIndex);
        if (isSidebarDockPanelId(id)) {
          setDock((d) => moveSidebarPanel(d, id, to, toIndex));
          setActive((a) => ({ ...a, [to]: id }));
        }
      }}
    >
      {side('left')}
      {side('right')}
    </PanelDragProvider>
  );
}

const tablist = (name: string) => screen.getByRole('tablist', { name });
const tabNames = (name: string) => within(tablist(name)).queryAllByRole('tab').map((t) => t.textContent);

/** jsdom has no layout: give the tabs of one sidebar a single row of 100px-wide rects. */
function layoutRow(name: string) {
  within(tablist(name)).queryAllByRole('tab').forEach((tab, i) => {
    tab.getBoundingClientRect = () => ({
      left: i * 100, right: i * 100 + 100, top: 0, bottom: 30, width: 100, height: 30, x: i * 100, y: 0, toJSON: () => ({}),
    }) as DOMRect;
  });
}

function dataTransfer() {
  return { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '', types: [] };
}

/** jsdom has no DragEvent, so pointer coordinates must be set on the event by hand. */
function fireDrag(
  type: 'dragOver' | 'drop' | 'dragLeave',
  el: Element,
  dt: ReturnType<typeof dataTransfer>,
  at: { clientX: number; clientY: number },
  extra: Record<string, unknown> = {},
) {
  const ev = createEvent[type](el, { dataTransfer: dt, ...extra });
  Object.defineProperty(ev, 'clientX', { value: at.clientX });
  Object.defineProperty(ev, 'clientY', { value: at.clientY });
  return fireEvent(el, ev);
}

function dragTabTo(tabName: string, zoneTestId: string, at: { clientX: number; clientY: number }) {
  const tab = screen.getByRole('tab', { name: tabName });
  const zone = screen.getByTestId(zoneTestId);
  const dt = dataTransfer();
  fireEvent.dragStart(tab, { dataTransfer: dt });
  fireDrag('dragOver', zone, dt, at);
  fireDrag('drop', zone, dt, at);
  fireEvent.dragEnd(tab, { dataTransfer: dt });
  return dt;
}

describe('SidebarDock — tabs pattern', () => {
  it('each sidebar is a named complementary landmark', () => {
    render(<Harness />);
    expect(screen.getByRole('complementary', { name: 'Left sidebar' })).toBe(screen.getByTestId('sidebar-dock-left'));
  });

  it('is a labelled tablist whose selected tab controls a labelled tabpanel', () => {
    render(<Harness />);
    const tab = within(tablist('Left sidebar panels')).getByRole('tab', { name: 'Story navigator' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toHaveAttribute('tabindex', '0');
    const panel = screen.getAllByRole('tabpanel').find((p) => p.getAttribute('aria-labelledby') === tab.id)!;
    expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(within(panel).getByTestId('body-story-navigator')).toBeInTheDocument();
  });

  it('arrow keys, Home and End move selection with a roving tabindex', () => {
    render(<Harness />);
    const list = tablist('Right sidebar panels');
    const tabs = within(list).getAllByRole('tab');
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('tabindex', '0');
    expect(tabs[0]).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: 'End' });
    expect(tabs[3]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[3]!, { key: 'ArrowRight' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
    expect(tabs[3]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[3]!, { key: 'Home' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('every tab is a drag source', () => {
    render(<Harness />);
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveAttribute('draggable', 'true');
      expect(tab).toHaveAttribute('aria-keyshortcuts', 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight');
    }
  });
});

describe('SidebarDock — drag a panel between either sidebar', () => {
  it('drags the left panel into the right sidebar at the drop position, and shows it there', () => {
    render(<Harness />);
    layoutRow('Right sidebar panels');
    // Over the second half of "Mythos" (0–100) → lands before "Suggestions".
    const dt = dragTabTo('Story navigator', 'sidebar-dock-right', { clientX: 60, clientY: 10 });
    expect(dt.setData).toHaveBeenCalledWith('application/x-mythos-sidebar-panel', 'story-navigator');
    expect(tabNames('Left sidebar panels')).toEqual([]);
    expect(tabNames('Right sidebar panels')).toEqual(['Mythos', 'Story navigator', 'Suggestions', 'Scenes', 'Notes & Analysis']);
    expect(screen.getByRole('tab', { name: 'Story navigator' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('body-story-navigator')).toBeInTheDocument();
    // The emptied sidebar invites a drop back.
    expect(screen.getByTestId('sidebar-dock-left-empty')).toBeInTheDocument();
  });

  it('drags a right-sidebar tab into the left sidebar and back again', () => {
    render(<Harness />);
    layoutRow('Left sidebar panels');
    // Left of "Story navigator"'s midpoint → slot 0.
    dragTabTo('Scenes', 'sidebar-dock-left', { clientX: 10, clientY: 10 });
    expect(tabNames('Left sidebar panels')).toEqual(['Scenes', 'Story navigator']);
    expect(tabNames('Right sidebar panels')).toEqual(['Mythos', 'Suggestions', 'Notes & Analysis']);

    layoutRow('Right sidebar panels');
    // Below the tab row (over the panel body) → appended at the end.
    dragTabTo('Scenes', 'sidebar-dock-right', { clientX: 10, clientY: 400 });
    expect(tabNames('Left sidebar panels')).toEqual(['Story navigator']);
    expect(tabNames('Right sidebar panels')).toEqual(['Mythos', 'Suggestions', 'Notes & Analysis', 'Scenes']);
  });

  it('reorders within one sidebar', () => {
    render(<Harness />);
    layoutRow('Right sidebar panels');
    dragTabTo('Notes & Analysis', 'sidebar-dock-right', { clientX: 10, clientY: 10 });
    expect(tabNames('Right sidebar panels')).toEqual(['Notes & Analysis', 'Mythos', 'Suggestions', 'Scenes']);
  });

  it('shows an insertion marker and drop highlight while hovering, and clears them on leave', () => {
    render(<Harness />);
    layoutRow('Right sidebar panels');
    const tab = screen.getByRole('tab', { name: 'Story navigator' });
    const zone = screen.getByTestId('sidebar-dock-right');
    const dt = dataTransfer();
    fireEvent.dragStart(tab, { dataTransfer: dt });
    expect(tab).toHaveAttribute('data-dragging', 'true');
    fireDrag('dragOver', zone, dt, { clientX: 160, clientY: 10 });
    expect(zone).toHaveAttribute('data-drop-active', 'true');
    const strip = tablist('Right sidebar panels');
    expect(strip.children[2]?.classList.contains('sidebar-dock__marker')).toBe(true);
    fireEvent.dragLeave(zone, { dataTransfer: dt, relatedTarget: document.body });
    expect(zone).not.toHaveAttribute('data-drop-active');
    fireEvent.dragEnd(tab, { dataTransfer: dt });
    expect(tab).not.toHaveAttribute('data-dragging');
    expect(tabNames('Left sidebar panels')).toEqual(['Story navigator']);
  });

  it('ignores drags that are not sidebar panels (e.g. a file or a document tab)', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const zone = screen.getByTestId('sidebar-dock-left');
    const dt = dataTransfer();
    const over = fireDrag('dragOver', zone, dt, { clientX: 5, clientY: 5 });
    fireDrag('drop', zone, dt, { clientX: 5, clientY: 5 });
    expect(over).toBe(true); // not preventDefault-ed → the browser shows "no drop"
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('SidebarDock — keyboard and menu moves', () => {
  it('Alt+Shift+Arrow walks a panel one slot at a time and crosses into the other sidebar at the edge', async () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    // First right tab, stepping left → end of the left sidebar.
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Mythos' }), { key: 'ArrowLeft', altKey: true, shiftKey: true });
    });
    expect(tabNames('Left sidebar panels')).toEqual(['Story navigator', 'Mythos']);
    expect(onDrop).toHaveBeenLastCalledWith('hub-partner', 'right', 0, 'left', 1);
    // Step left again → reorders within the left sidebar.
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Mythos' }), { key: 'ArrowLeft', altKey: true, shiftKey: true });
    });
    expect(tabNames('Left sidebar panels')).toEqual(['Mythos', 'Story navigator']);
    // Last left tab stepping right → front of the right sidebar.
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Story navigator' }), { key: 'ArrowRight', altKey: true, shiftKey: true });
    });
    expect(tabNames('Left sidebar panels')).toEqual(['Mythos']);
    expect(tabNames('Right sidebar panels')).toEqual(['Story navigator', 'Suggestions', 'Scenes', 'Notes & Analysis']);
  });

  it('plain arrows only change selection; they never move a panel', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Mythos' }), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Mythos' }), { key: 'ArrowLeft', altKey: true });
    expect(onDrop).not.toHaveBeenCalled();
    expect(tabNames('Left sidebar panels')).toEqual(['Story navigator']);
  });

  it('the tab context menu (right-click or Shift+F10) moves a panel to the other sidebar', async () => {
    render(<Harness />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Story navigator' }), { clientX: 20, clientY: 20 });
    const menu = screen.getByRole('menu', { name: 'Move Story navigator' });
    expect(within(menu).getByRole('menuitem', { name: 'Move to left sidebar' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to right sidebar' }));
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(tabNames('Right sidebar panels')).toEqual(['Mythos', 'Suggestions', 'Scenes', 'Notes & Analysis', 'Story navigator']);

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Scenes' }), { key: 'F10', shiftKey: true });
    const menu2 = screen.getByRole('menu', { name: 'Move Scenes' });
    await act(async () => {
      fireEvent.click(within(menu2).getByRole('menuitem', { name: 'Move earlier' }));
    });
    expect(tabNames('Right sidebar panels')).toEqual(['Mythos', 'Scenes', 'Suggestions', 'Notes & Analysis', 'Story navigator']);
  });

  it('announces where a keyboard move landed, in the live region', async () => {
    render(<Harness />);
    const status = () => screen.getByRole('status').textContent;
    // Scenes is 3rd on the right; one step earlier → 2nd.
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Scenes' }), { key: 'ArrowLeft', altKey: true, shiftKey: true });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(status()).toBe('Scenes moved to right sidebar at position 2.');
    // One step later again → back to 3rd (a later same-sidebar slot lands one earlier).
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Scenes' }), { key: 'ArrowRight', altKey: true, shiftKey: true });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(status()).toBe('Scenes moved to right sidebar at position 3.');
    expect(tabNames('Right sidebar panels')).toEqual(['Mythos', 'Suggestions', 'Scenes', 'Notes & Analysis']);
  });
});

describe('SidebarDock — axe', () => {
  it('has no violations: default, with the move menu open, and with an empty dock', async () => {
    const { container, unmount } = render(<Harness />);
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Scenes' }), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole('menu', { name: 'Move Scenes' });
    expect(await axePortal(menu)).toHaveNoViolations();
    expect(await axe(container)).toHaveNoViolations();
    unmount();

    const empty = render(<Harness initial={{ left: [], right: ['story-navigator', 'hub-partner', 'hub-suggestions', 'hub-scenes', 'hub-notes-analysis'] }} />);
    expect(screen.getByTestId('sidebar-dock-left-empty')).toBeInTheDocument();
    expect(await axe(empty.container)).toHaveNoViolations();
  });
});
