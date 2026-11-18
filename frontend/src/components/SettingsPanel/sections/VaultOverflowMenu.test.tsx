// SKY-11154 / test-gap 03 — every VaultOverflowMenu branch (hide/delete/remove,
// mythos 2-step vs inner 1-step, failure surface, paired-notes hide copy).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type ComponentProps } from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import VaultOverflowMenu, { type VaultOverflowLevel } from './VaultOverflowMenu';

const VAULT_PATH = '/mythos/Alpha';
const VAULT_NAME = 'Alpha';
const SUFFIX = 'test-suffix';

const mockHide = vi.fn();
const mockTrash = vi.fn();
const mockBlastRadius = vi.fn();
const mockOnHidden = vi.fn();
const mockOnDeleted = vi.fn();
const mockOnRename = vi.fn();

function api(overrides: Record<string, unknown> = {}) {
  return {
    vaultSurfaceHide: mockHide,
    vaultSurfaceTrash: mockTrash,
    vaultSurfaceBlastRadius: mockBlastRadius,
    ...overrides,
  };
}

async function mount(props: Partial<ComponentProps<typeof VaultOverflowMenu>> = {}) {
  await act(async () => {
    render(
      <VaultOverflowMenu
        level="mythos"
        vaultPath={VAULT_PATH}
        vaultName={VAULT_NAME}
        testIdSuffix={SUFFIX}
        onHidden={mockOnHidden}
        onDeleted={mockOnDeleted}
        {...props}
      />,
    );
  });
}

function openMenu() {
  fireEvent.click(screen.getByTestId(`vault-overflow-btn-${SUFFIX}`));
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockHide.mockResolvedValue({ hidden: true });
  mockTrash.mockResolvedValue({ trashed: true });
  mockBlastRadius.mockResolvedValue({ vaultName: VAULT_NAME, innerCount: 2 });
  Object.defineProperty(window, 'api', { value: api(), writable: true, configurable: true });
});

describe('VaultOverflowMenu — menu structure', () => {
  it.each<VaultOverflowLevel>(['mythos', 'notes', 'story'])(
    'renders Hide and Move to Recycle Bin at level=%s',
    async (level) => {
      await mount({ level });
      openMenu();
      expect(await screen.findByRole('menuitem', { name: 'Hide' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Move to Recycle Bin' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Remove from Mythos…' })).toBeInTheDocument();
    },
  );

  it('omits Rename when onRename is absent', async () => {
    await mount();
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument();
  });

  it('includes Rename and calls onRename when provided', async () => {
    await mount({ onRename: mockOnRename });
    openMenu();
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(mockOnRename).toHaveBeenCalledTimes(1);
  });
});

describe('VaultOverflowMenu — hide', () => {
  it('confirm Hide calls vaultSurfaceHide and onHidden when hidden', async () => {
    await mount({ level: 'notes' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }));
    expect(await screen.findByTestId(`vault-hide-dialog-${SUFFIX}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`vault-hide-confirm-${SUFFIX}`));
    await waitFor(() => expect(mockHide).toHaveBeenCalledWith({ vaultRoot: VAULT_PATH, level: 'notes' }));
    expect(mockOnHidden).toHaveBeenCalledTimes(1);
  });

  it('shows paired-notes hide copy when pairedStoryVaultName is set', async () => {
    await mount({ level: 'notes', pairedStoryVaultName: 'Story B' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }));
    expect(await screen.findByText(/linked to "Story B"/i)).toBeInTheDocument();
  });

  it('Cancel on hide dialog does not call vaultSurfaceHide', async () => {
    await mount();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(mockHide).not.toHaveBeenCalled();
  });

  it('does not call onHidden when vaultSurfaceHide returns hidden:false', async () => {
    mockHide.mockResolvedValueOnce({ hidden: false });
    await mount();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }));
    fireEvent.click(screen.getByTestId(`vault-hide-confirm-${SUFFIX}`));
    await waitFor(() => expect(mockHide).toHaveBeenCalled());
    expect(mockOnHidden).not.toHaveBeenCalled();
    expect(screen.getByTestId(`vault-hide-dialog-${SUFFIX}`)).toBeInTheDocument();
  });

  it('vaultSurfaceHide throw leaves the hide dialog open and skips onHidden', async () => {
    mockHide.mockRejectedValueOnce(new Error('hide IPC failed'));
    await mount();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }));
    fireEvent.click(screen.getByTestId(`vault-hide-confirm-${SUFFIX}`));
    await waitFor(() => expect(mockHide).toHaveBeenCalled());
    expect(screen.getByTestId(`vault-hide-dialog-${SUFFIX}`)).toBeInTheDocument();
    expect(mockOnHidden).not.toHaveBeenCalled();
  });
});

describe('VaultOverflowMenu — delete (inner / story / notes)', () => {
  it('inner level shows a single-step Recycle Bin confirm', async () => {
    await mount({ level: 'story' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Recycle Bin' }));
    expect(await screen.findByTestId(`vault-delete-dialog-${SUFFIX}`)).toBeInTheDocument();
    expect(screen.getByText(/moved to the Recycle Bin/i)).toBeInTheDocument();
    expect(mockBlastRadius).not.toHaveBeenCalled();
  });

  it('Cancel on inner delete leaves vaultSurfaceTrash uncalled', async () => {
    await mount({ level: 'story' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Recycle Bin' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(mockTrash).not.toHaveBeenCalled();
  });

  it('confirm on inner delete calls vaultSurfaceTrash', async () => {
    await mount({ level: 'notes' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Recycle Bin' }));
    fireEvent.click(screen.getByTestId(`vault-delete-confirm-${SUFFIX}`));
    await waitFor(() => expect(mockTrash).toHaveBeenCalledWith({ vaultPath: VAULT_PATH, level: 'notes' }));
    expect(mockOnDeleted).toHaveBeenCalledTimes(1);
  });
});

describe('VaultOverflowMenu — delete (mythos two-step)', () => {
  it('runs blast radius then two-step confirm before trash', async () => {
    await mount({ level: 'mythos' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Recycle Bin' }));
    await waitFor(() => expect(mockBlastRadius).toHaveBeenCalledWith(VAULT_PATH));
    expect(await screen.findByTestId(`vault-delete-dialog-1-${SUFFIX}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`vault-delete-confirm-1-${SUFFIX}`));
    expect(await screen.findByTestId(`vault-delete-dialog-2-${SUFFIX}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`vault-delete-confirm-2-${SUFFIX}`));
    await waitFor(() => expect(mockTrash).toHaveBeenCalledWith({ vaultPath: VAULT_PATH, level: 'mythos' }));
  });

  it('still opens step 1 when blast radius rejects', async () => {
    mockBlastRadius.mockRejectedValueOnce(new Error('network'));
    await mount({ level: 'mythos' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Recycle Bin' }));
    expect(await screen.findByTestId(`vault-delete-dialog-1-${SUFFIX}`)).toBeInTheDocument();
  });

  it('surfaces mythos-level trash failure after the second confirm', async () => {
    mockTrash.mockResolvedValueOnce({ trashed: false, error: 'trash daemon offline' });
    await mount({ level: 'mythos' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Recycle Bin' }));
    fireEvent.click(await screen.findByTestId(`vault-delete-confirm-1-${SUFFIX}`));
    fireEvent.click(screen.getByTestId(`vault-delete-confirm-2-${SUFFIX}`));
    expect(await screen.findByTestId(`vault-delete-failed-${SUFFIX}`)).toBeInTheDocument();
    expect(screen.getByText(/trash daemon offline/)).toBeInTheDocument();
    expect(mockOnDeleted).not.toHaveBeenCalled();
  });
});

describe('VaultOverflowMenu — trash / remove errors', () => {
  it('surfaces the failed dialog when vaultSurfaceTrash returns trashed:false', async () => {
    mockTrash.mockResolvedValueOnce({ trashed: false, error: 'Permission denied' });
    await mount({ level: 'story' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Recycle Bin' }));
    fireEvent.click(screen.getByTestId(`vault-delete-confirm-${SUFFIX}`));
    expect(await screen.findByTestId(`vault-delete-failed-${SUFFIX}`)).toBeInTheDocument();
    expect(screen.getByText(/Permission denied/)).toBeInTheDocument();
    expect(mockOnDeleted).not.toHaveBeenCalled();
  });

  it('surfaces the failed dialog when vaultSurfaceTrash throws', async () => {
    mockTrash.mockRejectedValueOnce(new Error('IPC broke'));
    await mount({ level: 'story' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Recycle Bin' }));
    fireEvent.click(screen.getByTestId(`vault-delete-confirm-${SUFFIX}`));
    expect(await screen.findByTestId(`vault-delete-failed-${SUFFIX}`)).toBeInTheDocument();
    expect(screen.getByText(/IPC broke/)).toBeInTheDocument();
  });

  it('remove-only success calls hide and onDeleted', async () => {
    await mount();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from Mythos…' }));
    fireEvent.click(screen.getByTestId(`vault-remove-only-confirm-${SUFFIX}`));
    await waitFor(() => expect(mockHide).toHaveBeenCalledWith({ vaultRoot: VAULT_PATH, level: 'mythos' }));
    expect(mockOnDeleted).toHaveBeenCalledTimes(1);
  });

  it('remove-only failure opens the failed dialog', async () => {
    mockHide.mockResolvedValueOnce({ hidden: false });
    await mount();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from Mythos…' }));
    fireEvent.click(screen.getByTestId(`vault-remove-only-confirm-${SUFFIX}`));
    expect(await screen.findByTestId(`vault-delete-failed-${SUFFIX}`)).toBeInTheDocument();
  });

  it('remove-only surfaces throw message in the failed dialog', async () => {
    mockHide.mockRejectedValueOnce(new Error('remove blew up'));
    await mount();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from Mythos…' }));
    fireEvent.click(screen.getByTestId(`vault-remove-only-confirm-${SUFFIX}`));
    expect(await screen.findByTestId(`vault-delete-failed-${SUFFIX}`)).toBeInTheDocument();
    expect(screen.getByText(/remove blew up/)).toBeInTheDocument();
  });
});

// VaultOverflowMenu has no active/inactive props — current vs inactive vaults are
// distinguished by parent sections (MythosVaultsSection / VaultLinkingColumns).