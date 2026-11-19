import type { CSSProperties } from 'react';
import type { SceneSaveFailureEntry } from '../scenePersist';
import { sceneFailureKey, sceneSaveFailureMessage } from '../scenePersist';

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

export type SceneSaveFailure = SceneSaveFailureEntry;

export function SceneSaveNotice({
  failures,
  onRetry,
}: {
  failures: readonly SceneSaveFailureEntry[];
  onRetry: () => void;
}) {
  if (failures.length === 0) return null;
  const retryLabel = failures.length > 1 ? 'Retry all' : 'Retry';
  return (
    <div data-testid="scene-save-warning-region">
      {failures.map((failure) => (
        <div
          key={sceneFailureKey(failure.storyId, failure.sceneId)}
          role="status"
          aria-live="polite"
          data-testid="scene-save-warning"
          style={BANNER_STYLE}
        >
          <p style={{ margin: 0, flex: 1 }}>
            {sceneSaveFailureMessage(failure.sceneTitle, failure.missing)}
          </p>
        </div>
      ))}
      <div style={{ margin: '0 12px 8px', textAlign: 'right' }}>
        <button type="button" onClick={onRetry}>
          {retryLabel}
        </button>
      </div>
    </div>
  );
}