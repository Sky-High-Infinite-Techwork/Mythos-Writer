// #1774 Accent breathe — a slow ambient drift of the Liquid Neon glow and
// border tokens through the theme's own six slot colors. A fixed-step 4 Hz
// timer rewrites only the 20 accent keys below (changed values only) on the
// element the engine just applied to; no requestAnimationFrame, no CSS
// animation, no transition on the tokens. Phase 0 equals the static engine
// output, so turning it on is seamless and turning it off restores the theme.
//
// Each tick suppresses descendant transitions only for the synchronous write:
// rendered consumers with `transition: all`/box-shadow/border (7 on a fresh
// window, 49 with Settings open) would otherwise restart on every color step
// and keep repainting (measured: 5–9% dropped frames ON vs 0% OFF under xvfb).
// Steady ticks: drop breathe churn on marked consumers, suppress-only when no user
// transition is running, else #1774 cancel-new (no global suppress). After every
// write, cancel only tick-started consumer transitions (see accentBreatheConsumerLonghands).
//
// Off (static theme, no timer): toggle off, in-app Reduce motion, OS
// prefers-reduced-motion, prefers-contrast: more, forced-colors, the app's
// data-contrast="high", or no matchMedia (jsdom fail-safe).
// Paused (color frozen mid-blend, no timer): window hidden, or the existing
// `ln-anim-paused` idle path (BackgroundStack.tsx).
//
// No runtime imports from liquidNeonEngine.ts — it calls in here.

import { transitionPropertyDrivenByAccentTokens } from './accentBreatheConsumerLonghands';

/** 6 hops × 8 s, inside the issue's 30–60 s. */
export const ACCENT_BREATHE_LOOP_MS = 48_000;
/** 4 Hz → 192 ticks/loop, 32 ticks/hop (exact). */
export const ACCENT_BREATHE_TICK_MS = 250;
/** The only tokens that breathe. Never --n*, --grad, --accent*, glass. */
export const ACCENT_BREATHE_KEYS = [
  '--b1', '--b2', '--b3', '--b4', '--b5', '--b6',
  '--g1', '--g2', '--g3', '--g4', '--g5', '--g6',
  '--gs1', '--gs2', '--gs3', '--gs4', '--gs5', '--gs6',
  '--bh', '--glowH',
] as const;

export type AccentBreatheState = 'running' | 'paused' | 'off';

/** A system signal that forces breathe off whatever the toggle says. */
export type AccentBreatheBlock = 'reduced-motion' | 'contrast' | null;

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';
const CONTRAST_QUERY = '(prefers-contrast: more)';
const FORCED_QUERY = '(forced-colors: active)';

/**
 * Why breathe is forced off right now (OS reduced motion; OS/app high
 * contrast or forced colors), or null. The in-app Reduce motion switch is a
 * setting, not a system signal, so callers that hold settings check it
 * themselves. No matchMedia → null (nothing to report).
 */
export function accentBreatheBlock(doc: Document = document): AccentBreatheBlock {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (window.matchMedia(REDUCE_QUERY).matches) return 'reduced-motion';
  if (window.matchMedia(CONTRAST_QUERY).matches || window.matchMedia(FORCED_QUERY).matches) return 'contrast';
  if (doc.documentElement.dataset.contrast === 'high') return 'contrast';
  return null;
}

/** Call `cb` whenever accentBreatheBlock() may have changed; returns unsubscribe. */
export function subscribeAccentBreatheBlock(cb: () => void, doc: Document = document): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mqs = [REDUCE_QUERY, CONTRAST_QUERY, FORCED_QUERY].map((q) => window.matchMedia(q));
  for (const m of mqs) m.addEventListener('change', cb);
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(cb) : null;
  observer?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-contrast'] });
  return () => {
    for (const m of mqs) m.removeEventListener('change', cb);
    observer?.disconnect();
  };
}

export interface AccentBreatheInput {
  /** S.accentBreathe && !S.reduceMotion */
  enabled: boolean;
  /** The six slot colors the tokens use (empty 4–6 padded; 6 × #rrggbb) */
  slots: readonly string[];
  /** RAW (unclamped) .3+.4I, .18+.5I, .05+.13I — clamped only when formatted. */
  aB: number;
  aG: number;
  aGs: number;
  /** Math.round((S.glowR || 26) / 2) */
  glowRh: number;
}

type Rgb = [number, number, number];

/** Byte-for-byte the engine's hexA output, from channels instead of hex. */
function rgba(r: number, g: number, b: number, a: number): string {
  return 'rgba(' + r + ',' + g + ',' + b + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
}

/** Six #rrggbb slots → channels, or null when any slot doesn't parse. */
function parseSlots(slots: readonly string[]): Rgb[] | null {
  if (slots.length !== 6) return null;
  const out: Rgb[] = [];
  for (const hex of slots) {
    const h = String(hex).replace('#', '');
    const c: Rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    if (c.some((v) => Number.isNaN(v))) return null;
    out.push(c);
  }
  return out;
}

function tokensFor(input: AccentBreatheInput, rgb: Rgb[] | null, elapsedMs: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rgb) return out;
  const L = ACCENT_BREATHE_LOOP_MS;
  const e = ((elapsedMs % L) + L) % L;
  const phase = (6 * e) / L;
  const k = Math.floor(phase);
  const t = phase - k;
  let first: Rgb = rgb[0];
  for (let i = 0; i < 6; i++) {
    const from = rgb[(i + k) % 6], to = rgb[(i + k + 1) % 6];
    const c: Rgb = [
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ];
    if (i === 0) first = c;
    out['--b' + (i + 1)] = rgba(c[0], c[1], c[2], input.aB);
    out['--g' + (i + 1)] = rgba(c[0], c[1], c[2], input.aG);
    out['--gs' + (i + 1)] = rgba(c[0], c[1], c[2], input.aGs);
  }
  out['--bh'] = rgba(first[0], first[1], first[2], input.aB / 2);
  out['--glowH'] = '0 0 ' + input.glowRh + 'px -7px ' + rgba(first[0], first[1], first[2], input.aG / 2);
  return out;
}

/**
 * The 20 accent tokens at `elapsedMs` into the loop. Every slot passes through
 * all six theme colors once per loop (linear blend in gamma sRGB); the six
 * slots stay a rotation of the palette and alpha never changes. At 0 this
 * equals the same keys of computeLiquidNeonV2Tokens. Empty when a slot
 * doesn't parse.
 */
export function accentBreatheTokens(input: AccentBreatheInput, elapsedMs: number): Record<string, string> {
  return tokensFor(input, parseSlots(input.slots), elapsedMs);
}

interface Controller {
  el: HTMLElement;
  input: AccentBreatheInput;
  rgb: Rgb[] | null;
  elapsed: number;
  timer: ReturnType<typeof setInterval> | null;
  last: Record<string, string>;
  mq: { reduce: MediaQueryList; contrast: MediaQueryList; forced: MediaQueryList } | null;
  observer: MutationObserver | null;
  onVis: (() => void) | null;
  /** Last state written to data-ln-breathe; null until the first reconcile. */
  state: AccentBreatheState | null;
  /** transitionKey values canceled as breathe churn on the prior tick. */
  churnKeys: Set<string>;
  elementIds: Map<Element, number>;
}

let ctl: Controller | null = null;

function computeState(c: Controller): AccentBreatheState {
  const root = c.el.ownerDocument.documentElement;
  if (!c.input.enabled || !c.mq || !c.rgb) return 'off';
  if (c.mq.reduce.matches || c.mq.contrast.matches || c.mq.forced.matches) return 'off';
  if (root.dataset.contrast === 'high') return 'off';
  if (root.classList.contains('ln-anim-paused') || c.el.ownerDocument.visibilityState === 'hidden') return 'paused';
  return 'running';
}

/** Changed-only writes. */
function write(c: Controller, t: Record<string, string>): void {
  for (const k of ACCENT_BREATHE_KEYS) {
    const v = t[k];
    if (v === undefined || v === c.last[k]) continue;
    c.el.style.setProperty(k, v);
    c.last[k] = v;
  }
}

const TICK_ATTR = 'data-ln-breathe-tick';
const TICK_STYLE_ID = 'ln-breathe-tick-css';
const CHURN_ATTR = 'data-ln-breathe-churn';

/** One stylesheet; only active while TICK_ATTR is on the theme root during writeTick. */
function ensureTickSuppressStyle(doc: Document): void {
  if (doc.getElementById(TICK_STYLE_ID)) return;
  const css = doc.createElement('style');
  css.id = TICK_STYLE_ID;
  css.textContent =
    'html[' + TICK_ATTR + '] *,html[' + TICK_ATTR + '] *::before,html[' + TICK_ATTR + '] *::after{' +
    'transition-property:none!important;transition-duration:0s!important;transition-delay:0s!important}';
  doc.head.appendChild(css);
}

function isCssTransition(a: Animation): a is CSSTransition {
  return typeof (a as CSSTransition).transitionProperty === 'string';
}

function cancelMarkedChurn(doc: Document, root: Element): void {
  for (const node of doc.querySelectorAll('[' + CHURN_ATTR + ']')) {
    if (!(node instanceof Element) || node === root) continue;
    const anims = typeof node.getAnimations === 'function'
      ? node.getAnimations()
      : doc.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target === node);
    for (const a of anims) {
      if (!isCssTransition(a)) continue;
      if (!transitionPropertyDrivenByAccentTokens(a.transitionProperty)) continue;
      a.cancel();
    }
    node.removeAttribute(CHURN_ATTR);
  }
}

/** Optional perf/e2e counters on `window.__mwAccentBreatheTickStats`. */
function bumpTickPath(
  doc: Document,
  path: 'suppress' | 'cancelNew' | 'plain',
): void {
  const w = doc.defaultView as (Window & {
    __mwAccentBreatheTickStats?: { suppress: number; cancelNew: number; plain: number };
  }) | null;
  const s = w?.__mwAccentBreatheTickStats;
  if (!s) return;
  if (path === 'suppress') s.suppress += 1;
  else if (path === 'cancelNew') s.cancelNew += 1;
  else s.plain += 1;
}

function elementId(c: Controller, el: Element): number {
  let id = c.elementIds.get(el);
  if (id === undefined) c.elementIds.set(el, (id = c.elementIds.size));
  return id;
}

/** `target|pseudo|property` of a running CSS transition, or null for any other animation. */
function transitionKey(c: Controller, a: Animation): string | null {
  const prop = (a as CSSTransition).transitionProperty;
  const fx = a.effect as KeyframeEffect | null;
  if (typeof prop !== 'string' || !(fx?.target instanceof Element)) return null;
  return elementId(c, fx.target) + '|' + (fx.pseudoElement ?? '') + '|' + prop;
}

function isProtectedUserTransition(c: Controller, a: Animation, root: Element): boolean {
  const target = (a.effect as KeyframeEffect | null)?.target;
  if (!(target instanceof Element) || target === root) return false;
  if (!isCssTransition(a)) return false;
  if (target.hasAttribute(CHURN_ATTR)) return false;
  return true;
}

function matchesProtectedUserTransition(user: Animation, candidate: Animation): boolean {
  const uFx = user.effect as KeyframeEffect | null;
  const cFx = candidate.effect as KeyframeEffect | null;
  if (!uFx?.target || uFx.target !== cFx?.target) return false;
  if ((uFx.pseudoElement ?? '') !== (cFx?.pseudoElement ?? '')) return false;
  if (!isCssTransition(user) || !isCssTransition(candidate)) return false;
  const uProp = user.transitionProperty.toLowerCase();
  const cProp = candidate.transitionProperty.toLowerCase();
  if (uProp === cProp) return true;
  if (uProp === 'all' || cProp === 'all') return true;
  if (uProp.includes('border') && cProp.includes('border')) return true;
  if (uProp.includes('box-shadow') && cProp.includes('box-shadow')) return true;
  return false;
}

/**
 * Steady breathe: churn cleanup, scoped suppress or cancel-new (#1774), cancel tick-started only.
 */
function writeTick(c: Controller, t: Record<string, string>): void {
  if (!ACCENT_BREATHE_KEYS.some((k) => t[k] !== undefined && t[k] !== c.last[k])) return;
  const doc = c.el.ownerDocument;
  if (typeof doc.getAnimations !== 'function') {
    write(c, t);
    bumpTickPath(doc, 'plain');
    return;
  }
  cancelMarkedChurn(doc, c.el);
  const before = new Set(doc.getAnimations());
  const protectedUsers = [...before].filter((a) => isProtectedUserTransition(c, a, c.el));

  const cancelTickStartedConsumers = (): void => {
    const nextChurn = new Set<string>();
    for (const a of doc.getAnimations()) {
      if (before.has(a)) continue;
      if (!isCssTransition(a)) continue;
      if (!transitionPropertyDrivenByAccentTokens(a.transitionProperty)) continue;
      const target = (a.effect as KeyframeEffect | null)?.target;
      if (!(target instanceof Element) || target === c.el) continue;
      if (protectedUsers.some((u) => matchesProtectedUserTransition(u, a))) continue;
      const key = transitionKey(c, a);
      a.cancel();
      if (key) nextChurn.add(key);
      target.setAttribute(CHURN_ATTR, '');
    }
    c.churnKeys = nextChurn;
  };

  if (protectedUsers.length > 0) {
    write(c, t);
    void getComputedStyle(c.el).getPropertyValue('--b1');
    cancelTickStartedConsumers();
    bumpTickPath(doc, 'cancelNew');
    return;
  }

  ensureTickSuppressStyle(doc);
  c.el.setAttribute(TICK_ATTR, '');
  try {
    write(c, t);
    void getComputedStyle(c.el).getPropertyValue('--b1');
  } finally {
    c.el.removeAttribute(TICK_ATTR);
  }
  cancelTickStartedConsumers();
  bumpTickPath(doc, 'suppress');
}

function clearTimer(c: Controller): void {
  if (c.timer != null) clearInterval(c.timer);
  c.timer = null;
}

function tick(): void {
  const c = ctl;
  if (!c) return;
  if (computeState(c) !== 'running') {
    reconcile();
    return;
  }
  c.elapsed = (c.elapsed + ACCENT_BREATHE_TICK_MS) % ACCENT_BREATHE_LOOP_MS;
  writeTick(c, tokensFor(c.input, c.rgb, c.elapsed));
}

function reconcile(): void {
  const c = ctl;
  if (!c) return;
  const state = computeState(c);
  if (state !== c.state) {
    c.state = state;
    c.el.setAttribute('data-ln-breathe', state);
  }
  if (state === 'off') {
    c.elapsed = 0;
    write(c, tokensFor(c.input, c.rgb, 0));
    clearTimer(c);
  } else if (state === 'paused') {
    write(c, tokensFor(c.input, c.rgb, c.elapsed));
    clearTimer(c);
  } else {
    write(c, tokensFor(c.input, c.rgb, c.elapsed));
    if (c.timer == null) c.timer = setInterval(tick, ACCENT_BREATHE_TICK_MS);
  }
}

function createController(el: HTMLElement): Controller {
  const doc = el.ownerDocument;
  const c: Controller = {
    el, input: { enabled: false, slots: [], aB: 0, aG: 0, aGs: 0, glowRh: 0 }, rgb: null,
    elapsed: 0, timer: null, last: {}, mq: null, observer: null, onVis: null, state: null,
    churnKeys: new Set(), elementIds: new Map(),
  };
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return c;
  c.mq = {
    reduce: window.matchMedia(REDUCE_QUERY),
    contrast: window.matchMedia(CONTRAST_QUERY),
    forced: window.matchMedia(FORCED_QUERY),
  };
  for (const m of Object.values(c.mq)) m.addEventListener('change', reconcile);
  if (typeof MutationObserver === 'function') {
    c.observer = new MutationObserver(reconcile);
    c.observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'data-contrast'] });
  }
  c.onVis = reconcile;
  doc.addEventListener('visibilitychange', c.onVis);
  return c;
}

/**
 * Called last in applyLiquidNeonV2Tokens. Records what apply just wrote (the
 * phase-0 tokens) and reconciles, so a re-apply mid-loop re-writes the current
 * phase in the same task and the colors never snap back to static.
 */
export function syncAccentBreathe(input: AccentBreatheInput, el: HTMLElement): void {
  if (ctl && ctl.el !== el) stopAccentBreathe();
  if (!ctl) ctl = createController(el);
  ctl.input = input;
  ctl.rgb = parseSlots(input.slots);
  ctl.last = tokensFor(input, ctl.rgb, 0);
  reconcile();
}

/** Stop the driver and drop every listener (theme reset / tests). */
export function stopAccentBreathe(): void {
  const c = ctl;
  if (!c) return;
  clearTimer(c);
  c.observer?.disconnect();
  if (c.mq) for (const m of Object.values(c.mq)) m.removeEventListener('change', reconcile);
  if (c.onVis) c.el.ownerDocument.removeEventListener('visibilitychange', c.onVis);
  c.el.removeAttribute(TICK_ATTR);
  ctl = null;
}
