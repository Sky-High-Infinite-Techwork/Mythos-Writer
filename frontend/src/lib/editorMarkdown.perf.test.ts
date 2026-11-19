// A 500KB scene is thousands of plain paragraphs. Serializing it on autosave
// and on every shell render used prosemirror-markdown's atBlank() regex,
// which copies the whole output once per block (quadratic). This locks the
// linear path: a few thousand plain paragraphs must serialize in well under
// a frame budget, and match the markdown extension on small documents.
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { Markdown } from 'tiptap-markdown';
import { WikiLink } from '../WikiLinkExtension';
import { AlignedHeading, AlignedParagraph } from './alignedBlocks';
import { getEditorMarkdown } from './useRichEditor';

function makeEditor(content: string): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({ paragraph: false, heading: false }),
      AlignedParagraph,
      AlignedHeading,
      TextAlign.configure({ types: ['paragraph', 'heading'] }),
      WikiLink,
      Markdown,
    ],
    content,
  });
}

function officialMarkdown(editor: Editor): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = ((editor.storage as any).markdown?.getMarkdown?.() ?? '') as string;
  return raw.endsWith('\n') ? raw : `${raw}\n`;
}

describe('getEditorMarkdown on a large plain scene', () => {
  it('matches the markdown extension and stays linear for thousands of paragraphs', () => {
    const small = makeEditor('Alpha.\n\nBeta still typing.');
    expect(getEditorMarkdown(small)).toBe(officialMarkdown(small));
    small.destroy();

    const marked = makeEditor('Keep **this** mark.');
    expect(getEditorMarkdown(marked)).toBe(officialMarkdown(marked));
    marked.destroy();

    const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
    const content = Array.from({ length: 4000 }, () => para).join('\n\n');
    const editor = makeEditor(content);
    const started = performance.now();
    const out = getEditorMarkdown(editor);
    const elapsed = performance.now() - started;
    editor.destroy();
    expect(out).toContain(para);
    expect(out.endsWith('\n')).toBe(true);
    // Quadratic atBlank() on 4000 blocks is hundreds of ms. Linear is a join.
    expect(elapsed).toBeLessThan(80);
  });
});
