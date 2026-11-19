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

  let out = '';
  let pendingClose = false;
  for (const para of paras) {
    if (para.empty) {
      pendingClose = true;
      continue;
    }
    if (pendingClose) {
      const atBlank = out === '' || out.endsWith('\n');
      if (!atBlank) out += '\n';
      out += '\n';
      pendingClose = false;
    }
    const lines = para.text.split('\n');
    out += lines.map((line) => escapeMarkdownText(line, true)).join('\n');
    pendingClose = true;
  }
  return out;
}

/**
 * Read the current document as Markdown from a Tiptap editor.
 * Always appends a trailing newline for tooling compatibility
 * (tiptap-markdown v0.9 omits the trailing newline).
 *
 * SKY-9404: callers may hold a ref to a `BlockEditorApi` whose underlying
 * editor was destroyed (scene depth unmounted the editor, then remounted it
 * before the ref was refreshed) — `storage.markdown` is gone post-destroy,
 * same destroyed-but-non-null hazard BlockEditor's own focus effect guards
 * against. Fall back to an empty doc rather than crashing the render.
 */
export function getEditorMarkdown(editor: Editor): string {
  // Destroyed editor: storage.markdown and state are gone (SKY-9404).
  if (editor.isDestroyed) return '\n';
  const plain = serializePlainParagraphs(editor.state.doc);
  // tiptap-markdown attaches storage.markdown at runtime — cast is unavoidable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = plain ?? (((editor.storage as any).markdown?.getMarkdown?.() ?? '') as string);
  return raw.endsWith('\n') ? raw : `${raw}\n`;
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
  const imageExtension = vaultInlineImages ? createNoteVaultImageExtension() : InlineImageExtension;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ paragraph: false, heading: false }),
      AlignedParagraph,
      AlignedHeading,
      TextAlign.configure({ types: ['paragraph', 'heading'] }),
      WikiLink,
      WikiLinkResolutionExtension,
      imageExtension,
      Markdown,
      ...extraExtensions,
    ],
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
