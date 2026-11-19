import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import Backlinks from './Backlinks';

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url));

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectSourceFiles(full));
    else if (ent.isFile() && /\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

const TWO_ARG_ON_VAULT_FILE_CHANGED =
  /onVaultFileChanged\?\.?\s*\(\s*\(\s*[^,)]+,\s*[^)]+\)\s*=>/;

describe('onVaultFileChanged renderer contract', () => {
  it('no production caller registers a two-argument callback (red-on-revert)', () => {
    const violations: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      if (file.endsWith('onVaultFileChanged.contract.test.tsx')) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes('onVaultFileChanged')) continue;
      if (TWO_ARG_ON_VAULT_FILE_CHANGED.test(src)) {
        violations.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(violations, violations.join(', ')).toEqual([]);
  });

  it('bridge delivers payload only — callback arity is one (not event + data)', async () => {
    const noteBacklinks = vi.fn(async () => ({ notePath: 'x', backlinks: [] }));
    let vaultCb: ((data: { path: string }) => void) | undefined;
    const onVaultFileChanged = vi.fn((cb: (data: { path: string }) => void) => {
      vaultCb = cb;
      return () => {};
    });
    (window as unknown as { api: unknown }).api = { noteBacklinks, onVaultFileChanged };

    render(
      <Backlinks notePath="Lonely.md" stories={[]} onOpenNote={vi.fn()} onOpenScene={vi.fn()} />,
    );
    await waitFor(() => expect(onVaultFileChanged).toHaveBeenCalled());
    expect(vaultCb).toBeTypeOf('function');
    vaultCb!({ path: '/story-vault/scene.md' });
    expect(vaultCb!.length).toBeLessThanOrEqual(1);
  });

  it('re-subscribes after unmount (red-on-revert if unsubscribe skipped)', async () => {
    const noteBacklinks = vi.fn(async () => ({ notePath: 'x', backlinks: [] }));
    const unsub = vi.fn();
    const onVaultFileChanged = vi.fn(() => unsub);
    (window as unknown as { api: unknown }).api = { noteBacklinks, onVaultFileChanged };

    const props = {
      notePath: 'Lonely.md',
      stories: [] as const,
      onOpenNote: vi.fn(),
      onOpenScene: vi.fn(),
    };
    const first = render(<Backlinks {...props} stories={[]} />);
    await waitFor(() => expect(onVaultFileChanged).toHaveBeenCalledTimes(1));
    first.unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
    render(<Backlinks {...props} stories={[]} />);
    await waitFor(() => expect(onVaultFileChanged).toHaveBeenCalledTimes(2));
  });
});