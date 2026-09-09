import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
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
 *
 * File-mention round (Home pulse's WHAT'S NEW/ACROSS YOUR RIGS narration,
 * `features/home/pulse-file-mentions.ts`): a link whose href is
 * `rigfile:<bindingId>/<relPath>` (that module's own output) is a mention
 * of a file INSIDE a rig, not an external URL — `rpc.app.openExternal` must
 * never see one of these. `onOpenRigFile` is the optional escape hatch for
 * that one href scheme; every other href keeps the plain external-link
 * behavior below, unchanged.
 */

/** Parses a `rigfile:<bindingId>/<relPath>` href — `null` for anything else, including a malformed one. */
function parseRigFileHref(href: string): { bindingId: string; relPath: string } | null {
  const prefix = 'rigfile:';
  if (!href.startsWith(prefix)) return null;
  const rest = href.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const bindingId = rest.slice(0, slash);
  try {
    return { bindingId, relPath: decodeURIComponent(rest.slice(slash + 1)) };
  } catch {
    return null;
  }
}

/** The rig-name link's own accent + dotted-underline convention (`home/briefing-spine.tsx`'s `RigNameLink`) — a rig-file link reads as the same family, not a plain external link's solid underline. */
const RIG_FILE_LINK_CLASS = 'decoration-dotted underline-offset-2';

/**
 * `rehype-sanitize`'s own default schema only allows `http`/`https`/`irc`/
 * `ircs`/`mailto`/`xmpp` as an `href` protocol — anything else (including
 * `rigfile:`) is silently stripped before `SafeMarkdown`'s `a` component
 * ever sees it. Extending the SAME default schema (not replacing it) with
 * `rigfile` is the minimal fix: every other sanitization rule stays
 * exactly as strict as it already was.
 */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'rigfile'],
  },
};

/**
 * `react-markdown` ALSO runs its own URL allowlist on top of
 * `rehype-sanitize` (`defaultUrlTransform`, checked again at render time —
 * `SANITIZE_SCHEMA` above alone isn't enough), with the same
 * http/https/irc/ircs/mailto/xmpp list and no way to extend it. A
 * `rigfile:` href passes through unchanged; everything else still gets
 * `defaultUrlTransform`'s own scrutiny.
 */
function urlTransform(value: string): string {
  return value.startsWith('rigfile:') ? value : defaultUrlTransform(value);
}

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
export function SafeMarkdown({
  content,
  className,
  onOpenRigFile,
}: {
  content: string;
  className?: string;
  /** Handles a `rigfile:<bindingId>/<relPath>` link — see this file's own header comment. */
  onOpenRigFile?: (bindingId: string, relPath: string) => void;
}) {
  return (
    <div className={cn(MARKDOWN_BODY_CLASS, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}
        urlTransform={urlTransform}
        components={{
          a: ({ href, children }) => {
            const rigFile = href ? parseRigFileHref(href) : null;
            return (
              <a
                href={href}
                className={rigFile ? RIG_FILE_LINK_CLASS : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  if (rigFile) {
                    onOpenRigFile?.(rigFile.bindingId, rigFile.relPath);
                    return;
                  }
                  if (href) void rpc.app.openExternal(href);
                }}
              >
                {children}
              </a>
            );
          },
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
