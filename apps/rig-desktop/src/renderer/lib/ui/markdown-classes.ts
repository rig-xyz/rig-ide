import { cn } from '@renderer/lib/utils';

/**
 * The safe-markdown element styles (`comment-markdown.tsx`), on their own so
 * the Room's message bubbles can share them without loading the IPC bridge
 * that module needs.
 */

/** Links in markdown: the accent, underlined. */
export const MARKDOWN_LINK_CLASS = '[&_a]:text-accent [&_a]:underline [&_a]:cursor-pointer';

/** Every other element: paragraphs, lists, code, quotes, headings, tables. */
export const MARKDOWN_ELEMENTS_CLASS = cn(
  '[&_p]:mb-1.5 [&_p:last-child]:mb-0',
  '[&_ul]:mb-1.5 [&_ol]:mb-1.5 [&_li]:leading-relaxed [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-4 [&_ol]:pl-4',
  '[&_strong]:font-semibold',
  '[&_code]:font-mono [&_code]:text-[0.9em] [&_code]:bg-bg-2 [&_code]:rounded-control [&_code]:px-1 [&_code]:py-0.5',
  '[&_pre]:bg-bg-2 [&_pre]:rounded-control [&_pre]:p-2 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-2 [&_blockquote]:text-text-secondary',
  // Agent answers (Room final answer, pulse Ask) carry the rest of GFM too —
  // same element vocabulary as assistant-ui's MarkdownText, in our tokens.
  '[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-base [&_h1]:font-semibold',
  '[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-sm [&_h2]:font-semibold',
  '[&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:font-semibold [&_h4]:mt-2.5 [&_h4]:mb-1 [&_h4]:font-medium',
  '[&>:first-child]:mt-0',
  '[&_li::marker]:text-text-muted [&_li>ul]:mb-0 [&_li>ol]:mb-0',
  '[&_.contains-task-list]:list-none [&_.contains-task-list]:pl-0.5 [&_.task-list-item_input]:mr-1.5 [&_.task-list-item_input]:align-middle [&_.task-list-item_input]:accent-accent',
  '[&_hr]:my-3 [&_hr]:border-border-hairline',
  '[&_th]:bg-bg-1 [&_th]:font-medium [&_th]:text-text-secondary',
  '[&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:align-top [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:text-left [&_td]:align-top',
  '[&_th]:border-b [&_th]:border-r [&_th]:border-border-hairline [&_th:last-child]:border-r-0',
  // Column alignment needs no class: react-markdown emits GFM `align` as an
  // inline text-align style, which beats text-left above.
  '[&_td]:border-b [&_td]:border-r [&_td]:border-border-hairline [&_td:last-child]:border-r-0 [&_tr:last-child>td]:border-b-0'
);

export const MARKDOWN_BODY_CLASS = cn(
  'break-words text-sm leading-relaxed text-text-primary',
  MARKDOWN_LINK_CLASS,
  MARKDOWN_ELEMENTS_CLASS
);

/** Tables scroll sideways inside a hairline card instead of overflowing the column. */
export const TABLE_WRAPPER_CLASS =
  'my-2 max-w-full overflow-x-auto rounded-card border border-border-hairline';
export const TABLE_CLASS = 'w-full border-separate border-spacing-0 text-xs leading-snug';
