import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { markMentions } from './mark-mentions';

/**
 * Minimal safe markdown (bold/italic/code/lists/links) — a deliberately
 * small stand-in for emdash's full `MarkdownRenderer` (which also does
 * katex, mermaid, syntax highlighting): neither comment bodies nor a pulse
 * Ask answer need any of that, and this app doesn't otherwise carry the
 * dependency footprint for it. No `rehype-raw`, so embedded HTML is never
 * interpreted — react-markdown prints it as literal text by default;
 * `rehype-sanitize` is layered on top anyway as defense in depth. Links
 * never navigate the renderer: they're intercepted and handed to
 * `rpc.app.openExternal`.
 *
 * Two exports, one stack: `SafeMarkdown` is the bare renderer, reused as-is
 * by the pulse Ask answer; `CommentMarkdown` layers `markMentions`'
 * @-mention bolding on top for comment bodies specifically — the ONLY
 * difference between the two, so a second markdown dependency never gets
 * added just because a caller doesn't want mention-bolding.
 */

const MARKDOWN_BODY_CLASS = cn(
  'break-words text-sm leading-relaxed text-text-primary',
  '[&_p]:mb-1.5 [&_p:last-child]:mb-0',
  '[&_ul]:mb-1.5 [&_ol]:mb-1.5 [&_li]:leading-relaxed [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-4 [&_ol]:pl-4',
  '[&_strong]:font-semibold',
  '[&_a]:text-accent [&_a]:underline [&_a]:cursor-pointer',
  "[&_code]:font-mono [&_code]:text-[0.9em] [&_code]:bg-bg-2 [&_code]:rounded-control [&_code]:px-1 [&_code]:py-0.5",
  '[&_pre]:bg-bg-2 [&_pre]:rounded-control [&_pre]:p-2 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-2 [&_blockquote]:text-text-secondary'
);

/**
 * The reusable safe-markdown stack itself — react-markdown + remark-gfm +
 * rehype-sanitize (no rehype-raw), links intercepted and handed to
 * `rpc.app.openExternal` rather than navigating the renderer. Pulled out of
 * `CommentMarkdown` (below) so the pulse Ask answer
 * (`home/briefing-spine.tsx`) can reuse the SAME stack without also
 * picking up `markMentions`' comment-specific @-mention bolding, which has
 * no meaning for an LLM-narrated answer.
 */
export function SafeMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn(MARKDOWN_BODY_CLASS, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) void rpc.app.openExternal(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function CommentMarkdown({ content, className }: { content: string; className?: string }) {
  return <SafeMarkdown content={markMentions(content)} className={className} />;
}
