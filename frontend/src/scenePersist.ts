/** Result of a scene vault write through the IPC bridge (resolves, may carry `{ error }`). */
export function vaultWriteRefused(result: unknown): boolean {
  if (!result || typeof result !== 'object') return true;
  const record = result as { error?: unknown; bytes?: unknown };
  if (typeof record.error === 'string' && record.error.length > 0) return true;
  if (typeof record.bytes === 'number' && record.bytes > 0) return false;
  if (typeof record.bytes === 'number' && record.bytes === 0) return true;
  return false;
}

/**
 * Persist scene markdown via `writeVault`. Returns true only when bytes landed on disk.
 * Throws from the bridge are treated as failure (no rethrow).
 */
export async function writeSceneVault(
  writeVault: (path: string, content: string) => Promise<unknown>,
  path: string,
  content: string,
): Promise<boolean> {
  try {
    const result = await writeVault(path, content);
    return !vaultWriteRefused(result);
  } catch {
    return false;
  }
}

export function sceneSaveFailureMessage(sceneTitle: string): string {
  return `Couldn't save “${sceneTitle}”. Your text is still in the editor.`;
}