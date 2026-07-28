import HardBreak from '@tiptap/extension-hard-break';
import { Placeholder } from '@tiptap/extensions/placeholder';
import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Markdown,
  type MarkdownNodeSpec,
  type MarkdownStorage,
} from 'tiptap-markdown';
import { cn } from '@/lib/utils';
import * as React from 'react';
import { useEffect, useMemo, useRef } from 'react';
import type { MentionOptions } from '@tiptap/extension-mention';
import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';
import { PromptMention } from './mention/mention-extension';

type MentionConfigure = Partial<MentionOptions>;

// markdown-it parses two trailing spaces + `\n` as a hard break, so converting
// single newlines (but not paragraph-separating blank lines) keeps a pasted
// multi-line screenplay block in one paragraph instead of shredding each line
// into its own paragraph. Exported for unit testing.
export const toHardBreakMarkdown = (text: string): string =>
  text.replace(/(?<!\n)\n(?!\n)/g, '  \n');

// Decide what to insert for a paste. The script editor must only ever ingest
// markdown — never the arbitrary inline styling (fonts, colours, sizes) that
// rich `text/html` clipboard payloads from Word / Google Docs / web pages
// carry. When HTML is present we ignore it and insert the clipboard's
// plain-text representation parsed as markdown; a plain-text-only paste returns
// null so tiptap-markdown's own `clipboardTextParser` handles it. Exported for
// unit testing.
export const plainTextPasteAsMarkdown = (
  html: string,
  text: string
): string | null => {
  if (!html) return null; // plain text paste — handled as markdown already
  if (!text) return null; // image-only / non-text paste — leave to default
  return toHardBreakMarkdown(text);
};
import { createMentionSuggestion } from './mention/mention-suggestion';
import { tagifyMarkdown } from './mention/tagify';

declare module '@tiptap/core' {
  interface Storage {
    markdown: MarkdownStorage;
  }
}

// Override tiptap-markdown's HardBreak serializer to emit a naked `\n` instead
// of CommonMark's `\\\n`. We run with `breaks: true` on parse, so a plain `\n`
// round-trips losslessly as a hard break — and the LLM enhance request body
// then matches single-newline screenplay input verbatim (no `\\` injected),
// which keeps recorded aimock fixtures matching.
const HardBreakAsNewline = HardBreak.extend({
  addStorage() {
    const spec: MarkdownNodeSpec = {
      serialize(state, node, parent, index) {
        for (let i = index + 1; i < parent.childCount; i++) {
          if (parent.child(i).type !== node.type) {
            state.write('\n');
            return;
          }
        }
      },
    };
    return { markdown: spec };
  },
});

type MarkdownEditorProps = {
  value: string;
  onValueChange: (markdown: string) => void;
  /**
   * Fired when the user focuses the editor. Lets callers distinguish a genuine
   * user edit from the editor's own on-mount normalization emit (TipTap can
   * re-serialize the initial content — e.g. mention tagification — and fire
   * `onValueChange` before the user has touched anything).
   */
  onFocus?: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (event: KeyboardEvent) => boolean | void;
  scrollRef?: React.Ref<HTMLDivElement | null>;
  id?: string;
  name?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'data-testid'?: string;
  /**
   * When provided, enables @-mention autocomplete. Tags found in the incoming
   * markdown (by canonical slug match against the items list) are rendered as
   * coloured pills via the Mention extension. Pass `undefined` (default) on
   * surfaces where mentions don't apply. Enablement is captured at editor
   * init — pass an (empty) array from the first render, not `undefined` that
   * later becomes a list, or the extension never registers.
   */
  mentionItems?: MentionItem[];
};

const containerBaseClasses =
  'flex w-full min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40';

const disabledClasses =
  'cursor-not-allowed bg-input/50 opacity-50 dark:bg-input/80';

const proseClasses =
  'prose prose-sm dark:prose-invert max-w-none w-full flex-1 focus:outline-none [&_p]:my-0 [&_p+p]:mt-2 [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:mt-2 [&_h3]:mb-1 [&_ul]:my-1 [&_ol]:my-1 [&_blockquote]:my-1 [&_pre]:my-1';

const placeholderClasses =
  '[&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:pointer-events-none';

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  value,
  onValueChange,
  onFocus,
  placeholder,
  disabled = false,
  className,
  autoFocus = false,
  onKeyDown,
  scrollRef,
  id,
  name,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  'data-testid': dataTestId,
  mentionItems,
}) => {
  // useEditor captures props at init. Bag the live onKeyDown in a ref so the
  // handler reads the freshest callback without needing to recreate the editor.
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;

  // Same ref pattern as onKeyDown — useEditor captures callbacks at init.
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  // handlePaste is captured at editor init (before `editor` is assigned), so it
  // reads the live instance through this ref to insert markdown at the caret.
  const editorRef = useRef<Editor | null>(null);

  // The suggestion plugin fires on every `@` keystroke; the items it pulls
  // must reflect the parent's latest list (it grows as the user adds cast /
  // elements / locations to the sequence) even though the editor's extensions
  // are captured once at init. A ref synced every render gives us that.
  const mentionItemsRef = useRef<MentionItem[]>(mentionItems ?? []);
  mentionItemsRef.current = mentionItems ?? [];
  const hasMentions = mentionItems !== undefined;

  // Signature changes when the set of available tags changes; drives the
  // "re-pill on items load" effect below.
  const mentionItemsKey = useMemo(
    () => (mentionItems ?? []).map((it) => it.tag).join('|'),
    [mentionItems]
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    autofocus: autoFocus,
    extensions: [
      StarterKit.configure({ hardBreak: false }),
      HardBreakAsNewline,
      Markdown.configure({
        // `html: true` is required for inline mention spans (produced by
        // `tagifyMarkdown`) to survive the markdown-it parse on `setContent`.
        // Tiptap's schema enforces that only nodes registered by the active
        // extensions (StarterKit's block/inline set plus `mention`) survive the
        // parse, so unrelated/raw HTML can't leak in.
        html: hasMentions,
        linkify: true,
        breaks: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? '',
        emptyEditorClass: 'is-editor-empty',
      }),
      // The Mention extension is generically typed for `MentionNodeAttrs`
      // (id, label), but our `section` attr is added via `addAttributes` —
      // structurally present, not visible in the configure() option types.
      // The ProseMirror schema is the actual enforcer at runtime.
      ...(hasMentions
        ? [
            PromptMention.configure({
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              suggestion: createMentionSuggestion(
                () => mentionItemsRef.current
              ) as MentionConfigure['suggestion'],
            }),
          ]
        : []),
    ],
    content: hasMentions
      ? tagifyMarkdown(value, mentionItemsRef.current).content
      : value,
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        ...(name ? { 'data-name': name } : {}),
        class: cn(proseClasses, placeholderClasses),
      },
      handleKeyDown: (_view, event) => onKeyDownRef.current?.(event) === true,
      // Bulk inputs that carry embedded newlines (Playwright .fill, drag-drop
      // of multi-line text, programmatic execCommand('insertText', …)) would
      // otherwise split each line into a separate paragraph and shred
      // screenplay structure. Intercept beforeinput and convert single \n
      // into HardBreak nodes so the line layout survives the round-trip;
      // getMarkdown() then emits each as a single \n (with breaks:true).
      // Enter keypresses arrive as a separate inputType ('insertParagraph')
      // and aren't touched here, so typing a new paragraph still works.
      handleDOMEvents: {
        beforeinput: (view, event) => {
          if (!(event instanceof InputEvent)) return false;
          if (event.inputType !== 'insertText' || !event.data?.includes('\n')) {
            return false;
          }
          const { schema, tr, selection } = view.state;
          const hardBreak = schema.nodes.hardBreak;
          if (!hardBreak) return false;
          event.preventDefault();
          const parts = event.data.split('\n');
          const nodes = parts.flatMap((part, i) => {
            const out = [];
            if (part.length > 0) out.push(schema.text(part));
            if (i < parts.length - 1) out.push(hardBreak.create());
            return out;
          });
          view.dispatch(tr.replaceWith(selection.from, selection.to, nodes));
          return true;
        },
      },
      // Strip styling from rich (text/html) paste: insert only the plain-text
      // representation, parsed as markdown, so the script never accepts fonts,
      // colours, or other inline styling. Plain-text paste falls through to
      // tiptap-markdown's clipboardTextParser (transformPastedText below).
      handlePaste: (_view, event) => {
        const clipboard = event.clipboardData;
        if (!clipboard) return false;
        const markdown = plainTextPasteAsMarkdown(
          clipboard.getData('text/html'),
          clipboard.getData('text/plain')
        );
        if (markdown === null) return false;
        event.preventDefault();
        editorRef.current?.commands.insertContent(markdown);
        return true;
      },
      // Same treatment for actual plain-text paste — markdown-it parses two
      // trailing spaces + \n as a hard break, so the pasted block stays in
      // one paragraph instead of splitting.
      transformPastedText: (text) => toHardBreakMarkdown(text),
    },
    onUpdate: ({ editor: e }) => {
      onValueChange(e.storage.markdown.getMarkdown());
    },
    onFocus: () => onFocusRef.current?.(),
  });
  editorRef.current = editor;

  // Canonical Tiptap external-value sync (mirrors the Vue v-model example in
  // their docs): only setContent if the editor's current markdown differs
  // from the incoming value. When mentions are on, we tagify the value first
  // so bare slugs in the incoming string land as mention nodes.
  //
  // Defer the write to the next shot so a burst of value changes (LLM
  // streaming the script chunk-by-chunk) collapses to one setContent with
  // the latest value. Each setContent is a full markdown re-parse + doc
  // rebuild and freezes the renderer if applied per-chunk at ~30Hz+.
  useEffect(() => {
    if (!editor) return;
    if (editor.storage.markdown.getMarkdown() === value) return;
    const rafId = requestAnimationFrame(() => {
      if (editor.storage.markdown.getMarkdown() === value) return;
      const content = hasMentions
        ? tagifyMarkdown(value, mentionItemsRef.current).content
        : value;
      editor.commands.setContent(content, { emitUpdate: false });
    });
    return () => cancelAnimationFrame(rafId);
  }, [editor, value, hasMentions]);

  // When the items list changes (e.g. characters/elements load async after
  // mount, or the user adds a new one to the sequence), re-tagify the current
  // value so existing bare slugs in the prompt light up as pills. The
  // value-sync effect above won't catch this on its own — the stored value
  // hasn't changed, so its `getMarkdown() === value` guard returns true.
  useEffect(() => {
    if (!editor || !hasMentions) return;
    const { content, matched } = tagifyMarkdown(value, mentionItemsRef.current);
    if (!matched) return;
    const rafId = requestAnimationFrame(() => {
      editor.commands.setContent(content, { emitUpdate: false });
    });
    return () => cancelAnimationFrame(rafId);
    // value intentionally omitted — the sibling effect handles value changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, mentionItemsKey, hasMentions]);

  // editable is captured at init; mirror prop changes through to the editor.
  useEffect(() => {
    if (!editor) return;
    if (editor.isEditable === !disabled) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div
      ref={scrollRef}
      className={cn(
        containerBaseClasses,
        disabled && disabledClasses,
        'overflow-y-auto',
        className
      )}
      aria-invalid={ariaInvalid}
      data-testid={dataTestId}
      data-slot="markdown-editor"
    >
      <EditorContent editor={editor} className="w-full" />
    </div>
  );
};
