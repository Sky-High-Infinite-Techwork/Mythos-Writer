// Longhands on Liquid Neon token consumers that restart when root accent keys change.
// Tied to {@link ACCENT_BREATHE_KEYS}: borders (--b*), glows (--g*, --gs*, --glowH, --bh).

import { ACCENT_BREATHE_KEYS } from './accentBreathe';

const BORDER_LONGHANDS = [
  'border',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-style',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'outline',
  'outline-color',
  'outline-width',
  'outline-style',
] as const;

const GLOW_LONGHANDS = [
  'box-shadow',
  'filter',
  'text-shadow',
  'background',
  'background-color',
  'background-image',
  'color',
  'stroke',
  'fill',
] as const;

void ACCENT_BREATHE_KEYS;

/** Longhands consumers animate when any breathe accent custom property steps. */
export const ACCENT_BREATHE_CONSUMER_LONGHANDS: ReadonlySet<string> = new Set([
  'all',
  ...BORDER_LONGHANDS,
  ...GLOW_LONGHANDS,
]);

export function transitionPropertyDrivenByAccentTokens(transitionProperty: string): boolean {
  for (const raw of transitionProperty.split(',')) {
    const p = raw.trim().toLowerCase();
    if (!p || p === 'none' || p === 'initial' || p === 'inherit' || p === 'unset') continue;
    if (!ACCENT_BREATHE_CONSUMER_LONGHANDS.has(p)) return false;
  }
  return true;
}