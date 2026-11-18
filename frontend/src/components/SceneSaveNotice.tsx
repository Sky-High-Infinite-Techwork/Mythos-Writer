import type { CSSProperties } from 'react';
import { sceneSaveFailureMessage } from '../scenePersist';

const BANNER_STYLE: CSSProperties = {
  margin: '8px 12px',
  padding: '8px 12px',
  borderRadius: 8,
  background: 'rgba(255, 196, 72, 0.16)',
  color: 'inherit',
  lineHeight: 1.4,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
};

export interface SceneSaveFailure {
  sceneId: string;
  sceneTitle: string;
}

export function SceneSaveNotice({
  failure,
  onRetry,
}: {
  failure: SceneSaveFailure | null;
  onRetry: () => void;
}) {
  if (!failure) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="scene-save-warning"
      style={BANNER_STYLE}
    >
      <p style={{ margin: 0, flex: 1 }}>{sceneSaveFailureMessage(failure.sceneTitle)}</p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}