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

/**
 * With an `onOpenPath` handler, links to files are the caller's to resolve
 * (a Room answer's `plan.md`, `/Users/…/plan.md`, `file:///…/plan.md` —
 * see `features/spaces/space-link.ts`): `file:` survives both allowlists,
 * and everything that isn't a web or mail link goes to the handler instead
 * of `openExternal` (which only opens http/https and dropped these).
 */
const FILE_LINK_SANITIZE_SCHEMA = {
  ...SANITIZE_SCHEMA,
  protocols: {
    ...SANITIZE_SCHEMA.protocols,
    href: [...(SANITIZE_SCHEMA.protocols?.href ?? []), 'file'],
  },
};

function fileLinkUrlTransform(value: string): string {
  return /^file:/i.test(value) ? value : urlTransform(value);
}

/** A link the browser side can open: http(s) or mail. Everything else in an agent's answer is a file path. */
function isWebLink(href: string): boolean {
  return /^(https?|mailto):/i.test(href);
}

const MARKDOWN_BODY_CLASS = cn(
  'break-words text-sm leading-relaxed text-text-primary',
  '[&_p]:mb-1.5 [&_p:last-child]:mb-0',
  '[&_ul]:mb-1.5 [&_ol]:mb-1.5 [&_li]:leading-relaxed [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-4 [&_ol]:pl-4',
  '[&_strong]:font-semibold',
  '[&_a]:text-accent [&_a]:underline [&_a]:cursor-pointer',
  "[&_code]:font-mono [&_code]:text-[0.9em] [&_code]:bg-bg-2 [&_code]:rounded-control [&_code]:px-1 [&_code]:py-0.5",
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

/** Tables scroll sideways inside a hairline card instead of overflowing the column. */
const TABLE_WRAPPER_CLASS = 'my-2 max-w-full overflow-x-auto rounded-card border border-border-hairline';
const TABLE_CLASS = 'w-full border-separate border-spacing-0 text-xs leading-snug';

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
  onOpenPath,
}: {
  content: string;
  className?: string;
  /** Handles a `rigfile:<bindingId>/<relPath>` link — see this file's own header comment. */
  onOpenRigFile?: (bindingId: string, relPath: string) => void;
  /** Handles a link to a file (relative, absolute or `file://`), as written — see `FILE_LINK_SANITIZE_SCHEMA`. */
  onOpenPath?: (href: string) => void;
}) {
  return (
    <div className={cn(MARKDOWN_BODY_CLASS, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, onOpenPath ? FILE_LINK_SANITIZE_SCHEMA : SANITIZE_SCHEMA]]}
        urlTransform={onOpenPath ? fileLinkUrlTransform : urlTransform}
        components={{
          table: ({ children }) => (
            <div className={TABLE_WRAPPER_CLASS}>
              <table className={TABLE_CLASS}>{children}</table>
            </div>
          ),
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
                  if (href && onOpenPath && !isWebLink(href)) {
                    if (!href.startsWith('#')) onOpenPath(href);
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
