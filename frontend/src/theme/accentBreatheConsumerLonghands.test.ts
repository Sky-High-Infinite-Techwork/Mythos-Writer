import { describe, it, expect } from 'vitest';
import { ACCENT_BREATHE_KEYS } from './accentBreathe';
import {
  ACCENT_BREATHE_CONSUMER_LONGHANDS,
  transitionPropertyDrivenByAccentTokens,
} from './accentBreatheConsumerLonghands';

describe('accentBreatheConsumerLonghands', () => {
  it('ties longhands to every accent breathe key', () => {
    expect(ACCENT_BREATHE_KEYS.length).toBe(20);
    expect(ACCENT_BREATHE_CONSUMER_LONGHANDS.has('all')).toBe(true);
    expect(ACCENT_BREATHE_CONSUMER_LONGHANDS.has('box-shadow')).toBe(true);
    expect(ACCENT_BREATHE_CONSUMER_LONGHANDS.has('border-top-color')).toBe(true);
    void ACCENT_BREATHE_KEYS;
  });

  it('opacity is not a token-consumer transition', () => {
    expect(transitionPropertyDrivenByAccentTokens('opacity')).toBe(false);
    expect(transitionPropertyDrivenByAccentTokens('border-top-color, opacity')).toBe(false);
    expect(transitionPropertyDrivenByAccentTokens('all')).toBe(true);
  });
});