import { useEffect } from 'react';
import { useEditor } from '@tiptap/react';
import type { AnyExtension, Editor, EditorOptions } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { registerActiveEditor, unregisterActiveEditor } from './activeEditorRegistry';
import TextAlign from '@tiptap/extension-text-align';
import { Markdown } from 'tiptap-markdown';
import { WikiLink } from '../WikiLinkExtension';
import { WikiLinkResolutionExtension } from '../WikiLinkResolutionExtension';
import { AlignedParagraph, AlignedHeading } from './alignedBlocks';
import { InlineImageExtension } from './InlineImageExtension';
import { createNoteVaultImageExtension } from './NoteVaultImageExtension';

/**
 * Shared Tiptap editor hook for all rich-text surfaces (Story/Notes).
 *
 * Base extensions always included: StarterKit (paragraph/heading disabled in
 * favor of the alignment-aware variants below; StarterKit still bundles
 * Underline in Tiptap v3) · AlignedParagraph/AlignedHeading · TextAlign ·
 * WikiLink · WikiLinkResolution (SKY-5702 unresolved-link styling) · Markdown.
 * Surface-specific extensions (and the shared mention stack, appended by
 * `<RichTextEditor>`) are passed via `extraExtensions`.
 *
 * All other `useEditor` options are forwarded unchanged so callers retain
 * full control over autofocus, content, callbacks, etc.
 */
export interface UseRichEditorOptions {
  /** Initial Markdown content. */
  content?: string;
  /** Additional Tiptap extensions beyond the shared base. */
  extraExtensions?: AnyExtension[];
  /** Whether the editor accepts user input. Defaults to true. */
  editable?: boolean;
  /** Cursor placement on mount. */
  autofocus?: 'start' | 'end' | 'all' | number | boolean;
  /** Called on every ProseMirror transaction that changes the document. */
  onUpdate?: ({ editor }: { editor: Editor }) => void;
  /** Called on every selection change. */
  onSelectionUpdate?: ({ editor }: { editor: Editor }) => void;
  /** Focus/blur callbacks (forwarded straight to useEditor). */
  onFocus?: ({ editor }: { editor: Editor }) => void;
  onBlur?: ({ editor }: { editor: Editor }) => void;
  /** TipTap/ProseMirror editorProps (F2#4 drop handling lives here). */
  editorProps?: EditorOptions['editorProps'];
  /** PLAN-058 L6: Notes vault inline images use data-vault-src hydration. */
  vaultInlineImages?: boolean;
}

/**
 * Characters `escapeMarkdownText` can change: HTML `<`/`>`, the `esc`
 * set, and the start-of-line markers (`+`, `-`, `#`, digits). Any other
 * line is already equal to the escaped form, so the regexes can be skipped.
 */
const MARKDOWN_ESCAPE_CHARS = new Uint8Array(128);
for (const ch of '<>`*\\~[]_+-#0123456789') {
  MARKDOWN_ESCAPE_CHARS[ch.charCodeAt(0)] = 1;
}

function lineNeedsMarkdownEscape(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code < 128 && MARKDOWN_ESCAPE_CHARS[code] === 1) return true;
  }
  return false;
}

/**
 * Same character escapes as prosemirror-markdown `MarkdownSerializerState.esc`,
 * after tiptap-markdown's `escapeHTML` (`<` / `>`). `startOfLine` matches
 * `atBlockStart` for a paragraph's text.
 */
export function escapeMarkdownText(text: string, startOfLine: boolean): string {
  const html = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = html.replace(/[`*\\~\]_[]/g, (m, index: number) => {
    if (
      m === '_' &&
      index > 0 &&
      index + 1 < html.length &&
      /\w/.test(html[index - 1] ?? '') &&
      /\w/.test(html[index + 1] ?? '')
    ) {
      return m;
    }
    return `\\${m}`;
  });
  if (startOfLine) {
    out = out
      .replace(/^(\+[ ]|[-*>])/, '\\$&')
      .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
      .replace(/^(\s*\d+)\.\s/, '$1\\. ');
  }
  return out;
}

/**
 * Plain left-aligned paragraphs, serialized like tiptap-markdown without
 * walking `atBlank()` over a growing string. Returns null for anything else
 * (marks, headings, lists, hard breaks, alignment) so the caller uses the
 * markdown extension.
 *
 * Empty paragraphs do not emit their own blank line: `closeBlock` only
 * replaces the pending close, and a trailing close is never flushed. A
 * leading empty paragraph flushes as a single newline.
 */
export function serializePlainParagraphs(doc: PMNode): string | null {
  const paras: Array<{ empty: true } | { empty: false; text: string }> = [];
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i);
    if (node.type.name !== 'paragraph') return null;
    const align = node.attrs?.textAlign as string | null | undefined;
    if (align && align !== 'left') return null;
    if (node.childCount === 0) {
      paras.push({ empty: true });
      continue;
    }
    let text = '';
    for (let j = 0; j < node.childCount; j++) {
      const child = node.child(j);
      if (!child.isText || child.marks.length > 0) return null;
      text += child.text ?? '';
    }
    paras.push({ empty: false, text });
  }

  // Track blankness instead of calling endsWith on the growing output.
  // That call flattens the string once per paragraph.
  const chunks: string[] = [];
  let pendingClose = false;
  let atBlank = true;
  for (const para of paras) {
    if (para.empty) {
      pendingClose = true;
      continue;
    }
    if (pendingClose) {
      if (!atBlank) chunks.push('\n');
      chunks.push('\n');
      pendingClose = false;
      atBlank = true;
    }
    const rendered = para.text
      .split('\n')
      .map((line) => (lineNeedsMarkdownEscape(line) ? escapeMarkdownText(line, true) : line))
      .join('\n');
    if (rendered.length > 0) {
      chunks.push(rendered);
      atBlank = rendered.endsWith('\n');
    }
    pendingClose = true;
  }
  return chunks.join('');
}

/**
 * Read the current document as Markdown from a Tiptap editor.
 * Always appends a trailing newline for tooling compatibility
 * (tiptap-markdown v0.9 omits the trailing newline).
 *
 * A destroyed editor often still holds `state` and `storage`. Reading those
 * keeps the last scene. If they are gone, return null so a flush skips the
 * save instead of writing an empty scene.
 */
export function getEditorMarkdown(editor: Editor): string | null {
  try {
    const plain = serializePlainParagraphs(editor.state.doc);
    // tiptap-markdown attaches storage.markdown at runtime — cast is unavoidable
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = plain ?? (((editor.storage as any).markdown?.getMarkdown?.() ?? '') as string);
    return raw.endsWith('\n') ? raw : `${raw}\n`;
  } catch {
    return null;
  }
}

/** Extensions and Markdown options shared by every `useRichEditor` surface. */
export function richEditorExtensions({
  extraExtensions = [],
  vaultInlineImages = false,
}: Pick<UseRichEditorOptions, 'extraExtensions' | 'vaultInlineImages'> = {}): AnyExtension[] {
  const imageExtension = vaultInlineImages ? createNoteVaultImageExtension() : InlineImageExtension;
  return [
    StarterKit.configure({ paragraph: false, heading: false }),
    AlignedParagraph,
    AlignedHeading,
    TextAlign.configure({ types: ['paragraph', 'heading'] }),
    WikiLink,
    WikiLinkResolutionExtension,
    imageExtension,
    Markdown,
    ...extraExtensions,
  ];
}

export function useRichEditor({
  content = '',
  extraExtensions = [],
  editable,
  autofocus,
  onUpdate,
  onSelectionUpdate,
  onFocus,
  onBlur,
  editorProps,
  vaultInlineImages = false,
}: UseRichEditorOptions): Editor | null {
  const editor = useEditor({
    extensions: richEditorExtensions({ extraExtensions, vaultInlineImages }),
    content,
    editable,
    autofocus,
    editorProps,
    onUpdate,
    onSelectionUpdate,
    onFocus({ editor }) {
      registerActiveEditor(editor);
      onFocus?.({ editor });
    },
    // Title-bar Edit menu commands blur the editor before their click fires
    // (focus moves to the menu button) — the registry must keep tracking the
    // last-focused editor through that blur, not clear on it (SKY-6059).
    onBlur({ editor }) {
      onBlur?.({ editor });
    },
  });

  // Only clear the registry when this editor instance is actually destroyed,
  // so a stale/unmounted editor can never be dispatched to.
  useEffect(() => {
    if (!editor) return;
    return () => { unregisterActiveEditor(editor); };
  }, [editor]);

  return editor;
}
