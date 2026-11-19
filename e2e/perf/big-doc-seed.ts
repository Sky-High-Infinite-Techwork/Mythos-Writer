/**
 * MythosVault v2 fixture for the big-scene perf gate.
 * Shape matches the #1903 scratch measurement: veynn-v2 mythos.json,
 * Story Vault + book.md spine, 300 × 8KB scenes and one 500KB scene.
 * Not shared with other specs.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const NOW = '2026-07-01T00:00:00.000Z';
export const STORY_TITLE = 'Audit Perf Story';
export const BIG_SCENE_TITLE = 'Big Scene';
export const TAIL = 'AUDIT-TAIL-MARKER-ZQX';
export const BURST = 'abcdefghijklmnopqrst';
export const SCENE_COUNT = 300;
export const BIG_BYTES = 500 * 1024;

const PROSE_UNIT = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';

export function prose(bytes: number): string {
  return PROSE_UNIT.repeat(Math.ceil(bytes / PROSE_UNIT.length)).slice(0, bytes);
}

export interface BigDocSeed {
  root: string;
  userData: string;
  scenePath: string;
}

export function seedBigDoc(sceneCount = SCENE_COUNT): BigDocSeed {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-big-doc-'));
  const userData = path.join(root, 'ud');
  const bundle = path.join(root, 'vault');
  const notes = path.join(bundle, 'Notes Vault');
  const storyDir = path.join(bundle, 'Story Vault', STORY_TITLE);
  const chapterDir = path.join(storyDir, 'Part 1', 'Chapter 01');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(chapterDir, { recursive: true });
  fs.mkdirSync(notes, { recursive: true });

  fs.writeFileSync(
    path.join(userData, 'app-settings.json'),
    JSON.stringify({ onboardingComplete: true, theme: 'dark' }),
  );
  fs.writeFileSync(
    path.join(userData, 'vault-settings.json'),
    JSON.stringify({
      vaultRoot: path.join(bundle, 'Story Vault'),
      notesVaultRoot: notes,
    }),
  );
  fs.writeFileSync(
    path.join(bundle, 'mythos.json'),
    JSON.stringify({
      formatVersion: 2,
      id: 'vault-audit',
      name: 'Audit Vault',
      createdAt: NOW,
      stories: [{
        id: 'story-audit',
        title: STORY_TITLE,
        folder: STORY_TITLE,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      seed: { layout: 'veynn-v2', mode: 'blank', seededAt: NOW },
    }),
  );

  const spine = [{
    dir: 'Part 1',
    chapters: [{ dir: 'Chapter 01', id: 'ch-audit', title: 'Chapter One' }],
  }];
  fs.writeFileSync(
    path.join(storyDir, 'book.md'),
    [
      '---',
      'id: story-audit',
      `title: ${STORY_TITLE}`,
      `createdAt: ${NOW}`,
      `updatedAt: ${NOW}`,
      '---',
      `# ${STORY_TITLE}`,
      '',
      '## Part 1',
      '',
      '- [[Part 1/Chapter 01|Chapter One]]',
      '',
      '<!-- mythos:spine',
      JSON.stringify(spine),
      '-->',
      '',
    ].join('\n'),
  );

  const bigBody = `${prose(BIG_BYTES).replace(/\. /g, '.\n\n')}\n\n${TAIL}\n`;
  const scenePath = path.join(chapterDir, 'Scene 000.md');
  fs.writeFileSync(
    scenePath,
    `---\nid: scene-big\ntitle: ${BIG_SCENE_TITLE}\nstatus: draft\nupdatedAt: ${NOW}\n---\n${bigBody}`,
  );

  const small = prose(8 * 1024);
  for (let i = 1; i <= sceneCount; i++) {
    const id = String(i).padStart(3, '0');
    fs.writeFileSync(
      path.join(chapterDir, `Scene ${id}.md`),
      `---\nid: scene-${id}\ntitle: Scene ${id}\nstatus: draft\nupdatedAt: ${NOW}\n---\n${small}\n`,
    );
  }

  return { root, userData, scenePath };
}

export function rmBigDoc(seed: BigDocSeed | undefined): void {
  if (!seed) return;
  fs.rmSync(seed.root, { recursive: true, force: true });
}
