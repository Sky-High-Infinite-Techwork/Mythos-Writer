import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  PanelDragProvider,
  useOptionalPanelDrag,
  usePanelDrag,
  type PanelDragContextValue,
} from './PanelDragContext';

function Capture({ onCtx }: { onCtx: (ctx: PanelDragContextValue) => void }) {
  onCtx(usePanelDrag());
  return null;
}

function setup() {
  const onDrop = vi.fn();
  const onTabBarDrop = vi.fn();
  const onTabGroupDrop = vi.fn();
  let ctx!: PanelDragContextValue;
  render(
    <PanelDragProvider onDrop={onDrop} onTabBarDrop={onTabBarDrop} onTabGroupDrop={onTabGroupDrop}>
      <Capture onCtx={(c) => { ctx = c; }} />
    </PanelDragProvider>,
  );
  return { onDrop, onTabBarDrop, onTabGroupDrop, get ctx() { return ctx; } };
}

describe('PanelDragContext — sidebar dock panels', () => {
  it('movePanel commits through onDrop without a drag in flight', () => {
    const t = setup();
    act(() => {
      t.ctx.movePanel(
        { panelId: 'story-navigator', label: 'Story navigator', sourceSidebar: 'left', sourceIndex: 0 },
        { sidebar: 'right', index: 2 },
      );
    });
    expect(t.onDrop).toHaveBeenCalledWith('story-navigator', 'left', 0, 'right', 2);
    expect(t.ctx.dragState).toBeNull();
  });

  it('never turns a dock panel into a docked tab-bar tab (those hold legacy panels only)', () => {
    const t = setup();
    act(() => { t.ctx.startDrag({ panelId: 'hub-scenes', label: 'Scenes', sourceSidebar: 'right', sourceIndex: 2 }); });
    act(() => { t.ctx.commitTabBarDrop(-1); });
    expect(t.onTabBarDrop).not.toHaveBeenCalled();
    expect(t.ctx.dragState).toBeNull();

    act(() => { t.ctx.startDrag({ panelId: 'hub-scenes', label: 'Scenes', sourceSidebar: 'right', sourceIndex: 2 }); });
    act(() => { t.ctx.commitTabGroupDrop('tab-1'); });
    expect(t.onTabGroupDrop).not.toHaveBeenCalled();
  });

  it('still routes legacy registry panels to the tab bar', () => {
    const t = setup();
    act(() => { t.ctx.startDrag({ panelId: 'entities', label: 'Entities', sourceSidebar: 'left', sourceIndex: 0 }); });
    act(() => { t.ctx.commitTabBarDrop(-1); });
    expect(t.onTabBarDrop).toHaveBeenCalledWith('entities', 'left', -1);
  });

  it('useOptionalPanelDrag is null outside a provider; usePanelDrag still throws', () => {
    let seen: PanelDragContextValue | null | undefined;
    function Probe() { seen = useOptionalPanelDrag(); return null; }
    render(<Probe />);
    expect(seen).toBeNull();
    function Strict() { usePanelDrag(); return null; }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Strict />)).toThrow('usePanelDrag must be used within PanelDragProvider');
    spy.mockRestore();
  });
});
