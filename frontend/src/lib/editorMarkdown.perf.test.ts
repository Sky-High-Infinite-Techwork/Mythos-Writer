// The fast path must be byte-identical to tiptap-markdown's getMarkdown().
// Anything it is unsure about returns null and the extension serializes it.
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { getEditorMarkdown, richEditorExtensions } from './useRichEditor';

function makeEditor(content: string): Editor {
  return new Editor({
    extensions: richEditorExtensions(),
    content,
  });
}

function officialRaw(editor: Editor): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((editor.storage as any).markdown?.getMarkdown?.() ?? '') as string;
}

function withTrailingNewline(raw: string): string {
  return raw.endsWith('\n') ? raw : `${raw}\n`;
}

function expectMatches(content: string): void {
  const editor = makeEditor(content);
  const official = withTrailingNewline(officialRaw(editor));
  const fast = getEditorMarkdown(editor);
  editor.destroy();
  expect(fast).toBe(official);
}

const CASES: Array<[string, string]> = [
  ['plain paragraphs', 'Alpha.\n\nBeta still typing.'],
  ['marked bold falls back', 'Keep **this** mark.'],
  ['italic falls back', 'Keep *this* italic.'],
  ['escaped asterisks', 'He said \\*hi\\* there.'],
  ['escaped heading', '\\# not a heading'],
  ['escaped dash', '\\- not a list'],
  ['escaped ordered list', '1\\. not a list'],
  ['escaped ordered list digit 2', '2\\. second item'],
  ['escaped ordered list multi-digit', '10\\. tenth item'],
  ['escaped plus', '\\+ not a list'],
  ['escaped blockquote', '\\> not a quote'],
  ['raw greater-than', 'a < b and > c'],
  ['ampersand entity source', 'a &lt; b'],
  ['brackets', 'see [x] now'],
  ['backticks', 'use `x` here'],
  ['backslash', 'path\\\\file'],
  ['tilde', 'a ~ b'],
  ['underscore inside a word', 'snake_case stays'],
  ['leading underscore', '_start'],
  ['empty middle paragraphs', '<p>A</p><p></p><p></p><p>B</p>'],
  ['leading empty paragraph', '<p></p><p>A</p>'],
  ['trailing empty paragraph', '<p>A</p><p></p>'],
  ['only an empty paragraph', '<p></p>'],
  ['real heading falls back', '# A heading'],
  ['real list falls back', '- one\n- two'],
  ['ordered list falls back', '1. one\n2. two'],
  ['blockquote falls back', '> quoted'],
  ['wiki link falls back', 'See [[Elara Voss]] today.'],
  ['centered paragraph falls back', 'Hello {.center}'],
  ['crlf paragraphs', 'Alpha.\r\n\r\nBeta.'],
  ['unicode', 'café — 日本語\n\nещё'],
  ['no trailing newline on input', 'Alpha.\n\nBeta'],
  ['single paragraph', 'Just one.'],
  ['three plain paragraphs', 'One.\n\nTwo.\n\nThree.'],
];

describe('getEditorMarkdown matches tiptap-markdown', () => {
  it.each(CASES)('%s', (_name, content) => {
    expectMatches(content);
  });

  it('fuzzes 500 seeded docs of markdown-special characters', () => {
    const alphabet = 'abcXYZ \n*_#->+[]`\\<&0123456789.~';
    let seed = 1914;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let n = 0; n < 500; n++) {
      const paragraphs = 1 + Math.floor(next() * 4);
      const parts: string[] = [];
      for (let p = 0; p < paragraphs; p++) {
        if (next() < 0.15) {
          parts.push('');
          continue;
        }
        const len = 1 + Math.floor(next() * 24);
        let text = '';
        for (let c = 0; c < len; c++) {
          text += alphabet[Math.floor(next() * alphabet.length)] ?? 'a';
        }
        parts.push(text);
      }
      expectMatches(parts.join('\n\n'));
    }
  });

  it('serializes a destroyed editor from its last document', () => {
    const editor = makeEditor('Keep this paragraph.');
    const live = getEditorMarkdown(editor);
    expect(live).toContain('Keep this paragraph.');
    editor.destroy();
    expect(editor.isDestroyed).toBe(true);
    expect(getEditorMarkdown(editor)).toBe(live);
  });

  it('returns null when a destroyed editor no longer has a document', () => {
    const editor = {
      get state(): never {
        throw new Error('editor destroyed');
      },
      storage: {},
    } as unknown as Editor;
    expect(getEditorMarkdown(editor)).toBeNull();
  });

  it('serializes a 500KB plain doc at least 5x faster than getMarkdown', () => {
    const sentence = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
    let body = '';
    while (body.length < 500 * 1024) body += `${sentence}\n\n`;
    const editor = makeEditor(body);
    const official = () => officialRaw(editor);
    const fast = () => getEditorMarkdown(editor);
    expect(fast()).toBe(withTrailingNewline(official()));

    const runs = 5;
    const time = (fn: () => string | null): number[] => {
      const samples: number[] = [];
      for (let i = 0; i < runs; i++) {
        const started = performance.now();
        fn();
        samples.push(performance.now() - started);
      }
      return samples;
    };
    const median = (samples: number[]): number => {
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    official();
    fast();
    const oldMs = median(time(official));
    const fastMs = median(time(fast));
    editor.destroy();
    expect(
      oldMs / fastMs,
      `median getMarkdown ${oldMs.toFixed(1)}ms, fast path ${fastMs.toFixed(1)}ms`,
    ).toBeGreaterThanOrEqual(5);
  });

});
