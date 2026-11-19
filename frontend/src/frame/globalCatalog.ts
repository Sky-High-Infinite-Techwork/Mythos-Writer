/** Owns the Add-panel catalog: splits panels into Global and This-page sections by scope and applies the AI Off rule. Pure; imports only the panel registry and scope model. */

import { DESIGN_PANELS, panelBelongsToPage, type DesignPanelDef, type DesignPanelId } from './panelRegistry';
import { isGlobalScope, type PageView, type PanelScope } from './scopeModel';

/** Shown on an AI panel's catalog row while AI is off. */
export const AI_OFF_REASON = 'Turn AI on in Settings to add this panel.';

/** Shown on a page panel's catalog row when the shell cannot open it on this page yet. */
export const PAGE_PANEL_UNAVAILABLE_REASON = 'This page cannot open this panel yet.';

export interface CatalogEntry {
  id: DesignPanelId;
  label: string;
  scope: PanelScope;
  /** Every catalog panel opens as a full panel (never a tab inside another panel). */
  kind: 'full';
  /** True when the row is listed but cannot be added (AI Off, or a page panel the shell cannot open yet). */
  inert: boolean;
  reason: string | null;
}

export interface AddCatalog {
  /** Panels for the global sidebars (scope `global`). */
  global: CatalogEntry[];
  /** Panels that open inside the current page (scope `page:<view>`). */
  page: CatalogEntry[];
}

export interface AddCatalogInput {
  /** The page in the center, or null when the view has no page chrome. */
  page: PageView | null;
  /** Panels already open (global sidebars + page chrome); they are not offered again. */
  placed: readonly DesignPanelId[];
  aiEnabled: boolean;
  /** Page panels the shell can open from the menu; any other page row is inert. Omitted = all can open. */
  pageOpenable?: readonly DesignPanelId[];
}

/** AI Off rule: an AI panel is inert (cannot be added, makes no AI calls). */
export function isPanelInert(id: DesignPanelId, aiEnabled: boolean): boolean {
  if (aiEnabled) return false;
  return DESIGN_PANELS.some((panel) => panel.id === id && panel.ai);
}

function toEntry(panel: DesignPanelDef & { id: DesignPanelId }, aiEnabled: boolean, openable = true): CatalogEntry {
  const aiOff = isPanelInert(panel.id, aiEnabled);
  const inert = aiOff || !openable;
  return {
    id: panel.id,
    label: panel.label,
    scope: panel.scope,
    kind: 'full',
    inert,
    reason: aiOff ? AI_OFF_REASON : inert ? PAGE_PANEL_UNAVAILABLE_REASON : null,
  };
}

/**
 * The Add menu's two sections. Only panels the app can mount today are listed;
 * a global panel never appears in the page section and a page panel never
 * appears in the global section.
 */
export function buildAddCatalog({ page, placed, aiEnabled, pageOpenable }: AddCatalogInput): AddCatalog {
  const open = new Set<DesignPanelId>(placed);
  const canOpen = (id: DesignPanelId) => pageOpenable === undefined || pageOpenable.includes(id);
  const offerable = DESIGN_PANELS.filter((panel) => panel.hosted && !open.has(panel.id));
  return {
    global: offerable.filter((panel) => isGlobalScope(panel.scope)).map((panel) => toEntry(panel, aiEnabled)),
    page:
      page === null
        ? []
        : offerable
            .filter((panel) => !isGlobalScope(panel.scope) && panelBelongsToPage(panel.id, page))
            .map((panel) => toEntry(panel, aiEnabled, canOpen(panel.id))),
  };
}
