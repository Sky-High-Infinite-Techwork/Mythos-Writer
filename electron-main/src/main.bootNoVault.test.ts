import { describe, expect, it } from 'vitest';
import { mythosRootForStoryVault } from './mythosFormat/mythosJson.js';
import { shouldInitializeVaultStorage } from './startupVaultPolicy.js';
import { isExistingUsableVaultRoot } from './validatePathUtil.js';

describe('no-vault boot policy (active trash with zero survivors)', () => {
  it('mythosRootForStoryVault accepts cleared vaultRoot without throwing', () => {
    expect(mythosRootForStoryVault(undefined)).toBeNull();
    expect(mythosRootForStoryVault(null)).toBeNull();
    expect(mythosRootForStoryVault('')).toBeNull();
  });

  it('does not initialize vault storage when onboarding is done but roots are cleared', () => {
    expect(
      shouldInitializeVaultStorage({
        onboardingComplete: true,
        storyVaultUsable: isExistingUsableVaultRoot(undefined),
        notesVaultUsable: isExistingUsableVaultRoot(undefined),
      }),
    ).toBe(false);
  });
});