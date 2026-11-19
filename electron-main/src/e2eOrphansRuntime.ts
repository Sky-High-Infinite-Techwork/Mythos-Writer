import fs from 'fs';
import path from 'path';
import {
  findOrphans,
  wiredSpecsFromCi,
} from './e2eOrphanGuard';

export { findOrphans, wiredSpecsFromCi };

/** Specs intentionally unwired — need packaged binary, live service, or cross-slice wiring. */
export const ALLOW_LIST: Readonly<Record<string, string>> = {
  'e2e/kokoro-tts.spec.ts': 'needs Kokoro model assets (86MB) / real TTS binary',
  'e2e/voice-real-binary.spec.ts': 'needs espeak-ng or piper binary on PATH',
  'e2e/sky-11373-lmstudio-live.spec.ts': 'needs live LM Studio HTTP endpoint',
  'e2e/packaged-smoke.spec.ts': 'needs MYTHOS_PACKAGED_EXE built installer',
  'e2e/agent-hub-interaction-states.spec.ts': 'wired by #1923',
  'e2e/tests/sky-11154-vault-settings-page.spec.ts': 'wired by slice 03 (#1906)',
  'e2e/perf/ui-runtime.spec.ts': 'wired by slice 09 (#1912)',
};

export function listE2eSpecFiles(e2eRoot: string, repoRoot: string): string[] {
  const found: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.spec.ts')) continue;
      const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
      const base = path.basename(rel);
      if (base.startsWith('capture-')) continue;
      found.push(rel);
    }
  }
  walk(e2eRoot);
  return found.sort();
}