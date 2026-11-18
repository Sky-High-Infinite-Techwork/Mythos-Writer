import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DraftHistoryPanel from './DraftHistoryPanel';

const draftsList = vi.fn();
const draftsPreview = vi.fn();
const draftsRestore = vi.fn();
const draftsDelete = vi.fn();
const draftsLabel = vi.fn();

const SNAP = {
  id: 'draft-snap-1',
  sceneId: 'scene-42',
  createdAt: 1_700_000_000_000,
  label: 'Checkpoint',
};

beforeEach(() => {
  vi.clearAllMocks();
  draftsList.mockResolvedValue({ snapshots: [SNAP] });
  draftsPreview.mockResolvedValue({ content: 'Snapshot preview text' });
  draftsRestore.mockResolvedValue({ content: 'Restored snapshot body', preRestoreSnapshotId: 'pre-1' });
  draftsDelete.mockResolvedValue(undefined);
  draftsLabel.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    value: { draftsList, draftsPreview, draftsRestore, draftsDelete, draftsLabel },
    writable: true,
    configurable: true,
  });
});

const onRestore = vi.fn();

describe('DraftHistoryPanel', () => {
  it('lists draft snapshots from draftsList', async () => {
    render(<DraftHistoryPanel sceneId="scene-42" currentContent="live" onRestore={onRestore} />);
    await waitFor(() => expect(draftsList).toHaveBeenCalledWith('scene-42'));
    expect(screen.getByRole('button', { name: /Draft History \(1\)/ })).toBeInTheDocument();
    expect(screen.getByText('Checkpoint')).toBeInTheDocument();
  });

  it('restores a draft after confirmation and calls onRestore with content', async () => {
    render(<DraftHistoryPanel sceneId="scene-42" currentContent="live prose" onRestore={onRestore} />);
    await waitFor(() => expect(draftsList).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText('Restore this draft'));
    fireEvent.click(screen.getByRole('button', { name: /^Restore$/ }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith('Restored snapshot body'));
    expect(screen.queryByRole('dialog', { name: 'Confirm restore' })).not.toBeInTheDocument();
  });

  it('does not call onRestore when draftsRestore fails and leaves the confirm dialog open', async () => {
    draftsRestore.mockRejectedValueOnce(new Error('restore failed'));
    render(<DraftHistoryPanel sceneId="scene-42" currentContent="live" onRestore={onRestore} />);
    await waitFor(() => expect(screen.getByText('Checkpoint')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Restore this draft'));
    fireEvent.click(screen.getByRole('button', { name: /^Restore$/ }));
    await waitFor(() => expect(draftsRestore).toHaveBeenCalled());
    await waitFor(() => expect(onRestore).not.toHaveBeenCalled());
    expect(screen.getByRole('dialog', { name: 'Confirm restore' })).toBeInTheDocument();
    expect(screen.getByText('Checkpoint')).toBeInTheDocument();
  });

  it('shows empty state when there are no snapshots', async () => {
    draftsList.mockResolvedValueOnce({ snapshots: [] });
    render(<DraftHistoryPanel sceneId="scene-42" currentContent="" onRestore={onRestore} />);
    await waitFor(() => expect(screen.getByText(/No drafts yet/)).toBeInTheDocument());
  });

  it('previews snapshot content when a row is toggled', async () => {
    render(<DraftHistoryPanel sceneId="scene-42" currentContent="" onRestore={onRestore} />);
    await waitFor(() => expect(draftsList).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText(/Preview snapshot from/));
    await waitFor(() => expect(screen.getByText('Snapshot preview text')).toBeInTheDocument());
  });

  it('deletes a snapshot and shows empty state after reload', async () => {
    draftsList
      .mockResolvedValueOnce({ snapshots: [SNAP] })
      .mockResolvedValueOnce({ snapshots: [] });
    render(<DraftHistoryPanel sceneId="scene-42" currentContent="" onRestore={onRestore} />);
    await waitFor(() => expect(screen.getByText('Checkpoint')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Delete this draft'));
    await waitFor(() => expect(screen.getByText(/No drafts yet/)).toBeInTheDocument());
    expect(screen.queryByText('Checkpoint')).not.toBeInTheDocument();
  });

  it('saves an edited label and renders the new label after reload', async () => {
    const relabeled = { ...SNAP, label: 'Renamed draft' };
    draftsList
      .mockResolvedValueOnce({ snapshots: [SNAP] })
      .mockResolvedValueOnce({ snapshots: [relabeled] });
    render(<DraftHistoryPanel sceneId="scene-42" currentContent="" onRestore={onRestore} />);
    await waitFor(() => expect(screen.getByText('Checkpoint')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Edit label'));
    const input = screen.getByLabelText('Draft label');
    fireEvent.change(input, { target: { value: 'Renamed draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Renamed draft')).toBeInTheDocument());
    expect(screen.queryByText('Checkpoint')).not.toBeInTheDocument();
  });

  it('cancels restore from the confirm dialog', async () => {
    render(<DraftHistoryPanel sceneId="scene-42" currentContent="live" onRestore={onRestore} />);
    await waitFor(() => expect(draftsList).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText('Restore this draft'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Confirm restore' })).not.toBeInTheDocument();
    expect(draftsRestore).not.toHaveBeenCalled();
  });

  it('collapses and expands the panel body', async () => {
    render(<DraftHistoryPanel sceneId="scene-42" currentContent="" onRestore={onRestore} />);
    await waitFor(() => expect(draftsList).toHaveBeenCalled());
    const toggle = screen.getByRole('button', { name: /Draft History/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});